# Rate-limit reset times from provider response headers

**Status:** proposed — 2026-11-27, scheduled after 2.0.0.

**Verified against:** `main` @ `ffc569e`; Pi 1.6.1 in the repo's
`node_modules` (`pi-ai` `dist/types.d.ts:115`,
`dist/api/mistral-conversations.js:189`,
`dist/api/openai-completions.js:197-205`,
`dist/utils/provider-retry.js:30-42`; `pi-coding-agent`
`dist/core/sdk.js:230-238,274`; `pi-agent-core` `dist/agent.js:313`); router
anchors `src/stream-proxy.ts:337,613-629`,
`src/stream-orchestrator.ts:1320,1339-1364,1382-1410,1416,1750,1876`,
`src/rate-limit.ts:98-130`; the owner's router log 2026-09-27 to 2026-11-27
(numbers in `docs/research/2026-11-27-provider-response-rate-limit.md`). What
was NOT checked: whether Pi passes `onResponse` to the router's group model
on the virtual-model path (step 1 settles it), which reset headers OpenRouter
and Mistral send on a 429 (step 1), and Pi 1.7.0 (its extension and stream
option types are unchanged against 1.6.1, but nothing was run on it).

Builds on ADR-0017 (bounded wait for a known near reset,
`docs/plans/2026-09-27-wait-for-short-reset-plan.md`).

## Problem

The router learns a rate limit's reset time only from the error **text**:
`parseResetAtMs` (`src/detection.ts:282`), called at
`src/stream-proxy.ts:620`. The parser covers the `claude-bridge` quota text,
which carries a wall-clock reset. HTTP providers put the reset time in the
**headers** (`retry-after`, `retry-after-ms`, `x-ratelimit-reset*`), and
those never reach the router.

Without a reset time, two existing mechanisms fall back to guessing:

1. **Cooldown length.** `RateLimitManager.recordLimit`
   (`src/rate-limit.ts:98-125`) takes the longer of the escalating
   `backoff_minutes` step and the known reset. Without a reset it is the
   bare schedule (1 minute on the first hit): a limit that lasts an hour is
   re-picked, fails again and escalates hit by hit until the schedule
   catches up. A known reset only ever lengthens the cooldown; short resets
   are the bounded wait's job (2).
2. **Bounded wait (ADR-0017).** driveStream waits on the same model only
   when `resetAtMs` is known and near (`src/stream-orchestrator.ts:1382-1410`,
   `rate_limit_wait_max_ms`). Without it the request cascades to the next
   candidate, which is possibly paid, although the limited model would be
   free again in seconds.

Evidence: in two months of router log, none of the 217 OpenRouter 429s
carried a reset time in the text. Each of them got a guessed cooldown, and
none could use the bounded wait. Pi's own in-call retry reads `retry-after`,
but caps it at 60 s and then fails the call. The router never sees the
value, so the longest delays, the ones a cooldown most needs, are exactly
the ones it loses.

Pi 1.6.1 exposes the headers in two places. The extension event
`after_provider_response` carries `status` and `headers` but no provider or
model, so it cannot be attributed to a candidate while delegation and
classifier sub-calls run concurrently. The stream option
`onResponse(response, model)` receives the physical model, and the router
already builds the options of every physical call in `tryStream`
(`src/stream-proxy.ts:291-306`).

Two gaps in today's code decide how the fix has to be wired, because a
captured header would otherwise go unused:

- Rate-limit detection is text-only: `consumeWithDetection` enters its
  rate-limit branch only when `isRateLimitText(errorMsg)` matches
  (`src/stream-proxy.ts:613`). A 429 whose body does not match never reaches
  the cooldown path, header or not.
- Nothing connects an attempt to its response: `tryStream` returns
  `{ stream, ref }`, and the four `consumeWithDetection` call sites
  (`src/stream-orchestrator.ts:1320`, `:1416` the bounded-wait retry, `:1750`,
  `:1876`) pass only the stream.

## Solution

Wrap `onResponse` per attempt in `tryStream`, read the reset time from the
headers, thread it to detection, and feed it into the existing `resetAtMs`
path. No new routing mechanism: cooldown, bounded wait and the `/router`
reset message already consume `resetAtMs`.

1. **Spike: does the callback reach the router's call?** Extend the
   virtual-model shape spike (`spikes/virtual-models/fake-server.mjs`,
   `router-shape-run.ts`, whose `failing429` group already drives a 429
   through the real router in Pi): the 429 answers with `retry-after: 7`, and
   a probe records whether the physical attempt's stream options carry
   `onResponse` and what it receives. Run against Pi 1.6.1. The result, plus
   a passive observation of real OpenRouter and Mistral 429s (the attempt
   records of step 2 written to the debug log, no request of its own; owner
   directive: no direct model calls), goes to the research note. The
   observation logs only the allow-listed reset headers of step 3, never the
   full header set: a response can carry `set-cookie` or other credentials,
   and the router log persists. **Stop condition:** if neither provider sends
   a usable reset header, the plan is closed with that result and no
   behaviour change ships.
2. **Chain-preserving wrapper with an attempt record.** In `tryStream` (and
   the cache-warm forward, `src/stream-proxy.ts:1034`), replace
   `streamOpts.onResponse` with a wrapper that calls Pi's original callback
   first, unchanged and with the unfiltered response (Pi's
   `after_provider_response` and every other subscriber keep firing), and
   then stores `{ status, headers }` on the attempt, where `headers` keeps
   only the allow-listed reset headers of step 3. The callback fires once per
   HTTP response, so a Pi in-call retry produces several calls for one
   logical stream (`openai-completions.js:203`); the record holds the latest
   one, the response that decided the attempt's outcome. The wrapper never
   throws and never awaits anything of its own. The record belongs to the
   attempt, not to a module-level "last response".
3. **Header parser** `parseResetHeaders(headers, nowMs)` next to
   `parseResetAtMs` in `src/detection.ts`. Allow list: `retry-after-ms`,
   `retry-after` (delta seconds or HTTP-date, RFC 9110), `x-ratelimit-reset`
   (epoch seconds or milliseconds, disambiguated by magnitude), and the
   duration forms `x-ratelimit-reset-requests` / `-tokens` (`1m30s`). Header
   names describe the HTTP protocol of a provider, not a model, so this is an
   adapter table (ADR-0025 §2 A). Values in the past or more than 7 days out
   are dropped. Formats step 1 observed but not listed here are added in the
   same step. **Which reset wins when several are present:** the request and
   token windows are different quotas, so the earlier one must not decide.
   (a) `retry-after*` is the provider's own statement for this response and
   wins. (b) Otherwise, when `x-ratelimit-remaining-requests` /
   `-tokens` identify the exhausted quota (value 0), the latest reset among
   the exhausted quotas wins. (c) Otherwise the latest of all reset headers
   wins: a cooldown that is too long costs availability for a while, one that
   is too short costs a wasted attempt and an escalated backoff. Step 1
   records which of these cases occur on the two providers; cases that never
   occur are dropped from the parser before it ships.
4. **Thread the record to detection and feed `resetAtMs`.** `tryStream`
   returns the attempt record next to `{ stream, ref }`, and
   `consumeWithDetection` takes it as a parameter at all four call sites,
   including the bounded-wait retry (`:1416`). Inside, an attempt whose
   latest response has status 429 and which ends in an error counts as a
   rate limit **even when the text does not match** `isRateLimitText`. Its
   `resetAtMs` is the header reset, falling back to the text parse (open
   decision 1). Free-tier daily cap (`:1339-1364`): the cooldown is the later
   of the header reset and `nextUtcMidnightMs()`, never shorter than the
   inferred midnight, so a per-minute header on a daily-cap 429 cannot cut
   the cooldown short and re-burn the cap.
5. **Cooldown keeps the later expiry.** `recordLimit` replaces the ref's
   entry with each failure's own reset (`src/rate-limit.ts:124-130`). With
   concurrent attempts on one model, a slow 429 with a shorter reset can
   overwrite a longer one recorded just before, and the router re-picks the
   model while the provider still limits it. `recordLimit` keeps
   `max(existing cooldown_until, new cooldown_until)` for the ref; hits and
   backoff step behave as before. This holds for every reset source, not
   only headers.
6. **Gates that cover the router's own path.** `run-retry-matrix.sh` drives
   Pi's standalone `spike/auto` model, never the router's `tryStream` or
   bounded wait, so it can neither verify this change nor catch the router
   losing `onResponse`; it stays untouched. Two gates replace it:
   (a) a driveStream test in the style of `test/rate-limit-wait.test.ts`
   (CI, every run): a fake host stream calls the attempt's `onResponse` with
   a 429 and `retry-after: 1`, and the test asserts the bounded wait and the
   retry on the **same** model, not the next candidate;
   (b) the shape spike's `failing429` check (real Pi, fake provider, every
   host upgrade under AGENTS §10): the fake provider's 429 carries
   `retry-after`, and the check asserts that the router retried the same
   model instead of cascading. The recorded baseline in
   `shape-verdict.ts` is extended with it, so a future Pi that stops handing
   `onResponse` to the router fails the gate.
7. **Docs.** README fallback section (where reset times come from), CHANGELOG.

Out of scope, each its own plan if wanted: proactive demotion from
`x-ratelimit-remaining-*` (quota pacing); reacting inside Pi's in-call retry
(aborting on the first 429); the delegation, classifier and probe calls the
router builds without Pi's options (`completeSimple` paths); `claude-bridge`
(an extension provider without a pi-ai HTTP call, so its text parse stays).

## Tests (red first, AGENTS §4)

- Step 2: Pi's original `onResponse` is called with the same
  `(response, model)` and the **unfiltered** headers, once per HTTP response:
  a 429 retried by Pi's in-call retry calls it for each attempt, and the
  attempt record ends up holding the latest response. A throwing parser
  leaves the stream intact. Two concurrent attempts on different refs keep
  their own record. The record never contains a header outside the allow
  list (`set-cookie` and `authorization` in, absent out). Red: today's
  `tryStream` passes no wrapper, so there is no record.
- Step 3: one case per header format, past/far-future rejection, epoch
  seconds vs milliseconds, absent headers → `undefined`. Precedence: request
  and token resets that differ pick `retry-after` first, then the exhausted
  quota's, then the latest.
- Step 4: a 429 with `retry-after: 30` and a text that does not match
  `isRateLimitText` is still a rate limit and triggers the bounded wait and a
  same-model retry; a 429 with `retry-after: 3600` sets a one-hour cooldown
  instead of the one-minute first backoff; a free-tier daily-cap 429 with a
  60-second header keeps the midnight cooldown, one with a header later than
  midnight takes the header. The record reaches `consumeWithDetection` at
  all four call sites (the bounded-wait retry included). Each red against
  today's text-only path.
- Step 5: two failures for one ref, the longer reset recorded first, keep
  the longer expiry in both orders. Red against today's replacing write.
- Step 6: gate (a) is red on today's code (no record, so no wait); gate (b)
  fails on a host stub that drops `onResponse`.

## Open decisions

1. **Precedence when header and text both carry a reset:** header
   (recommended: structured, set by the provider itself) or text. For
   `claude-bridge` only the text exists, so the choice matters only for HTTP
   providers whose body also names a time.
2. **Conflict rule of step 3** (`retry-after` first, then exhausted quota,
   then latest): confirm, or ask for the simplest rule (latest only) if step
   1 shows that only one header family occurs.
3. **Timing:** after 2.0.0 (recommended, like the other proposed plans) or
   earlier.
