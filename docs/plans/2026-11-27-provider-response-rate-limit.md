# Rate-limit reset times from provider response headers

**Status:** proposed — 2026-11-27, scheduled after 2.0.0.

**Verified against:** `main` @ `ffc569e`; Pi 1.6.1 in the repo's
`node_modules` (`pi-ai` `dist/types.d.ts:115`,
`dist/api/mistral-conversations.js:189`,
`dist/utils/provider-retry.js:30-42`; `pi-coding-agent`
`dist/core/sdk.js:230-238,274`; `pi-agent-core` `dist/agent.js:313`); the
owner's router log 2026-09-27 to 2026-11-27 (numbers in
`docs/research/2026-11-27-provider-response-rate-limit.md`). What was NOT
checked: whether Pi passes `onResponse` to the router's group model on the
virtual-model path (step 1 settles it), which reset headers OpenRouter and
Mistral send on a 429 (step 1), and Pi 1.7.0 (its extension and stream
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

## Solution

Wrap `onResponse` per attempt in `tryStream`, read the reset time from the
headers, and feed it into the existing `resetAtMs` path. No new routing
mechanism: cooldown, bounded wait and the `/router` reset message already
consume `resetAtMs`.

1. **Spike: does the callback reach the router's call?** Extend the
   virtual-model spike (`spikes/virtual-models/fake-server.mjs`): the
   always-429 case answers with `retry-after: 7`, and a probe records whether
   the group model's stream options carry `onResponse` and what it receives.
   Run against Pi 1.6.1. The result, plus a passive header observation of
   real OpenRouter and Mistral 429s (debug-level log of the header names and
   values from step 2's wrapper, no request of its own; owner directive: no
   direct model calls), goes to the research note. **Stop condition:** if
   neither provider sends a usable reset header, the plan is closed with
   that result and no behaviour change ships.
2. **Chain-preserving wrapper.** In `tryStream` (and the cache-warm forward,
   `src/stream-proxy.ts:1034`), replace `streamOpts.onResponse` with a
   wrapper that records `{ status, reset headers }` on the attempt and then
   calls Pi's original callback with the same arguments. Pi's
   `after_provider_response` event, and every other extension subscribed to
   it, keeps firing. The wrapper never throws and never awaits anything of
   its own. The record belongs to the attempt returned with the stream, not
   to a module-level "last response".
3. **Header parser** `parseResetHeaders(headers, nowMs)` next to
   `parseResetAtMs` in `src/detection.ts`: `retry-after-ms`, `retry-after`
   (delta seconds or HTTP-date, RFC 9110), `x-ratelimit-reset` (epoch
   seconds or milliseconds, disambiguated by magnitude), and the duration
   forms `x-ratelimit-reset-requests` / `-tokens` (`1m30s`). Header names
   describe the HTTP protocol of a provider, not a model, so this is an
   adapter table (ADR-0025 §2 A). Values in the past or more than 7 days out
   are dropped. Formats step 1 observed but not listed here are added in the
   same step.
4. **Feed `resetAtMs`.** When consumeWithDetection detects a rate limit
   (`src/stream-proxy.ts:613-629`), `resetAtMs` is the header reset of the
   attempt, falling back to the text parse (open decision 1). Everything
   downstream is unchanged: `recordLimit`, the ADR-0017 bounded wait,
   `formatResetMsg`.
5. **Spike gates.** The always-429-with-`retry-after` case becomes part of
   `run-retry-matrix.sh`. The bounded wait changes that case's `route()`
   sequence, so its baseline is re-recorded in the same PR, with the
   deviation explained. Every later host upgrade (AGENTS §10) then catches
   Pi dropping `onResponse` from the stream options.
6. **Docs.** README fallback section (where reset times come from),
   CHANGELOG.

Out of scope, each its own plan if wanted: proactive demotion from
`x-ratelimit-remaining-*` (quota pacing); reacting inside Pi's in-call retry
(aborting on the first 429); the delegation, classifier and probe calls the
router builds without Pi's options (`completeSimple` paths); `claude-bridge`
(an extension provider without a pi-ai HTTP call, so its text parse stays).

## Tests (red first, AGENTS §4)

- Step 2: Pi's original `onResponse` is called once, with the same
  `(response, model)`, for success and for 429. A throwing parser leaves the
  stream intact. Two concurrent attempts on different refs keep their own
  record. Red: today's `tryStream` passes no wrapper, so there is no record.
- Step 3: one case per header format, past/far-future rejection, epoch
  seconds vs milliseconds, absent headers → `undefined`.
- Step 4: a 429 with `retry-after: 30` and a text without a reset triggers
  the bounded wait and retries the same model; a 429 with
  `retry-after: 3600` sets a one-hour cooldown instead of the one-minute
  first backoff. Both red against today's text-only path.
- Step 5: the re-recorded matrix case passes. The old baseline fails it,
  which is the intended deviation.

## Open decisions

1. **Precedence when header and text both carry a reset:** header
   (recommended: structured, set by the provider itself) or text. For
   `claude-bridge` only the text exists, so the choice matters only for HTTP
   providers whose body also names a time.
2. **Timing:** after 2.0.0 (recommended, like the other proposed plans) or
   earlier.
