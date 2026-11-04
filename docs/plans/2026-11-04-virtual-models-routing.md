# Route through Pi's Virtual Models: evaluate whether the router's own turn-state machine can go

**Status:** proposed 2026-11-04. Nothing is decided; the first step is a read-only shadow spike (see Solution). No code has been written for this plan.

AGENTS.md §11: one problem per plan. This plan covers ONE problem — the router keeps its own copy of "which model drives this turn" and a failover loop that has to be protected against its own sub-calls. Pi has offered a first-class feature for routing since 0.99.0. The measurements and the item-by-item mapping live in `docs/research/2026-11-04-virtual-models-fit.md`.

## Problem

The router registers one fake provider per group (`dynamic`, `simple`, `standard`, `code_complex`, `design`, `planning`, `bulk_reader`) with its own `streamSimple`. Everything Pi would otherwise know about a routed request is re-implemented in module state: `lastDynamicModel`, `Router.curModel`, `turnDriverRef`, `activeGroup`, `lastClassifiedCategory`, the escalation level, the compaction-continuity hint. That state is process-wide, not per session, and every stream the router opens — including its own sub-calls — can write it.

Consequences, all found in the last week:

- 2026-11-03: a `bulk_reader` delegation overwrote the turn's model; the next tool follow-up ran on a free summarizer, hit 429s, fell to `openrouter/openrouter/free`, which printed raw tool-call markup (PR #86).
- The post-merge review of 2026-11-04 found the same bug reachable through two more paths, lost on a Router replacement, and suppressing legitimate overlapping streams (fixed with an async-scope, branch `fix/subcall-scope-async-local`).
- Still open: a tool follow-up falls back to the `simple` group whatever the turn's group is (TODO since 2026-10-25; review I3), turn state is shared between subagent sessions (I2), compaction continuity trusts any "large" last model (I5).

Each fix adds another guard around the same hand-rolled state machine. The question is whether the state machine should exist at all.

## Solution (proposed): a shadow spike first, then decide

Pi's `pi.registerVirtualModel({ provider, id, route(request, ctx) })` runs `route()` before every request made with the virtual model and returns one physical `{ model, thinkingLevel, state? }`. The request carries `reason` (`user`, `continuation`, `retry`, `direct`), `previous` (last successful physical model), `failed` (model, level, error message of a failed request) and `state` (JSON per session branch, survives compaction, follows fork and `/tree`). Providers only ever receive physical models; assistant messages name the physical model; `/session` shows cost per physical model; Pi sizes compaction by the routed model's window.

Mapped onto our problems (details and caveats in the research note): a delegation or `bulk_read` call is a `direct` request and cannot touch the turn state; a tool follow-up is a `continuation` and stays on `previous`; a failed request arrives as `retry` with `failed`; turn state is per branch.

What it does NOT give us, and what the spike must quantify: the router's failover happens INSIDE one request (stall, empty-response, repetition, overflow and rate-limit handling try the next candidate before anything reaches the user). A virtual model chooses one model per request; recovery is Pi's agent-level retry (default 3 attempts, backoff from 2 s) on a new request.

Spike, in order, each step stops the plan if it fails:

1. **Inventory.** Classify every in-request behaviour of `driveStream` (the 17 incident-driven groups in `test/consolidated-stream-error-pins.test.ts`, local slots, breaker, blocklist, narration, escalation, HINT) as: Pi does it natively / reproducible between requests via `route()` + `message_end` events / lost.
2. **Shadow mode.** Register a second virtual model (config-gated, off by default) whose `route()` only LOGS the choice it would make, next to the choice the current chain made, into the decision log. Measure agreement on real sessions; no routing change.
3. **Retry behaviour.** Force a rate-limit and an empty response through a probe provider and record what Pi does (delay, number of attempts, what `failed` contains, whether the user sees an error).
4. **Decision.** Full migration, hybrid (virtual model selects, router keeps detection as event hooks), or stay and keep patching.

## Open decisions (owner)

1. **Is the spike wanted?** Cost: roughly the shadow route plus the inventory; no routing risk.
2. **Interim fixes in the meantime?** I3 (follow-up group), I5 (compaction continuity), I4 (tool-call markup as text) and M3 (latency incl. tool time) are needed whether or not we migrate, except I3/I5/I2 which a migration would make obsolete. Proposal: I4 and M3 now (independent); I3/I5 only as small interim guards.
3. **Order against the owner-mandated mutation triage** of the `stream-orchestrator` classification/HINT region (TODO, 2026-10-15: 710 undetected mutants, "do this first after laya-spike merges"). A migration would delete much of that region; triaging code that may go is waste. Proposal: decide this plan's spike first.
4. **Version line.** The five-group layout is already the 2.0 breaking change. Migration inside 2.0 or after it?

## Verified against

`main` at `fde54f8` plus branch `fix/subcall-scope-async-local` (`ade8102`), 2026-11-04. Checked: `docs/virtual-models.md`, `dist/core/extensions/types.d.ts` and `CHANGELOG.md` of `@earendil-works/pi-coding-agent` 1.5.0 (feature present since 0.99.0, so also in the installed 1.4.0); the retry defaults in `docs/settings.md`; the router's state writers by grep (`lastDynamicModel`, `setCurModel`); TODO.md; the 17 stream-error test groups by name.

**Not checked:** how Pi's retry behaves with a virtual model under real failures (spike step 3); whether Pi detects stalls, empty responses and repetition loops itself; whether `previous` survives a model that left the catalog; the `jev-router.ts` example; the stability of the API (the 0.99.0 changelog calls it "experimental", the current docs do not); how a user-selected `HINT:` model pin maps onto `route()`; resume behaviour when the virtual model is unregistered; any measurement of agreement between a virtual route and the current chain.
