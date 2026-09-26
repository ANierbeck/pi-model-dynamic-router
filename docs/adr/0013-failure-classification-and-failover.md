# ADR-0013: Failure classification and failover in stream orchestration

**Status**: Accepted (documented retroactively 2026-09-26). Built up over
the 1.4–1.6 line. Sources: `src/stream-orchestrator.ts`, `src/detection.ts`,
`src/rate-limit.ts`, `src/model-health.ts`, `src/repetition-guard.ts`,
`router-defaults.yaml`. ADR-0008 covers the complementary *permanent*
failures (learned blocklist). This ADR covers the transient ones.

## Context

Each request walks an ordered candidate list across providers of very
different reliability: free OpenRouter tiers, local Ollama, subscriptions
(claude-bridge), paid APIs. Failures come in many shapes: HTTP errors,
error events with free-text reasons, empty streams, streams that stall or
loop mid-answer, context overflows, user aborts. Treating them all alike
either burns paid quota on retries or locks healthy models out for hours.

## Decision Drivers

- A user abort is not a model failure.
- Paid cloud rate limits are real limits. Free/local hiccups are usually
  transient.
- Never leave the user with an opaque "Unknown error" if any candidate
  could still answer.
- Never change the session model behind the user's back.
- Keep broken models reachable eventually. Demote them, don't drop them
  (permanent removal is ADR-0008's job).

## Options Considered

- **Uniform exponential backoff for every failure.** Simple, but it puts a
  model that returned one empty stream behind a 90-minute lockout, and it
  cannot honour provider reset times.
- **No cooldown, just try the next candidate.** Re-burns the same failing
  model on every request.
- **Classified handling (accepted)**, as below.

## Decision

| Failure (orchestrator `reason`) | Handling |
|---|---|
| User abort (`aborted`, or abort-like free text in an error event) | Forward the abort. No cooldown, no retry. |
| Rate limit on a **paid cloud** model (`isPaidCloudRateLimitFailure`: rate-limit-shaped reason, not `:free`, not local) | Hard cooldown: escalating backoff `[1,2,4,8,16,32,64,90]` min. A parsed reset time (`parseResetAtMs`, incl. German locale and `7pm (Europe/Berlin)`) wins if it is longer. |
| Empty/timeout/provider error on free or local models | Soft backoff `[30s,60s,120s,300s]`, then next candidate. |
| Mid-stream `provider_error`, `stall_timeout`, `repetition_loop` | Abort the stream, fail over to the next candidate. |
| `context_overflow` | Parse the provider's window from the error and try a larger candidate. Then configured fallback groups. Then emit a native-style overflow signal so Pi compacts. |
| Structurally unusable candidate (skipped, not thrown) | Accrues a malus/cooldown so it is short-circuited next time. |
| Total cooldown collapse (every candidate cooling down) | Force-retry the candidate with the shortest remaining cooldown within the same call. The cooldown is a router heuristic, not a provider limit. |

Also:
- Reasoning models get a longer first-token timeout.
- `model-health.ts`: 2 consecutive failures (within a 15-min decay window)
  demote a model within its group. It is never dropped, and one success
  restores it.
- Local streams are serialized to a configured concurrency limit, and extra
  local candidates soft-fail to the next one.
- The orchestrator never calls `pi.setModel`. Routing happens inside the
  router's own provider stream.
- Narration of every hop (`> [router] …`) goes to the chat and to
  `router.log`. See ADR-0014 for why it must not leak back into
  classification.

## Consequences

- Transient failures cost seconds, and paid rate limits respect the
  provider's reset.
- Permanent failures (guardrail 403/404) are still retried every soft
  backoff window. That waste is what ADR-0008 addresses.
- The detection tables (`RATE_LIMIT_PATTERNS`, overflow patterns,
  `ABORT_LIKE_PATTERNS`) are the single source of truth. New provider
  wording is added there, not at call sites.

Tests pinning this: `detection`, `rate-limit-cooldown`,
`is-expected-transient-error`, `abort-*`, `provider-error-*`,
`stall-timeout-detection`, `repetition-*`, `reasoning-timeout`,
`context-overflow`, `overflow-try-larger`, `runtime-overflow-detection`,
`skip-failure-malus`, `cooldown-collapse`, `reset-msg-fallback`,
`model-health`, `ollama-concurrency-limit`, `sticky-model-regression`,
`summarization-error-message`.
