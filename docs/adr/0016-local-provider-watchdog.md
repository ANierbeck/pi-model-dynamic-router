# ADR-0016: Local-provider watchdog for a wedged Ollama daemon

**Status**: Accepted and implemented (2026-09-27).

## Context

On 2026-09-25 and 2026-09-26 the Ollama daemon wedged twice. `ollama ps`
showed a model stuck in "Stopping…" with about 11 GB of GPU memory held. The
HTTP API still answered (`/api/tags`), but every generation request timed
out (MLX runner bug in Ollama 0.33.3). Manual fix: kill the Ollama
processes; the launch agent restarts a fresh daemon.

The router did not notice:

- `isOllamaAvailable()` probes `/api/tags`, so it reported "up".
- Every local candidate then burned its full empty-response timeout. The
  log shows `gemma4:12b-mlx`, `ornith:9b` and `llama3.1` each waiting about
  30 s in a row before a cloud model answered.
- The classifier paid the same price for its primary and fallback model on
  every prompt.

This is a property of the **daemon**, not of any model. ADR-0008 therefore
excludes it from the model blocklist: blocking the models would hide them
for 7 days after a restart that takes seconds.

## Decision Drivers

- Stop paying one timeout per local model once the daemon is clearly stuck.
- Do not mistake one slow model (cold start, large model) for a wedge.
- Recover on its own once the daemon works again.
- Tell the user what is wrong and how to fix it.
- Never kill processes on the user's machine without being asked.

## Options Considered

- **Deeper availability probe** (e.g. a tiny generation request). This would
  catch the wedge, but it adds latency to every probe, and a slow cold start
  looks the same as a wedge.
- **Auto-restart the daemon.** It fixes the problem, but it kills user
  processes, is platform-specific (launch agent vs. systemd vs. manual),
  and conflicts with the rule to confirm destructive actions.
- **Detect from observed timeouts, skip the provider for a cooldown,
  narrate the fix (accepted).**

## Decision

`src/provider-watchdog.ts`, state in `cache.local_provider_health` (cache,
not module state, same reason as `model-health.ts`):

- A generation timeout on a local provider (`PROVIDER_MAP[p].local`) is
  recorded per model ref. It comes from `empty_timeout` / `stall_timeout` in
  `driveStream`, and from a timeout error on the classifier's Ollama call.
- Timeouts on **at least 2 distinct** local models within **10 min**, with no
  local success in between, mark the provider wedged for **5 min**. One slow
  model alone never triggers it.
- While wedged, `driveStream` skips that provider's candidates ("skipped,
  local provider looks wedged"), and the classifier skips both local models
  and goes straight to its cloud or static fallback.
- Any local success clears the evidence and the wedge. After the cooldown,
  the next local attempt is the re-probe.
- The first wedge is narrated once in the chat, including the fix
  ("restart the daemon, e.g. `pkill ollama`; a launch agent or service
  restarts it"), and logged. The `/router` overview shows the wedged provider
  and the remaining cooldown. The router never restarts the daemon itself.

## Consequences

- A wedged daemon costs two timeouts instead of one per local candidate
  per request, and nothing on the classifier path after that.
- If the daemon stays broken, each 5-minute window costs two more timeouts
  (the re-probe). That is acceptable.
- A daemon that is merely overloaded (two large models cold-starting at
  once) can be skipped for 5 minutes by mistake. Cloud candidates carry the
  load in the meantime.
- Watchdog state lives in the cache object, which is written to disk
  (debounced / every 10 turns) and re-merged on load — so an open wedge
  *can* survive a restart until its timestamp expires (corrected
  2026-10-06; this line used to claim "a restart starts clean", which is
  not what the code does). The provider circuit breaker plan
  (`docs/plans/2026-10-06-provider-circuit-breaker.md`, D7) proposes making
  breaker state volatile so that a restart — the usual remedy for a wedge —
  never leaves a stale skip behind.

**Update 2026-10-06 (breaker plan, Phase 1):** the mechanism moved to
`src/provider-breaker.ts` (one breaker for local and cloud providers);
`src/provider-watchdog.ts` is now a thin shim with the names above. The flat
5-minute cooldown was replaced by the breaker's `[2, 5, 15]` min ladder (first
trip 2 min, repeated trips without a success escalate, capped at 15 min) —
owner decision on plan question Q2. State moved to `cache.provider_breaker`.

Tests: `test/provider-watchdog.test.ts` (thresholds, window, success
clears, cooldown expiry, narrate once, provider isolation) and
`test/provider-watchdog-integration.test.ts`. The integration test covers
the classifier skipping Ollama after primary and fallback timed out, and
`driveStream` skipping the third local candidate and narrating. The
`driveStream` case fails without the orchestrator wiring.
