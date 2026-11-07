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
Run as `pi -p "say hi" --no-extensions -e retry-probe.ts --model spike/auto
--no-session --no-tools` (Pi 1.5.0, `settings.retry` at its defaults: 3 retries,
2000 ms base delay). The probes are in `spikes/virtual-models/` (outside the lint
and format scope, not shipped) so the matrix can be re-run after a host upgrade:
`spikes/virtual-models/run-retry-matrix.sh`, re-verified 2026-11-07 with the same
seven rows.

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
20 green) reads `router.log` and `classifier-decisions.jsonl`, takes the turn's
attempts from the failover walk, classifies EVERY failure the router narrated in
the turn against Pi's own retry rules (the two regexes above, mirrored), and
answers one question per turn: would a virtual model have finished it the same
way, recovered through Pi's retry, or lost it?

Reproduce: `node scripts/virtual-route-shadow.ts --detail
--since=2026-10-28T16:20:00Z --until=2026-11-06T12:00:00Z` — quote BOTH bounds
next to any figure; `router.log` rotates, and the decision log keeps growing, so
an open bound is not reproducible.

**Correction 2026-11-07 (code review of the spike):** the first version of this
report classified only the turn's FIRST failure, so a turn whose first failure
was Pi-retryable but which hit a mid-chain failure Pi would NOT retry (a spent
quota, an empty response) still counted as `recovered`. The corrected script
classifies every failure; the table below is the corrected one. The correction
moves one `standard` turn (mid-chain empty response) from `recovered` to `lost`
and attributes the quota losses to their decisive mid-chain failure. The first
version's figures (100 turns, 74/10/16) were measured with the then-current end
of the log and are superseded.

| group | turns | same | recovered | lost |
|---|---:|---:|---:|---:|
| planning | 14 | 14 | 0 | 0 |
| design | 6 | 6 | 0 | 0 |
| code_complex | 58 | 44 | 0 | 14 |
| standard | 9 | 1 | 6 | 2 |
| simple | 6 | 3 | 3 | 0 |
| **total** | **93** | **68 (73.1 %)** | **9 (9.7 %)** | **16 (17.2 %)** |

Why the 16 are lost:

- **15 × `pi-no-retry` (quota wording).** The turn's decisive mid-chain failure
  is a 429 body `Claude quota exceeded — rate limit (five_hour) — resets
  10:10:00 PM: You've hit your session limit` (14 in `code_complex`, 1 in
  `standard`). Pi refuses to retry that body; the current chain switches to
  `claude-bridge/claude-opus-5-5` and then `mistral/zai-glm-5-3` and finishes
  the turn. Counted per TURN, not per outage: the five-hour quota sat over many
  turns, and a stateful `route()` would have excluded the model after the first
  failure — the lost share of this class is an upper bound.
- **1 × `pi-blind` (empty response).** A `standard` turn whose first failure was
  a retryable 429 but whose chain later hit an empty response; the router
  detected it and moved on, Pi would have seen a normal end.

What the 9 recovered cases are: free-tier 429s (`gemma-4-31b-it:free`,
`openrouter/free`) and the `simple` group's chains, where a retry with a
`route()`-chosen different model finished the turn. The delay is 2–14 s; the
current chain takes a similar amount of time for the same cases.

The 68 `same` turns are untouched: the first choice served them, with or without
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
request, Pi recovers — loses 17 % of this owner's turns today, and the loss sits
in the most-used group (`code_complex` on `claude-bridge`). The losses are not
noise: they are the five-hour quota, which Pi deliberately treats as final, and
one mid-chain empty response Pi cannot see.

The `same` 73 % and the `recovered` 10 % say the opposite thing about the *turn
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

## 5. Step 5, two questions (measured 2026-11-07)

Probes (throwaway, outside the repo, so the lint gate does not see them):
the fake provider from §1; `ext5` registers a virtual model whose `route()`
logs `reason` and the incoming `state` and returns `{ turns }`, plus a direct
request started from `agent_end` via `ctx.modelRegistry.streamSimple(virtualModel, …)`;
`ext6` adds a group-like provider `grp/code` whose `streamSimple` forwards every
event of an inner request to `spike/spike-c` into its own proxy stream, and
routes a virtual model there. Runs with `pi -p … --session-dir … --session-id`
and `--fork`/`--session`.

### (a) Is the state separated? Yes, for the four cases measured

| case | what `route()` received | result |
|---|---|---|
| direct request after turn 1, same process | `reason: direct`, `state: null` | the state it returned (`turns: 999`) was discarded; the next user turn read `turns: 1` |
| fork at a tip with `turns: 2`, two user turns in the fork | `state: {turns: 2}` | the fork continued at 3 and 4 |
| resume the original after the fork | `state: {turns: 2}` | 3 — the fork's 4 is not visible |
| fresh, independent session | `state: null` | 1 |

Storage: a `custom` entry `pi.virtual-model-state` (`{provider, modelId, state}`)
on the session branch, appended after each state change. Direct requests write
neither an entry nor an assistant message.

Not measured: compaction and `/tree` navigation. Both need an interactive
session; the docs claim that state survives both, and this is unverified.

What (a) does not show: that the migration is cheaper than a session-keyed map
in the router. Pi isolates the state correctly. Whether that beats the fix the
router would need (state keyed by session id) is the cost comparison still open.

### (b) Attribution in the assistant message and `/session`

- Two layers (`spike/vtwo` → `grp/code` → `spike/spike-c`): the assistant
  message records `spike/spike-c` and `api: openai-completions`. `grp/code`
  appears nowhere in the transcript. `model_change` records only the virtual
  model.
- Today, in a real router session file (`~/.pi/agent/sessions/…`, 2026-10-06):
  assistant messages name the physical model (`mistral/zai-glm-5-3`: 3715
  messages, `claude-bridge/claude-sonnet-5-5`: 1451, …); `model_change` records
  `dynamic`. The attribution the router already has is therefore "physical
  model in the message", and the two-layer variant keeps it.
- Synthetic error messages carry the stamp of the outer model (`dynamic` today,
  `grp/code` in the two-layer variant). A failed attempt is attributed to the
  group, a real answer to the physical model.
- **`previous` names the physical model** (`spike/spike-c` after the first turn,
  not `grp/code`). A `route()` that derived the group from `previous` would skip
  the group provider, and its failover, on every continuation. The group must
  come from `state`. This is a constraint on the design, not a blocker.
- Not measured: the footer (interactive) and the `/session` aggregation. The
  probe's cost is zero, so no cost figure has been checked.

### Consequences for the decision (plan step 5)

- The hybrid option is still the only one the measurements support: the
  failover stays in `driveStream`, the turn state moves to `route()` + `state`.
- Two-layer costs: an extra `route()` hop, one more provider to register, the
  continuation constraint above. It does not cost per-model attribution.
- Still open: compaction, `/tree`, the footer, a tool follow-up (`continuation`
  with tool results, not run here), and `previous` after a model left the
  catalog.

## 6. Cost comparison: session-keyed state vs. the virtual-model state (measured 2026-11-07)

Question from the owner: do the turn-state bugs need the migration, or does the
same state keyed by session in today's design fix them at lower cost? What is
**measured** below is feasibility and size (probe runs, grep counts). What is an
**estimate** is marked as such; nothing was implemented.

### Feasibility facts (probe `ext7`, same fake provider as §1)

| fact | result |
|---|---|
| Session id in the group provider's `streamSimple` | `options.sessionId` is set by Pi (`sdk.js` passes `sessionManager.getSessionId()`), **also when the group provider is selected directly, as today**. The router reads it nowhere. |
| Session id in `route()` | `ctx.sessionManager.getSessionId()`, equal to the `options.sessionId` of the following group request (`S7` = `S7`) |
| `ModelRouteRequest` fields | `reason, thinkingLevel, signal, state, model, previous, failed, messages` — no session id, no tool-result flag beyond `reason` |
| Extension factory calls | one per pi process in these runs; whether in-process subagent sessions (`createAgentSession`, used by pi-subagents) call the factory again is **not measured** — I2's "shared between subagent sessions" is taken from the review |

So a session-keyed turn state is possible today without any Pi change: the key
is already in every `streamSimple` call and in every event handler's context.

### Size of the two changes

Today's design, session-keyed store (counted, `index.ts` + `src/`, comments excluded):

| state | references | files |
|---|---:|---:|
| `curModel` | 25 | 5 |
| `activeGroup` | 30 | 6 |
| `lastDynamicModel` | 23 | 3 |
| `lastClassifiedCategory` | 9 | 2 |
| `turnStart` | 20 | 3 |
| `escalation` | 22 | 5 |
| `skipReasons` | 13 | 3 |
| `previousMessageCount/TokenCount` | 21 | 2 |
| `Router` turn fields (`setCurModel`, `turnDriver*`, …) | 21 | 5 |
| **all, 15 distinct files** | ~184 | 15 |

The three that carry I2/I3/I5 are `curModel`, `lastDynamicModel`,
`lastClassifiedCategory`: 57 code references; 8 files mention them by name
(comments included). Tests touching these names:
16 files.

Virtual-model migration (hybrid, failover stays):

- `groupStream` is ~445 lines (classification, HINT group/model, escalation,
  tool-follow-up, candidate building) and calls `driveStream` (~870 lines, stays)
  from at least four places with its decision as arguments. Classification is an
  LLM call and needs the whole message list, so it has to run in `route()`
  (async is allowed). The group provider's `streamSimple` then needs that
  decision — group, candidate order, HINT pin, tool-follow-up flag — and
  `route()` can only hand it over through `state` (read in `route()`, not
  readable in `streamSimple`) or **a short-lived map keyed by session id**, which
  the §6 facts show is possible. The migration therefore contains a session-keyed
  map too, only with a one-request lifetime.
- 35 test files call `groupStream` (36 reference it or `StreamOrchestrator`;
  297 `it`/`test` cases in them, a lower bound since `it.each` counts once). The
  orchestrator tests construct the orchestrator context directly; they would be
  rewritten, not adjusted.
- Two registrations (virtual model plus group providers), and the API that the
  0.99.0 changelog called experimental.

### Bug by bug

| item | session-keyed store | virtual model | difference |
|---|---|---|---|
| I2 remainder (state shared by subagent sessions) | key by session id | `state` per branch | equal; virtual also persists across restart/fork |
| I3 (follow-up falls into `simple`) | store the run's driver and group at classification | `continuation` + group from `state` | **same logic in `driveStream`'s follow-up order in both**; only the "is this a follow-up" signal differs (`reason` vs. `isToolFollowUp`) |
| I5 (compaction continuity trusts any large model) | decide by real window, exclude `:free` | same rule in `route()` | **a rule fix, not a state fix — identical in both** |
| Category memory on a pin | fixed (PR #115) | fixed | none |
| Sub-call overwrites turn state | fixed (async scope) | structural (`direct`) | already fixed today |
| Turn state lost on router reload / restart | lost unless persisted | survives (custom entry on the branch) | **real advantage of the migration** |
| Fork / `/tree` semantics | none (a fork is a new session, empty state) | state follows the branch | **real advantage of the migration** |

### Reading

- Of the open items, the migration changes the **state's location and lifetime**,
  not the logic: I3 and I5 need the same rule changes either way.
- Its real extras are persistence across restart and branch-correct state. Neither
  is a reported bug today; the category memory after a restart is a nicety.
- The cheaper path for I2 is the session-keyed store: ~57 references (8 files) for the three
  state variables that matter, no change to the stream path, no rewrite of the
  orchestrator tests beyond the state seam. It is an **estimate** that this
  is cheaper; the counts are measured, the effort is not.
- Neither path fixes anything about the failover gaps of §1–§3; both keep
  `driveStream`.
- Not decidable from measurements: whether branch-correct, persistent turn state
  is worth a ~445-line split and a test rewrite. That is a product decision.

The probe is `spikes/virtual-models/session-id-probe.ts`; run logs are not
committed.
