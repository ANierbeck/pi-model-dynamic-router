# Pi Virtual Models vs. the router's turn-state machine

**Date:** 2026-11-04
**Plan:** `docs/plans/2026-11-04-virtual-models-routing.md`
**Sources:** `@earendil-works/pi-coding-agent` 1.5.0 — `docs/virtual-models.md`, `dist/core/extensions/types.d.ts`, `CHANGELOG.md` (feature added in 0.99.0, 2026-09-29, marked "experimental" there), `docs/settings.md` (retry). Code: `main` at `fde54f8`.
Everything below is read from docs, types and code. No virtual model was run; no behaviour of Pi under failure was observed.

## How the API works (from the docs)

| element | meaning |
| --- | --- |
| `pi.registerVirtualModel({ provider, id, name, thinkingLevels, contextWindow?, maxTokens?, input?, route })` | a selectable model listed in `/model`, `--model`, settings; `route` may be async |
| `route(request, ctx) → { model, thinkingLevel, state? }` | runs before EVERY request made with the virtual model; `model` must be a physical model with credentials |
| `request.reason` | `user` (first request after a user message incl. steering/follow-up messages), `continuation` (any other request in the agent loop, e.g. after tool results), `retry` (automatic retry after a failure, incl. after compaction for overflow), `direct` (outside the agent loop: compaction summary, an extension calling `ctx.modelRegistry.streamSimple()`) |
| `request.previous` / `request.failed` | last successful physical model + level; for `retry` the failed physical model, level and assistant message (`stopReason`, `errorMessage`) |
| `request.state` / returned `state` | JSON stored per session branch, survives compaction, follows fork and `/tree`; `direct` requests have none |
| recorded | selection in `model_change`; each assistant message names the physical `provider`/`model`/`thinkingLevel` |
| display / cost | footer shows `selection → routed model`; `/session` lists cost per physical model |
| context | usage and compaction use the physical model's limits; if the routed model's window is too small, Pi compacts before sending |
| failure | `route()` throws or returns a virtual/unauthenticated model → the request ends with an error response |
| retry (settings) | `retry.maxRetries` 3, `baseDelayMs` 2000, `maxAgentDelayMs` 60000; provider-level retries default 0 |

## Mapping: our problems → what the API gives

| our item | today | with a virtual model |
| --- | --- | --- |
| Incident 2026-11-03 / C1 / I1 / I2 suppression / I6 | sub-call writes `lastDynamicModel`/`curModel`; guarded by an async scope (`src/subcall-scope.ts`) | delegation and `bulk_read` call `ctx.modelRegistry.streamSimple()` → `direct`; no turn state exists to write |
| I3 follow-up falls to `simple` | `[lastDynamicModel, ...simple candidates]` | `continuation` returns `previous`; `retry` gets `failed` and picks the next candidate of the run's group, which `state` remembers |
| I2 remainder / M1 per-session state | module variables shared with subagent sessions | `state` per branch |
| C2 attribution at `turn_end` | `Router.getCurModel` | assistant message names the physical model; cost per physical model is Pi's |
| I5 compaction continuity | regex on parameter size | compaction is `direct`; `route()` decides with the real window (Pi also compacts when the routed window is too small) |
| "Pinned continuation does not update the category memory" (TODO 2026-10-22) | `lastClassifiedCategory` module variable | category in `state` |
| escalation level | `SessionEscalation` module object | `state` |
| footer routed-model display | own footer code | Pi's footer |

## What the migration would have to replace or lose

The router's failover runs inside one request. These behaviours are pinned by `test/consolidated-stream-error-pins.test.ts` (one describe per incident): `422-client-error-not-rate-limit`, `abort-not-provider-error`, `abort-text-not-rate-limit`, `blocklist-drivestream`, `claude-bridge-empty-response-narration`, `context-overflow`, `cooldown-collapse`, `is-expected-transient-error`, `provider-error-detection`, `provider-error-paid-cloud-cooldown`, `reasoning-timeout`, `repetition-loop-detection`, `reset-msg-fallback`, `skip-failure-malus`, `stall-timeout-detection`, `summarization-error-message`, `truncated-length`. Plus: bounded wait-for-reset, the provider circuit breaker (ADR-0026), the learned blocklist (ADR-0008), local-model slots and availability probes, the `[router] X — …, trying Y` narration, the HINT parser, the cooldown ladder.

With a virtual model Pi streams the physical model directly. The router could still observe outcomes (`message_end`, `after_provider_response`, `provider_stream_event` are notification hooks) and feed cooldown/breaker/blocklist for the NEXT `route()`, but it cannot abandon a stream mid-flight and start another candidate. Whether Pi's own idle timeout, retry and error classification cover stall, empty-response and repetition cases is unknown (spike step 3).

## Not covered by the API (stay as separate work)

- **I4** — tool-call markup emitted as text. `route()` never sees stream content.
- **M3** — turn latency includes tool time. Independent: `tool_execution_end.durationMs` (Pi ≥ 1.1.0) is the data to subtract.
- **C2 data** — reader-model benchmarks/health written before the fix decay by themselves.
- Ranking, classification (Laya), group definitions, cost/billing rules, config layers: unchanged; `route()` would call the same `resolve()`.

## Read-direction turn-state leaks (found in the PR #89 review, 2026-11-04)

The sub-call scope fix guards the WRITE direction. Three READ-direction leaks
remain (all pre-existing, none default-config, none correctness-relevant —
cost only). The migration must not inherit them:

- **Escalation level**: a sub-call into the dynamic group inherits the
  session's escalated level (`escalation.level` becomes the target group), so
  a summarizer can run on the expensive group.
- **Classification context**: a sub-call's classifier input is fed the main
  turn's `lastCategory`/`lastModel`.
- **`recordServedRef` timing**: the ref is recorded before `tryStream`
  confirms the stream opens (probe and collapse paths), so a ref that never
  served can become curModel/lastDynamicModel. Faithful port of the
  pre-fix semantics; `route()`'s `state` per branch would need the same
  look.

## Every other open item, mapped

| item (source) | depends on this plan? |
| --- | --- |
| mutation triage of the `stream-orchestrator` classification/HINT region (TODO, owner-mandated 2026-10-15) | yes — a migration removes much of that region; decide the spike first |
| fallback naming (plan 2026-10-25) | partly — "failover cascade" and "stream retry" are two of its six meanings |
| decision-log remaining phases (ADR-0027 Phases 2, 4, 5) | partly — `request.reason` is a cleaner turn boundary than the turn id planned there |
| task-type-balancing 5b/5d (cache-aware compaction, cheaper summary model) | no, but re-read Pi's compaction/`session_before_compact` docs first; Pi 1.5 also has its own cache warmer |
| felt quality vs benchmark ranking (TODO 2026-10-31) | no |
| Laya sidecar distribution (plan 2026-10-31) | no — but Pi's `ctx.modelRegistry.findOfType("classifier", …)`/`classify()` and native llama.cpp Laya models (Pi ≥ 1.1.0) are inputs to evaluate there |
| Release 2.0.0 gate | no — plus: add `CHANGELOG.md` to `files` so Pi 1.5's extension-update notice shows the migration notes |
| dependency round, Pi 1.5.0 alignment (branch `chore/pi-1.5.0-align`) | no |
| hygiene Phase 4 Step 5 (pin-file split) | no — and the pin files themselves are the in-request inventory above |
| optional `/router` warning (in-memory groups differ from file) | no |
| Large 4 tokens/s observation | no |
