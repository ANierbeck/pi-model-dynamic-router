# Router groups become Pi virtual models (two-layer migration)

**Status:** approved, in progress — 2026-11-21. Step 1 (spike) done: go on
every item, two conditions (`docs/research/2026-11-21-router-shape-spike.md`).
The owner then decided to migrate for 2.0.0 with the virtual layer as the only
path (open decisions 1, 2 and 4 below). Steps 2, 3 and 5 are built before
2.0.0; step 4 (the owner's live phase) is the gate for proposing the release.
Step 2 built on `feat/virtual-selection` (2026-11-21), not yet merged.

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
1.6.0 (2026-11-21, `spikes/virtual-models/README.md`). Step 1's items:
`docs/research/2026-11-21-router-shape-spike.md` (42 checks on Pi 1.6.0,
2026-11-21). The group registration claims (one provider per group,
re-registration at `session_start` and on every cache-economics update):
`src/group-registration.ts` L160–206, `src/event-handlers.ts` L260, at `main`
`9fc43e5`.

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
| Compaction threshold | group model's `contextWindow` | to verify in step 4: Pi's `docs/virtual-models.md` says context usage under a virtual selection uses the limits of the physical model that answered last, and compaction also checks the routed model (review 2026-11-21) |
| Group models in `/model`, `--model`, scoped models | selectable (they are the selection) | hidden: the group provider's `filterModels` returns nothing |

**Hiding the dispatch layer.** Once the virtual models are the selection, the
group models (`planning`, `code_complex`, …) no longer need to be selectable. Pi separates the catalog from
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

Each step is its own PR with red-first tests (AGENTS §4). Users of the
published package see nothing before 2.0.0; on the branch, step 2 already
hides the groups from `/model` and turns `set_model_from_group` into a pin
(the CHANGELOG and README entries are step 5's).

1. **Close the open facts (spike, no ship code).** Extend
   `spikes/virtual-models/` and write results to `docs/research/`:
   - `route()` returning an extension-registered provider model that has
     `streamSimple` (the two-layer hop) on Pi 1.6.0: stream, abort, error
     message, retry after compaction.
   - Resume: a virtual model registered in the extension factory holds the
     selection on `--continue` (`agent-session-services.js` suggests yes;
     verify end to end), including print mode.
   - `/tree` and fork: state follows the branch; pi-subagents children given
     `router/dynamic` route on their own branch, and a delegation that names
     a category group still reaches it (open decision 3: the groups are no
     longer selectable models).
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
   **Done 2026-11-21:** go on every item; conditions below in steps 2 and 3.
2. **Selection layer (2.0.0).** Register the one virtual model
   `router/dynamic` at extension load. Its `route()` returns a hidden group
   model and nothing else: the pinned group from the branch state if there is
   one, otherwise `dynamic/dynamic`, whose `groupStream` classifies exactly
   as today. Every reason (`user`, `continuation`, `retry`, `direct`) takes
   the same path, so compaction summaries behave as they do today on
   `dynamic/dynamic` (open decision 3's `direct` group: unchanged).
   - The group providers become native pi-ai `Provider`s with
     `filterModels: () => []`. **Spike condition (G1b):** a re-registration
     shows the group models in the availability snapshot until the queued
     refresh lands (under 500 ms). Today the router re-registers at
     `session_start` and whenever a group's cache economics change, so the
     provider's `getModels()` returns the current economics live instead, and
     the provider is registered once and again only when the group set
     changes.
   - `set_model_from_group` (`src/tools.ts`) becomes a pin in the branch state
     instead of `pi.setModel`; `none` and the classifying group release it.
     It throws on a session that is not on `router/dynamic`, where no
     `route()` would apply the pin. The spike's pattern: the
     tool records the pin per session, the next `route()` call (the tool
     follow-up, `continuation`) applies and stores it.
   - **Spike condition (F7): old sessions.** At `session_start`, a branch whose
     selection names a router group moves to `router/dynamic`; a group other
     than `dynamic` becomes the pin. This replaces `src/session-restore.ts`.
     A session that *starts* on a group model moves too: Pi resolves the
     settings default and `--model` through the unfiltered catalog, so a
     default of `dynamic/dynamic` still lands on the hidden group (review
     2026-11-21). Headless children (no UI) keep their model. A `:use-static`
     selection migrates to its group, which `route()` serves through the
     group's own method; the `:use-static` variant itself is dropped (open
     decision 6, decided).
   - `route()` maps a `failed` physical model back to the group through the
     state's run group, never through `failed.model.provider` (spike D3).
   - The router's own `getAvailable()` readers (`src/routing.ts`,
     `src/scan-runner.ts`, `src/dynamic-config-runner.ts`,
     `src/commands.ts`) are checked against hidden groups.
   - The footer and the `/router` overview show the served group and model,
     not `ctx.model` (which stays `router/dynamic`): `route()` records the
     group it dispatched each session to.
3. **Turn state into `route()` state (2.0.0).** Move the pin, run group and
   inherited category into the branch state; the in-memory `TurnState` keeps
   only what is per request (stream time, turn sequence). Then a fork and a
   `/tree` jump see their own branch's category, and a restart keeps it.
4. **Owner live phase (gate for proposing 2.0.0).** The owner works on the
   branch; the decision log and `/router status` are compared against the
   last weeks on the group layer (served models, failovers, cost). No default
   flip: there is no switch.
5. **Remove the workarounds (2.0.0, same release):** the duplicated
   `activeGroup`/`curModel` pairs, the sub-call scope where `direct` covers
   it. (`src/session-restore.ts` and its `setModel` call site already went
   in step 2; the one call site left is the migration's in
   `src/event-handlers.ts`, pinned by `test/no-router-setmodel-static.test.ts`.) The breaking changes
   (group models gone from `/model`, `--model` and `enabledModels`;
   `set_model_from_group` pins instead of switching) go into the CHANGELOG
   and README.

## Open decisions

1. ~~Reopen the 2026-11-07 decision at all.~~ **Decided 2026-11-21 (owner):**
   yes; step 1 was approved and is done.
2. ~~Timing relative to 2.0.0.~~ **Decided 2026-11-21 (owner):** in 2.0.0.
3. ~~Naming and what stays visible.~~ **Decided 2026-11-21 (owner):** one
   virtual model, `router/dynamic` (the owner chose it over taking over the
   ref `dynamic/dynamic`); the group providers are hidden. The `direct` group:
   unchanged behavior, `route()` returns `dynamic/dynamic` (step 2).
4. ~~The switch and its default.~~ **Decided 2026-11-21 (owner):** no switch;
   the virtual layer is the only path in 2.0.0, old sessions are migrated at
   `session_start`, the workarounds go in the same release.
5. **Widen the re-evaluation trigger** of the 2026-11-04 plan beyond retry
   behavior, and add the retry matrix to the host alignment checklist in
   AGENTS §10 (it was skipped in the 1.6.0 round). Still open; with the
   migration done the trigger turns into "re-run the router-shape spike on
   every host upgrade", which is the recommendation.
6. **The `:use-static` variants.** Decided 2026-11-21: dropped, together
   with the keyword static classifier that only they reached. No variant is
   registered any more; the legacy restore still recognises a `<group>:use-static`
   branch selection so that old sessions migrate to router/dynamic (review
   2026-11-21, Minor 2). The "static" leg is gone from the classifier chain.
