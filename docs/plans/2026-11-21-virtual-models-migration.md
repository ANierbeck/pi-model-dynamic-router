# Router groups become Pi virtual models (two-layer migration)

**Status:** proposed — 2026-11-21, written on the owner's request ("create a
plan for the switch to Pi's virtual models"). Not approved; nothing is built.

**Verified against:** `main` @ `36ddef3`; pi-coding-agent 1.6.0:
`docs/virtual-models.md`; `dist/core/virtual-models.js` L29–42
(`getBranchSelection`), L65–85 (`createVirtualModel`); `dist/core/model-runtime.js`
L504–523 (`direct` routing of `streamSimple`), L743–766 (`resolveModel`:
`previous` is the latest successful response, the target must be a physical
model with credentials); `dist/core/agent-session.js` L515–541 (per-request
routing: `reason`, `state` stored as `pi.virtual-model-state`, compaction
check against the routed model); `dist/core/sdk.js` L84–104 (resume restores
the branch selection) and L262–270 (the cache warmer starts with the routed
model); `dist/core/agent-session-services.js` L98–110 (virtual models queued
at extension load are registered before the session is created);
`index.ts` L1029 (`registerGroupProviders()` runs at extension load);
`src/turn-state.ts` (`TurnState`, `RouterTurnState`, `SessionStore`, 64
sessions); 41 test files that mention `groupStream`. Hiding the group models
(added 2026-11-21): pi-ai 1.6.0 `dist/models.js` L121–123 (`getModel` reads
`getModels()` unfiltered) and L318–328 (`getAvailable` applies the provider's
`filterModels`), `dist/models.d.ts` L113–118 (`filterModels` is the documented
availability policy; `getModels()` stays the complete catalog);
pi-coding-agent `dist/core/model-registry.js` L21–25 (`ctx.modelRegistry`:
`getAvailable` = availability snapshot, `find` = `getModel`),
`dist/core/model-runtime.js` L192 (the snapshot `/model` lists comes from
`getAvailable`) and L366 (`hasConfiguredAuth` reads configured providers, not
models), `dist/core/extensions/loader.js` L373–381 (`pi.registerProvider`
also accepts a native pi-ai `Provider` object). The retry matrix on Pi
1.6.0 (2026-11-21, `spikes/virtual-models/README.md`). **Not checked:**
everything listed under step 1.

**Related:** `docs/plans/2026-11-04-virtual-models-routing.md` (the spike and
the 2026-11-07 decision to stay; its evidence is the basis of this plan and is
not repeated here), `docs/research/2026-11-04-virtual-models-fit.md`,
`docs/research/2026-11-06-virtual-model-spike.md`,
`docs/plans/2026-11-21-continue-restores-group.md` (the workaround this plan
would retire), `docs/plans/2026-11-07-session-keyed-turn-state.md`.

## Problem

The router's selection surface is not a Pi selection. Router groups are
registered as ordinary providers (`api: "router-group-<name>"`); Pi treats
them as physical models. Everything Pi does for a model *selection* that
routes per request therefore has to be rebuilt, or is missing, in the router:

- **Resume.** Pi only keeps a non-virtual `model_change` until the next reply.
  The router now re-selects the group at `session_start`
  (`src/session-restore.ts`, a second sanctioned `pi.setModel()` call site),
  with two documented gaps: print mode (`pi -p --continue`) and an explicit
  `--model` that names exactly the last responder.
- **Turn state lives in process memory.** `TurnState` (run group and driver
  for tool follow-ups, the inherited category, the cache-warm target) is
  keyed by session id in a `SessionStore` capped at 64 sessions. It does not
  follow `/tree` navigation or forks, and it is gone after a restart: the
  first turn after `--continue` has no category memory.
- **Selection and dispatch are mixed.** `TurnState` and `RouterTurnState`
  each keep an `activeGroup`/`curModel` pair, set by different paths
  (`model_select`, `set_model_from_group`, the stream), which the code itself
  marks as "kept apart until they can be merged".

## Solution

**Two layers: a Pi virtual model is the selection, the router's group
provider stays the dispatch.** Pi's documented constraint is that a virtual
model routes to a *physical* model; the group provider is one (non-virtual
api, credentials always present), so `route()` can return it. The group
provider keeps `groupStream`/`driveStream`, i.e. the whole in-request
failover walk, stall and empty-response detection, rate-limit waits, breaker
and narration.

A single layer (`route()` returning the concrete model) stays rejected: the
shadow route lost 16 of 93 turns (15 of them quota wording Pi does not retry,
1 empty response), and the retry matrix on Pi 1.6.0 is unchanged against the
1.5.0 baseline in all seven rows.

```
/model router/dynamic  ─route()─▶  dynamic/dynamic (group provider)  ─driveStream─▶  physical model
   (selection, model_change)          (dispatch, router-owned)            (named on the assistant message)
```

What moves where:

| Concern | Today | After migration |
|---|---|---|
| Resume / fork / `/tree` selection | `session-restore.ts` re-selects the group | Pi (`getBranchSelection` keeps a virtual `model_change`) |
| Category memory, run group/driver | `TurnState` in memory | `route()` state on the session branch |
| Tool follow-up group | `isToolFollowUp` + `runGroup` | `reason: "continuation"` + state |
| Compaction summary, extension sub-calls on the virtual model | sub-call scope (`AsyncLocalStorage`) | `reason: "direct"`, no state by construction |
| Failover, waits, breaker, narration | `driveStream` | unchanged (`driveStream` in the group provider) |
| Cache warming | group model declares economics | unchanged: the warmer starts with the routed model, which is the group model |
| Compaction threshold | group model's `contextWindow` | unchanged: Pi checks the routed model's limits |
| Group models in `/model`, `--model`, scoped models | selectable (they are the selection) | hidden: the group provider's `filterModels` returns nothing |

**Hiding the dispatch layer.** Once the virtual models are the selection, the
group models (`planning`, `code_complex`, …, and their `:use-static`
variants) no longer need to be selectable. Pi separates the catalog from
availability: `/model`, `--model` and scoped models list
`getAvailable()`, which applies the provider's `filterModels` policy, while
`getModel()` — what `route()`'s target check, `ctx.modelRegistry.find` and
the resume restore use — reads the unfiltered catalog. A group provider
registered as a native pi-ai `Provider` (`pi.registerProvider(provider)`,
not the name-plus-config form used today) with `filterModels: () => []` is
therefore invisible to the user and still routable. Old sessions whose last
`model_change` names a group model still resume onto it (unfiltered lookup).
With the switch of step 2 off, the filter stays off and today's behavior is
unchanged.

### Steps

Each step is its own PR with red-first tests (AGENTS §4). Nothing changes for
users before step 4.

1. **Close the open facts (spike, no ship code).** Extend
   `spikes/virtual-models/` and write results to `docs/research/`:
   - `route()` returning an extension-registered provider model that has
     `streamSimple` (the two-layer hop) on Pi 1.6.0: stream, abort, error
     message, retry after compaction.
   - Resume: a virtual model registered in the extension factory holds the
     selection on `--continue` (`agent-session-services.js` suggests yes;
     verify end to end), including print mode.
   - `/tree` and fork: state follows the branch; pi-subagents children given
     `router/<group>` route on their own branch.
   - Footer and `/session` with a virtual selection (the router replaces Pi's
     footer — what does `ctx.model` show, where does the routed model come
     from).
   - `HINT:` pins and `set_model_from_group` against a virtual selection.
   - Hidden group provider: a native `Provider` with `filterModels: () => []`
     stays out of `/model`, `--model` and scoped models (also in the first
     snapshot at startup, model-runtime L185, which does not apply the
     filter), still counts as configured (`hasConfiguredAuth`), still streams
     as `route()`'s target, and the router's own `getAvailable()` readers
     (`src/routing.ts`, `src/scan-runner.ts`, `src/dynamic-config-runner.ts`,
     `src/commands.ts`) keep working without the group refs.
   - Re-run `scripts/virtual-route-shadow.ts` on current logs (the 93-turn
     figure is from 2026-10-28 → 2026-11-06).
   Exit: a written go/no-go per item; any no-go stops the plan before step 2.
2. **Virtual layer behind a switch.** Register one virtual model per
   configured group at extension load (same place as
   `registerGroupProviders()`). `route()` resolves the group (classification
   and `HINT:` for `user`, the remembered run group for `continuation`, the
   failed request's group for `retry`, the group itself for `direct`) and
   returns the group provider model. The decision reaches `groupStream`
   through a one-request handoff keyed by session id (the spike's finding:
   `streamSimple` has no context). Off by default; the config key is an open
   decision.
3. **Turn state into `route()` state.** Move run group/driver and the
   inherited category into the branch state for virtual selections; the
   in-memory `TurnState` keeps only what is per request (stream time, turn
   sequence). Pins: a fork and a `/tree` jump see their own branch's
   category; a restart keeps it.
4. **Owner live phase, then default flip.** The owner runs on the virtual
   layer; the decision log and `/router status` compare against the group
   layer (served models, failovers, cost). Criteria are fixed before the
   phase starts (open decision). Then the default flips.
5. **Remove the workarounds** after one release on the new default:
   `src/session-restore.ts` and its `setModel` call site (the static guard
   goes back to one call site), the duplicated `activeGroup`/`curModel`
   pairs, the sub-call scope where `direct` covers it. Old sessions whose
   last `model_change` names `dynamic/dynamic` keep the restore until then.

## Open decisions

1. **Reopen the 2026-11-07 decision at all.** That decision was "stay"; the
   gains then were not reported bugs. New since: the `--continue` defect
   (fixed by a workaround with two gaps), and the owner's request to switch.
   Recommendation: approve step 1 only; decide on steps 2–5 with its results.
2. **Timing relative to 2.0.0.** Recommendation: after 2.0.0. Pi introduced
   virtual models as experimental (CHANGELOG 0.99.0) and no later entry says
   otherwise (the 1.6.0 docs and type comments no longer use the word), and
   the release has a critical path of its own already.
3. **Naming and what stays visible.** Virtual models under a provider id of
   their own (e.g. `router/<group>`); the group providers are hidden (see
   "Hiding the dispatch layer"; the earlier claim of this plan that Pi cannot
   hide them was wrong). Open: a virtual model per group, or only
   `router/dynamic` (the category groups then reachable only through
   classification, `HINT:` and `set_model_from_group`).
4. **The switch and its default** in step 2 (user config key, or a
   `/router` command), and the criteria for the default flip in step 4.
5. **Widen the re-evaluation trigger** of the 2026-11-04 plan beyond retry
   behavior, and add the retry matrix to the host alignment checklist in
   AGENTS §10 (it was skipped in the 1.6.0 round).
