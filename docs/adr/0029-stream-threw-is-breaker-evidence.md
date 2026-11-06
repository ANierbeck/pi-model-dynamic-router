# ADR-0029: A stream that throws is provider-breaker evidence when its text says so

## Status

Accepted (2026-11-06, owner decision). Extends
[ADR-0026](0026-provider-circuit-breaker.md); changes future behaviour only.

## Context

ADR-0026 D1 lists the evidence kinds the provider breaker counts:
`empty_response`, `empty_timeout`, `stall_timeout`, and `provider_error` with
connection/5xx-shaped text. That list was written on 2026-10-07.

On 2026-10-26 the stream proxy gained a fifth failure reason,
`stream_threw` (commit `b5780e1`, pi 1.4.0 alignment): the upstream stream
threw while being consumed, or forwarding an event into the proxy threw, and
no terminal event arrived. The reason carries the thrown message as `detail`.

The breaker seam (`observeProviderFailure` in `index.ts`) only passes the four
ADR-0026 kinds, so `stream_threw` was silently dropped. The result: a provider
whose connections die mid-stream (`read ECONNRESET`, `fetch failed`) never
opened its breaker, and every candidate of that provider was still tried on
every request. This was found on 2026-11-06 while writing a mutation-test
fixture (three throws from one provider did not open the breaker). It is a gap
that appeared when a new failure reason was added, not a decision: no earlier
document excludes thrown streams.

## Decision

- **A `stream_threw` failure is reported to the breaker as a `provider_error`**
  with the thrown message as detail.
- **The existing D1 text filter decides.** `countsAsProviderEvidence` counts
  only connection/5xx-shaped text. A throw with any other message (a JSON
  parse error, `malformed text_delta event`, a shape error) does not count, so
  one model's bad output cannot trip a whole provider. No second taxonomy.
- Trip rule, window, ladder, probe and narration are unchanged (ADR-0026
  D2–D7). The breaker narration reads "failed" for mixed or provider-error
  evidence.

## Alternatives considered

- **Count every `stream_threw` as evidence.** Rejected: the throw also covers
  forwarding failures and malformed events, which are per-model or local bugs,
  not a wedged provider. The text filter is the established guard.
- **A new evidence kind `stream_threw`.** Rejected: it would need its own
  narration and filter for the same two outcomes the existing kind already has.
- **Leave it out.** Rejected: the connection-reset case is exactly the wedge
  signature ADR-0026 was written for (the log evidence lists
  `Connection error.` lines), only observed one layer later.

## Consequences

- Mid-stream connection resets now open the breaker after three distinct cloud
  models (two local), like empty responses do; the rest of the provider is
  skipped for the cooldown ladder's duration.
- Tests: `test/drive-stream-thrown-streams.test.ts` (three connection-shaped
  throws open the breaker and the fourth candidate is skipped; non-transport
  throws do not).
