# Router-shape spike: the two-layer virtual-model design on Pi 1.6.0

**Date:** 2026-11-21
**Plan:** `docs/plans/2026-11-21-virtual-models-migration.md`, step 1
**Host:** pi-coding-agent 1.6.0 (`pi --version`), the version the router's
devDependency pins. The router release this prepares is 2.0.0; there is no
Pi 2.0.
**Earlier measurements:** `docs/research/2026-11-06-virtual-model-spike.md`
(retry matrix, single-layer shadow); this note adds the two-layer design.

Nothing here is a decision. It closes the open facts of step 1 with one
go/no-go per item.

## Setup

`spikes/virtual-models/router-shape-probe.ts` builds the planned design in
miniature:

```
router/dynamic        Pi virtual model, the only selectable router model
  └─ route() ─▶ rgrp/<group>   native pi-ai Provider, filterModels → []
                  └─ streamSimple ─▶ spike/<physical>   fake-server.mjs
```

`route()` resolves the group the way the plan describes: the pinned group from
the branch state, then `HINT: <group>`, then a keyword stand-in for the
classifier; `continuation` keeps the run group, `retry` leaves the failed
group, `direct` uses a fixed group. A `pin_group` tool stands in for
`set_model_from_group` as a pin. `router-shape-run.ts` drives 42 checks
in-process through the SDK (`createAgentSessionServices` +
`createAgentSessionFromServices`, isolated agent dir, persisted sessions, no
credentials, headless, so `ctx.hasUI` is false as in print mode). The fake
server gained a tool-call mode (`CALL:<tool>:<json>` in the last user message
of a request that offers tools) for the pin follow-ups.

Re-run: start `fake-server.mjs` with `SPIKE_OUT` set, then
`node spikes/virtual-models/router-shape-run.ts`. Result of the last run:
**42 checks, 41 pass, 1 fail (G1b).** INFO rows record behavior without a
pass criterion.

## Results per open item

| # | item (plan step 1) | checks | result | go? |
|---|---|---|---|---|
| 1 | two-layer hop: stream, abort, error, retry after compaction | B1–B4, D1–D7 | see §1 | go |
| 2 | resume keeps the virtual selection, also headless | F1, F2 | `router/dynamic` restored; `route()` gets the branch's state | go |
| 3 | `/tree`, fork, subagent children, delegation to a category group | E4, F3–F6 | state follows the branch in all four; a child given `rgrp/code_complex` still reaches the hidden group | go |
| 4 | footer and `/session` under a virtual selection | B3, B4, E1 | `ctx.model` is `router/dynamic`; the assistant message names the served physical model; stats work | go |
| 5 | `HINT:` and `set_model_from_group` as a pin | B5, C1–C3 | `HINT:` picks the group; a pin set by a tool applies to the tool follow-up (`continuation`), persists in the state, and is released again | go |
| 6 | hidden group provider | A1–A8, G1–G2 | hidden in every availability path; one transient leak on re-registration, see §2 | go, with the condition in §2 |
| 7 | shadow comparison on current logs | — | 63 turns, 61 same (96.8 %), 0 recovered, 2 lost | not a criterion any more, see §3 |
| 8 | (new) sessions saved before the migration | F7 | see §4 | go, needs migration code |

## 1. The two-layer hop

- A user turn calls `route()` once with `reason: "user"`; the group provider
  forwards the physical stream unchanged. The assistant message names the
  physical model (`spike/plan-c`), the selection stays `router/dynamic` (B1–B4).
- Abort during a stalled physical stream ends the turn as `aborted`, the
  selection survives, the next prompt routes normally (D5–D7).
- **An error the group provider builds itself** (the router's "every candidate
  failed") is final when its wording is not retryable for Pi: no retry, no
  second `route()` call (D1). With retryable wording (`429 …`) Pi retries and
  calls `route()` with `reason: "retry"` and `failed` naming the **group** model
  (D1b, D1c). The router's own failover inside `driveStream` therefore stays
  the authority; the wording of its final error decides whether Pi adds up to
  three more attempts.
- **Context overflow** on the physical model: Pi compacts (`compaction_start` /
  `compaction_end` with `willRetry: true`), the summary request routes as
  `direct`, the retry routes as `retry` (D3, D4). Here `failed` names the
  **physical** model (`spike/code-j`), because the forwarded message carries
  it. `route()` must map a physical `failed` back to the group through the
  state's run group, not through `failed.model.provider`.
- Manual compaction routes its summary as `direct` to the fixed group (E2),
  and the route state survives it (E3).

## 2. Hidden groups: one transient leak

Hidden in the first availability snapshot (A1), after a refresh (A2), for
scoped models (A8). `getModel()` still finds them (A4), the provider counts as
configured (A5), and `--model rgrp/<group>` still resolves through the full
catalog (A6), which is what keeps delegation to a group working (F6).

**G1b fails:** registering the native provider again at `session_start` puts
all group models back into the availability snapshot. `registerNativeProvider`
calls `markProvisionallyConfigured`, which rebuilds `available` as
`all.filter(configured)` without the provider's `filterModels`
(`dist/core/model-runtime.js`, `markProvisionallyConfigured`). The queued
`refresh()` removes them again within 500 ms (G1c). The router re-registers its
group models at `session_start` today (`rt.registerGroupModels(ctx)`).
**Condition for step 2:** register the hidden group provider once at extension
load and re-register only when the groups change, so `/model` never opens on
the stale snapshot.

## 3. Shadow comparison

`node scripts/virtual-route-shadow.ts --since=2026-11-06T00:00:00Z
--until=2026-11-21T23:59:59Z`: 63 turns (the router log rotates), 61 the same
under a single-layer virtual model, 2 lost (one quota wording Pi does not
retry, one stall Pi cannot see). The report measures the **single-layer**
design that the plan rejected. In the two-layer design the failover stays in
`driveStream`, so the figure no longer decides anything; it is recorded
because the plan asked for it.

## 4. Sessions saved before the migration (new)

A session whose selection was a group model, resumed after the groups are
hidden, came back on the last physical responder (`spike/code-c`), not on
`router/dynamic` (F7). In this run the session had no `model_change` entry for
the group (the SDK option sets the model without one), so Pi fell back to the
latest non-virtual reply. A session that switched with `/model` does have the
entry and resumes onto the hidden group model (unfiltered lookup), and from
there it would not use the virtual layer. Either way step 2 needs a migration
path: at `session_start`, a branch whose latest selection names a router group
moves to `router/dynamic` with that group as the pin. This replaces
`src/session-restore.ts` instead of keeping it next to the virtual layer.

## Not checked here

- The router's own `getAvailable()` readers (`src/routing.ts`,
  `src/scan-runner.ts`, `src/dynamic-config-runner.ts`, `src/commands.ts`)
  without the group refs: real router code, so step 2's tests cover it.
- The interactive TUI (`/model` list, footer rendering): the spike is headless.
  Step 4's owner live phase covers it.
- Cache warming with a virtual selection.
