# ADR-0026: One provider circuit breaker for local and cloud providers

## Status

Accepted (implemented 2026-10-07, Phases 1–4 of
[`docs/plans/2026-10-06-provider-circuit-breaker.md`](../plans/2026-10-06-provider-circuit-breaker.md)).
Generalizes and partially supersedes
[ADR-0016](0016-local-provider-watchdog.md); complements
[ADR-0013](0013-failure-classification-and-failover.md) (per-model transient
handling) and [ADR-0008](0008-learned-model-blocklist.md) (per-model
permanent failures).

## Context

Every failure-handling mechanism the router had was **per model**: soft
backoff, health demotion, the Tier-2 blocklist. The only provider-scoped
mechanism, the local watchdog of ADR-0016, covered local providers and
only counted generation *timeouts*.

When a cloud provider or extension wedges as a whole, several **different**
models of it fail the same way in a short window with no success in between —
and nothing in the router said "this provider is broken". Each candidate
burned its own hop (its own timeout, for stalls) before the cascade moved on,
and the next request did it again. The verified log evidence (2026-10-06,
`~/.pi/logs/router.log`):

- 235 `claude-bridge` empty responses spread over 6 days; up to **6 distinct
  models of one provider failing within 60 s** (2026-10-04 08:31); a
  4-models-in-16-ms cascade (2026-10-06 08:03).
- 172 `ollama` `Connection error.` lines — **not** counted by the watchdog,
  which only recorded `empty_timeout`/`stall_timeout`.
- 263 `mistral` `provider error` lines — mostly **per-model request/shape
  errors** (400 "reasoning prompt mode", 422 "store"), which must NOT count
  as a wedge: a structural client error on every model is not a provider
  outage.

## Decision Drivers

- Detect a provider-level wedge from *observed* failures, without a live
  probe of anything.
- Never mistake one flaky model, a rate limit, or a per-model shape error for
  a wedge.
- Never leave the user without an answer because a breaker is open (the
  ADR-0013 driver).
- Provider-agnostic ([ADR-0025](0025-no-hardcoded-models.md) class A):
  no provider or model names in the mechanism; locality comes from
  `PROVIDER_MAP`.
- Visible: one narration when a breaker opens, `/router` status, a clear
  command.

## Options Considered

- **A separate cloud-only breaker next to the local watchdog.** Two trip
  rules, two state keys, two narrations for what is the same question
  ("does this provider answer?"). Rejected: one mechanism, one rule —
  this also closes the Ollama `Connection error` gap for free.
- **Persisted open state with a process-epoch check** (the breaker survives a
  restart, keyed to the process that opened it). Rejected as
  over-engineered: a restart is the standard remedy for a wedged provider;
  the state being *stale* is the risk, not losing it (see Decision).
- **Tightening ADR-0016's timeout-only evidence.** Rejected: the biggest
  evidence class in the log is *empty responses*, not timeouts.

## Decision

One breaker in `src/provider-breaker.ts` (state in
`cache.provider_breaker`), for local **and** cloud providers:

- **Evidence (D1).** `empty_response`, `empty_timeout`, `stall_timeout`, and
  `provider_error` with connection/5xx-shaped text (transport wording, HTTP
  5xx, gateway/unavailable phrasing). Never counts: rate limits (a parsed
  reset time wins — the rate-limit path owns them; a subscription window
  running out is not a wedge), per-model request/shape errors (400/404/422 —
  the ADR-0008 verdicts), aborts, overflows, and candidates skipped before a
  request was made. There is no second error taxonomy: classification reuses
  `error-signatures.ts`.
- **Trip rule (D2).** ≥ N **distinct** models of one provider with evidence
  inside a 10-minute window, no success in between. Cloud N = 3 (the
  evidence shows cascades of 4–6; one flaky model never trips), local N = 2
  (ADR-0016's value). A provider with only two candidates in a group is
  protected by never-dead-end, not by a lower threshold.
- **Intra-walk short-circuit (D3).** The trip is evaluated during the
  candidate walk: once the breaker opens, the provider's remaining candidates
  are skipped in the SAME walk. For timeouts this saves minutes in the very
  request that discovers the wedge.
- **Never dead-end (D4).** If every remaining attemptable candidate sits
  behind an open breaker, the walk does not fail: it force-probes the
  highest-ranked candidate of the **soonest-expiring** breaker (labeled
  "probing wedged provider" in the error aggregation). A breaker can only
  reorder and delay attempts, never remove the last option.
- **State machine (D5).** `closed → open(until) → half-open → closed |
  open(escalated)`; cooldown ladder `[2, 5, 15]` min, reset by any success of
  any model of the provider. After the cooldown, one failing re-probe
  re-opens one step up (bounded by the evidence window); a success closes
  and clears.
- **Volatile state, persisted telemetry (D7).** The open state is stripped
  from every cache read and write — a restart must never re-open a breaker
  the restart just fixed (the worst moment to be stale). `provider_breaker_stats`
  (trips, last trip time, avoided hops per provider) persists as the tuning
  evidence. The learned blocklist (ADR-0008) stays persisted — a different
  class, deliberately long-lived.
- **Config (D8).** Optional `provider_breaker` config (`enabled`,
  `min_models`, `window_s`, `cooldown_s`); defaults live in code, the shipped
  config carries no entry. `enabled: false` disarms the **cloud** breaker and
  restores the pre-1.7.0 behavior exactly; the local watchdog of ADR-0016
  always stays active.

## What ADR-0016 got wrong (corrected here)

- **Timeout-only evidence.** The wedge signature with the most log evidence
  is the *empty response*; connection errors ("Connection error.") are
  equally provider-level. D1 generalizes the evidence kinds; the local
  watchdog's `recordLocalTimeout` is now one input among several.
- **"A restart starts clean."** ADR-0016's own correction (2026-10-06)
  already replaced this with what the code really did (state persisted with
  the cache); D7 makes the ORIGINAL claim true by policy: breaker state is
  volatile across restarts, on purpose.
- **Flat 5-minute cooldown.** Replaced by the `[2, 5, 15]` min ladder (owner
  decision on plan question Q2, recorded in ADR-0016's update note).

## Consequences

- A wedged provider costs at most N failing attempts per open instead of one
  per candidate per request; the replay over the 6-day log
  (`scripts/provider-breaker-replay.ts`) shows the rule would have skipped
  **172 doomed attempts** (109 ollama, 63 claude-bridge) with **0 false
  trips** — and no trip at all on the Mistral 400/422 days, while every
  bridge cascade trips.
- A provider whose breaker is open is invisible to routing until the cooldown
  ends, a probe succeeds, `/router cooldowns clear` runs, or the session
  restarts. All four exits are deliberate.
- The volatile-state rule means a breaker cannot protect across restarts —
  accepted: the first walk after a restart re-discovers a still-wedged
  provider at the cost of N attempts, once.
- Per-model mechanisms (ADR-0013 backoff, health demotion, ADR-0008
  blocklist) are unchanged; the breaker is an additional, provider-scoped
  layer on top.

Tests: `test/provider-breaker.test.ts` (module: evidence filter, trip rule,
ladder, half-open re-open, isolation), `test/provider-watchdog*.test.ts`
(ADR-0016 parity pins), `test/provider-breaker-orchestration.test.ts`
(driveStream wiring: trip mid-walk, forced probe, no trip on 400/422 or
parsed-reset rate limits), `test/provider-breaker-visibility.test.ts`
(volatile state, persisted stats, `/router` lines, clear command) and
`test/provider-breaker-replay.test.ts` (the sanitized real-log fixtures of
the plan's Phase 4 gate).
