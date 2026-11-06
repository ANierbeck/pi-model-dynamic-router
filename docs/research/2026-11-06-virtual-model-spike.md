# Virtual-model spike: Pi's retry behaviour and shadow agreement

**Date:** 2026-11-06
**Plan:** `docs/plans/2026-11-04-virtual-models-routing.md` (spike steps 1–3)
**Supersedes nothing.** The API reading stays in `docs/research/2026-11-04-virtual-models-fit.md`;
this note adds measurements.

Three questions, three sections: what Pi actually does with a failing request
(§1, measured against a local fake provider), how often a virtual model would
have finished the same turn the current chain finished (§2, measured on the real
router logs), and which router behaviours a migration would have to replace
(§3, inventory). §4 is the reading, §5 what stays open.

Nothing here is a decision. The plan's step 4 (migrate / hybrid / stay) is the
owner's.

## 1. What Pi does with a failing request (measured)

Setup: a local OpenAI-compatible fake provider (`127.0.0.1:8791`) that fails in
one chosen way, plus a throwaway extension registering a virtual model whose
`route()` logs `reason`, `previous`, `failed`, `state` and the model it picks.
Run as `pi -p "say hi" --no-extensions -e ext.ts --model spike/auto --no-session
--no-tools` (Pi 1.5.0, `settings.retry` at its defaults: 3 retries, 2000 ms base
delay). The probe is not part of the repo; it is reproducible from this
description in about twenty lines per case.

| provider behaviour | `route()` calls | what the user saw |
|---|---|---|
| plain 429 (`rate limit exceeded`) | 2: `user`, then `retry` after 2009 ms | the retry's answer |
| stream ends with `[DONE]` but no `finish_reason` | 2: `retry` after 2000 ms | the retry's answer |
| **well-formed stream, `finish_reason: stop`, no content** | **1** | **an empty answer, no error** |
| **stall: headers sent, keep-alive comments, never finishes** | **1** | **nothing; Pi hung >180 s** |
| always 429 | 4: `user` + 3 `retry` (2 s, 4 s, 8 s) | the raw error text as the answer |
| 429 body `Claude quota exceeded — rate limit (five_hour) …` | **1** | the raw error text as the answer |
| 429 body `You've hit your session limit. It resets in 3 hours.` | 2: `retry` after 2058 ms | the retry's answer |

What this establishes:

- **`failed` is usable.** On a retry it carries the physical model, the thinking
  level and the assistant message with `stopReason: "error"` and the full
  `errorMessage` (`429: {"message":"rate limit exceeded",…}`). `previous` is
  `null` when nothing succeeded yet, and the last successful physical model
  afterwards.
- **The retry budget is 4 attempts, not 4 models.** Delays are 2 s, 4 s, 8 s —
  14 s of waiting before the turn fails. A chain that needs five candidates
  cannot be reproduced.
- **The decision is made on the body wording, not on the reset time.** Pi's
  `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN` contains `quota exceeded`,
  `available balance`, `insufficient_quota`, `billing`, `Monthly usage limit
  reached`. A 429 that says `Claude quota exceeded` is therefore final for Pi,
  while the same 429 saying only `You've hit your session limit. It resets in 3
  hours.` is retried. The reset instant plays no part in the decision.
- **Pi has no stall detection.** A stream that opens and then goes quiet is not
  timed out, not retried, not reported; the process waits. There is no
  stall/idle-timeout code in `pi-ai` or `pi-coding-agent` (grep for
  `stall`/`idleTimeout` finds only unrelated matches).
- **A well-formed empty response is invisible.** `stopReason` is `stop`, there
  is no `errorMessage`, so `isRetryableAssistantError()` returns false and the
  turn ends with an empty answer. This is exactly the claude-bridge incident the
  router narrates as `empty response (no content, no error reported)`.
- **`state` is stored even when the request fails**, and it survives a process
  restart in the same session: the next turn's `route()` saw
  `previous: "spike-c"` and the stored state from the previous process. That
  matches the documented per-branch behaviour.
- **Context overflow did not compact.** A 400 with the OpenRouter
  `maximum context length is 2000 tokens` body, sent to a model declared with a
  2000-token window, produced one request and then an empty turn with no error
  text, both with `--no-session` and with a session directory, and both on the
  first turn and on a second turn of the same session. Whether Pi's compaction
  would have run in an interactive session is unresolved (§5).

## 2. Shadow agreement on real traffic (measured)

`scripts/virtual-route-shadow.ts` (tests `test/virtual-route-shadow.test.ts`,
16 green) reads `router.log` and `classifier-decisions.jsonl`, takes the turn's
first attempt from the failover walk, classifies the failure the router narrated
for it against Pi's own retry rules (the two regexes above, mirrored), and
answers one question per turn: would a virtual model have finished it the same
way, recovered through Pi's retry, or lost it?

Reproduce: `node scripts/virtual-route-shadow.ts --detail=1 --since=2026-10-28T16:20:00Z`
(the start of the five-group layout).

| group | turns | same | recovered | lost |
|---|---:|---:|---:|---:|
| planning | 14 | 14 | 0 | 0 |
| design | 6 | 6 | 0 | 0 |
| code_complex | 64 | 50 | 0 | 14 |
| standard | 9 | 1 | 6 | 2 |
| simple | 7 | 3 | 4 | 0 |
| **total** | **100** | **74 (74 %)** | **10 (10 %)** | **16 (16 %)** |

Why the 16 are lost:

- **14 × `pi-no-retry`.** First attempt `claude-bridge/claude-sonnet-5-5` (once
  `claude-opus-5-5`), 429 body `Claude quota exceeded — rate limit (five_hour) —
  resets 10:10:00 PM: You've hit your session limit`. Pi refuses to retry that
  body; the current chain switches to `claude-bridge/claude-opus-5-5` and then
  `mistral/zai-glm-5-3` and finishes the turn.
- **2 × retry budget.** First attempt `openrouter/google/gemma-4-31b-it:free`,
  429, and the chain needed eight attempts to find a model that served. Pi allows
  four.

What the 10 recovered cases are: free-tier 429s (`gemma-4-31b-it:free`,
`openrouter/free`) and the `simple` group's chains, where a retry with a
`route()`-chosen different model finished the turn. The delay is 2–14 s; the
current chain takes a similar amount of time for the same cases.

The 74 `same` turns are untouched: the first choice served them, with or without
a virtual model.

## 3. Inventory: what a migration must replace (step 1)

Classified against the probe results and the code, for every in-request behaviour
of `driveStream`:

| router behaviour | with a virtual model |
|---|---|
| failover on 429 / 5xx / transport errors | **between requests** — Pi retry + `route()` switch on `failed`, max 4 attempts, 2/4/8 s |
| bounded wait-for-reset, cooldown ladder | **between requests** — the state can steer the next `route()`; the wait inside the request is gone |
| provider circuit breaker (ADR-0026), learned blocklist (ADR-0008) | **between requests** — `message_end`/`after_provider_response` feed the state |
| stall timeout | **lost** — Pi has no stall detection |
| empty response (no content, no error) | **lost** — Pi sees a normal end |
| repetition-loop detection | **lost** — `route()` never sees stream content |
| output truncated at max tokens | **lost** — a `length` stop is not retried |
| non-retryable provider errors (422, quota wording) as a failover trigger | **lost** — Pi ends the turn on the first such error |
| `[router] X — …, trying Y` narration | **lost** — Pi has its own retry indicator and `auto_retry_*` events |
| HINT parser, Laya classifier, ranking, group resolution, cost rules | unchanged — `route()` calls the same code |
| local slots, availability probes | unchanged — `route()` can check them before choosing |
| escalation level, category memory, turn driver | `state`, per session branch — strictly better than today's module variables |
| sub-call isolation (delegation, `bulk_read`) | solved structurally — those calls are `direct` and have no state |
| compaction continuity (I5) | Pi compacts by the routed model's window; the summary call is `direct`. Not verified end to end (§5) |

## 4. Reading

The pure shape the plan proposes — a virtual model chooses one physical model per
request, Pi recovers — loses 16 % of this owner's turns today, and the loss sits
in the most-used group (`code_complex` on `claude-bridge`). The losses are not
noise: they are the five-hour quota, which Pi deliberately treats as final, and
one chain that needed more than four candidates.

The `same` 74 % and the `recovered` 10 % say the opposite thing about the *turn
state*: nothing in the virtual-model contract is worse than today's module
variables, and the parts that keep producing bugs (sub-call scope, I2 per-session
state, I5 compaction continuity, pinned category memory) are exactly what
`route()` + `state` + `reason` solves structurally.

So the honest split is:

- **Keep** the in-request failover: stall, empty response, repetition, truncation
  and non-retryable provider errors have no Pi equivalent, and they are 16 % of
  real turns.
- **Migrate** the turn state to `route()` + `state`: that is where the bugs come
  from, and the API covers it without the failover.

That is the plan's "hybrid" option, and it is much smaller than "full
migration": the `driveStream` walk stays, the module-level turn state goes.

## 5. Open

- **Compaction on overflow** did not reproduce in `-p` mode (§1). Needs a check
  in an interactive session before I5 can be called solved by the migration.
- **`previous` after a catalog change**: whether it survives a model that left
  the catalog is untested.
- **The two budget cases**: whether a `route()` that remembers failures per
  model would have avoided the eight-candidate chain is unmeasured. A
  per-branch failure count in `state` is the obvious candidate.
- **API stability**: the 0.99.0 changelog called virtual models experimental; the
  1.5.0 docs no longer say so, but nothing promises stability either.
- **The classification is only as good as the narration.** Where the router
  logged the raw 429 body, the body was used; elsewhere the narration stands in
  for what Pi would have seen. The 14 `quota exceeded` cases were checked
  line by line against the logged body.
