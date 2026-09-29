# Router Virtual Models Migration Plan (Pi 0.99.x) — Hybrid with Dispatcher Shim

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Expose the router's groups as Pi virtual models (`pi.registerVirtualModel()`) instead of fake group providers. Keep today's in-stream orchestration (candidate failover, stall/empty timeouts, repetition/truncation detection, wait-for-reset, text-scan) intact through a router-owned dispatcher shim, so robustness does not regress.

**Architecture:** Each group becomes a virtual model `<group>/<group>` (plus `<group>/<group>:use-static` for dynamic groups). Model refs, `settings.json` defaults, and existing sessions stay valid. `route()` classifies nothing. It returns the group's **shim model**: a physical model of the router-owned provider `router-dispatch` whose `streamSimple` is today's `groupStream`. `groupStream` derives the group from `model.id`, so shim ids equal to the group names (`<group>`, `<group>:use-static`) work without changes. Classification, escalation, blocklists, cooldowns, and failover stay inside the orchestrator and run per request exactly as now. Pi owns selection (`model_change`) and its own auto-retry on top. Pi's thinking-level clamping applies to the shim model, not to the physical candidate, so the physical candidate receives the session level exactly as today (no gain, no loss).

**Tech Stack:** `pi.registerVirtualModel()` / `pi.unregisterVirtualModel()` (Pi ≥ 0.99.0), `pi.registerProvider()` / `pi.unregisterProvider()` for the shim, existing `src/stream-orchestrator.ts`, `index.ts` wiring.

**Owner decisions (2026-09-30):**
- **D1 — Full replacement of the fake group providers.** The `use_virtual_models` flag gates the new path; the old path stays one version as fallback, then is removed.
- **D2 — Claude-Bridge is out of scope** (third-party project). Its models stay ordinary physical candidates.
- **D3 — Hybrid with dispatcher shim** (decided after the plan review below). Pure native routing (`route()` → physical model) was rejected because Pi's auto-retry covers only part of our failover.
- **D4 — The `/router` classifier-display fix is split out** into its own plan and commit. It is independent of virtual models and can be done on Pi 0.87.1. Its commit body must mention that deriving the category list from `CATEGORY_TO_GROUP` visibly changes the output (the hardcoded `cats` array says `design→strategic`, `CATEGORY_TO_GROUP` says `design: 'tactical'`), so the change is not mistaken for a regression.

---

## Review record (2026-09-30)

Checked against the real 0.99.1 sources (`docs/virtual-models.md`, `dist/core/virtual-models.d.ts`, `dist/core/extensions/types.d.ts`, `dist/core/agent-session.js`, `pi-ai/dist/utils/retry.js`) and the router code. Findings on the first draft (commit e4741c8), on the revision (commit f826d3c), and on the second revision (roborev jobs 648/649, commit 7d539ec), with their resolution:

| # | Finding | Resolution |
|---|---|---|
| C1 | Pi's auto-retry only triggers on `isRetryableAssistantError` (allow-list: overloaded, 5xx, rate-limit wording), with backoff (`retry.baseDelayMs` 2000, `maxRetries` 3). 422/403/404/guardrail errors and context overflow are not retried. `route()` runs before the request and cannot see the stream, so stall/empty timeouts, repetition/truncation, text-scan, and wait-for-reset cannot live there. | D3: the dispatcher shim keeps the orchestrator in the stream path. |
| C2 | Cost/metrics/usage-log attribution uses `router.getCurModel(turnStart)` in `turn_end` (`index.ts` ~1949–1982), which the orchestrator sets. Direct physical dispatch would starve it, and `recordStreamFailure` too. | Resolved by D3 (orchestrator stays in path). Task 4 adds a guard test. |
| C3 | `thinkingLevels` defaults to `["off"]`. Without the full list, the session's `defaultThinkingLevel: "high"` is silently lost. Pi clamps against the **routed** model — under D3 that is the shim, so the shim must advertise the full list too (if 0.99.1 has the field for provider models; R1 research). | Task 2 registers the full level list on the virtual models and on the shim models, and tests that `high` reaches `groupStream`. |
| I1 | A virtual model's `route()` must not throw or return a virtual model (the request ends with an error). Candidate lists may contain other extensions' virtual models (`api === 'pi-virtual'`) under 0.99.x, **regardless of our flag**. | Task 1 filters virtual models from every candidate source; also part of the update runbook. |
| I2 | Mid-loop escalation (periodic `_checkAndEscalate`, `src/escalation.ts`) would be frozen by `continuation → previous`. | Resolved by D3: the orchestrator still reads `escalation.level` per request. |
| I3 | `direct` (compaction summaries) must not be re-classified onto a small-context model. | Resolved by D3: `direct` goes through the shim exactly as today. |
| I4 | The parity-corpus test "proven red against a stub" was vacuous (AGENTS.md §4). | Dropped: selection logic is unchanged by D3, so no parity corpus is needed. Tests target the new seams only. |
| I5 | Session state would have had two sources of truth (route state vs. cache object); "sessionQuality inputs" belong to unstarted Phase B. | Dropped: no route state in this migration (YAGNI). |
| I6 | devDependencies are still `^0.83.0`, so `tsc` can't check the new API. | Task 0 bumps them. |
| I7 | **Shim self-reference.** The shim models are ordinary zero-cost provider models, so `allDiscoveredRefs()` (`src/routing.ts` ~532–566) would list `router-dispatch/<group>` as a routing candidate — `isVirtualGroupRef` only matches `<group>/<group>`, and zero cost makes it look like the best *free* candidate. Driving it recurses into `groupStream` (the 2026-09-10 circular-reference incident, now with a real nested stream). `isRefUsable` (`src/hint-resolution.ts` ~42) guards the HINT fallback pool only against group-named providers. | Task 1 introduces one shared "never a candidate" predicate covering group self-refs, `pi-virtual` models, and the `router-dispatch` provider, used at every candidate source. Task 2 asserts shim refs never become candidates. |
| I8 | The revision contradicted I1 by prescribing a thrown `Error` in `route()` when the shim is missing. | `route()` never throws: Task 2 registers the shim first and only registers the virtual models when the shim resolves; the route closure captures the shim `Model` object, so there is no per-request lookup that can fail. |
| I9 | `registerGroupProviders()` runs at load (`index.ts` ~1676) **and after every scan** (~3343). Gating only the load site would re-register group ids as providers next to the virtual models after the first scan. | Task 2 routes both call sites through one `registerGroups()` function and tests the post-scan pass. |
| I10 | `groupStream` stamps `sourceModel` from the `model` it receives (`index.ts:3144` at the 2026-10-14 HEAD; ~3046 when this plan was written — the `const sourceModel` assignment in `groupStream`). The code requires it to match `agent.state.model` exactly, or Pi's overflow-recovery `sameModel` check fails and auto-compaction never fires. Under D3 `model` is the shim, while the selection is the virtual model. | R6 research gate + Task 3 regression test. |
| I11 | Task 2's prescribed `modelRegistry.find('router-dispatch', …)` cannot work at the load call site (`index.ts` ~1676): no registry is in scope there, and Pi queues load-phase `registerProvider` calls in `runtime.pendingProviderRegistrations` (`loader.js:169`), flushed only later (`runner.js:188`) — the lookup would always miss and the fallback would register group ids as providers on every start (roborev 649 HIGH). | Task 2 revised: the shim `Model` objects are built locally from the same literals passed to `registerProvider` (router-owned, no lookup); new research gate R8. |
| I12 | The scan-union round-trip covered only scan-reported models, silently deleting pi-registered chat models the scan does not report (excluded, pruned, not scanned) — a live wipe on 0.87.1 (roborev 649 HIGH). | Fixed in the repo ahead of this plan: the union now starts from `modelRegistry.getAll()` filtered by provider; regression test in `test/register-group-models-merge-not-replace.test.ts`. |
| M3 | The predicate signature `(ref, model, groupNames)` needed a `Model` at call sites that only have refs (candidate assembly from the cache, diagnostics, HINT pool). | Signature is `(ref, registry, groupNames)` with an internal `find()`; a missing model means "not router-ineligible" (not virtual, not a group self-ref, not `router-dispatch`) and stays eligible (roborev 649 MEDIUM; wording corrected 2026-10-14 — the predicate covers more than virtual models, so "not virtual" was ambiguous). |
| M1 | G2 was already answered: a virtual model under an unused provider id "is always available", with no provider stub. | Folded into the design. |
| M2 | The classifier-display fix is unrelated to virtual models. | D4. |

## Research gates — Task 0, after the Pi update

The remaining unknowns decide how much the hybrid gains and how Tasks 2–4 look. **R1 is a stop point:** if R1 is negative, report back to the owner before Phase 2, because the hybrid then mostly changes plumbing. **R2, R3, and R6 are re-plan triggers:** a negative answer changes a task's shape, so rewrite the affected task before implementing it.

- **R1 — Physical attribution through the shim.** When the shim's `streamSimple` emits an `AssistantMessage` whose `provider`/`model` name the physical candidate that actually answered, does Pi keep those fields (native footer `dynamic • high → openrouter/… • medium`, per-physical cost in `/session`, real context limits), or does it overwrite them with the routed shim model? Read the dispatch code in `dist/core/agent-session.js` / the model runtime around `findLatestResponse` and `_modelForMessage`. Also: do provider models (not only virtual models) carry a `thinkingLevels` field in 0.99.1, and what is its default?
- **R2 — Shim visibility.** Can the `router-dispatch` provider's models be kept out of `/model` selection? If not, they must at least be clearly labelled (`name: "<group> (dispatch — select <group>/<group> instead)"`).
- **R3 — Retry interplay.** When the orchestrator has exhausted all candidates and the shim ends with `stopReason: "error"`, Pi may auto-retry (reason `retry`). Confirm this matches 0.87.1 behavior, and decide whether exhaustion errors should use non-retryable wording to avoid a second full chain run after backoff. Also: `groupStream` throws synchronously when a non-dynamic group has no candidates (`index.ts` — the `resolve()`-based throw `"No available models for group …"`; line ~3148 at the 2026-10-14 HEAD, ~3050 when this plan was written — cite as "the non-dynamic no-candidates throw in groupStream", not by line number) — through the shim that throw happens inside a virtual-model dispatch. Check how Pi surfaces a thrown `streamSimple` error versus a `stopReason: "error"` stream, and whether the orchestrator must convert the throw into an error stream first (roborev 649, missing consideration).
- **R4 — Footer.** Is the native routed-model display rendered by the built-in footer only (which we replace via `ui.setFooter`)? If so, our footer renders `selection → dispatch` itself.
- **R5 — `model_select`.** Does `pi.on('model_select')` (`index.ts` ~1909) fire for virtual selections, and does the `:use-static` detection via `ctx.model.id` (`index.ts` ~1847) still see the virtual id? Does it fire **per routed request**? The handler resets `activeGroup` on every non-`restore` source, so a per-request event would reset it every turn.
- **R6 — Overflow-recovery identity.** Which model does 0.99.1's overflow recovery / auto-compaction compare the error message against for a virtual selection: the selected virtual model or the routed (shim) model? This decides what `sourceModel` must be stamped with (I10).
- **R7 — Reload cleanup.** On `/reload` or extension re-load, does Pi drop providers and virtual models registered by the previous extension instance? This decides whether a flag flip needs explicit cleanup (Task 2).
- **R8 — Load-phase registration queueing.** On 0.87.1, Pi queues load-phase `registerProvider` calls in `runtime.pendingProviderRegistrations` (`dist/core/extensions/loader.js:169`) and flushes them only later (`dist/core/extensions/runner.js:188`); no `modelRegistry` exists at the load call site. Verify 0.99.1 still works this way — including for `registerVirtualModel` — because it decides whether ANY load-site registry lookup can ever see the shim (roborev 649 HIGH; I11 makes the plan independent of the answer).

## Task 0: Dependencies and research — **agent, after the Pi update**

**Step 1:** Bump `devDependencies` `@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui` from `^0.83.0` to `^0.99.1`; run `npm install`, `npx tsc --noEmit`, `npx vitest run` (expected: green, as in the 2026-09-30 compatibility check). Commit `chore: bump pi devDependencies to 0.99.1`.
**Step 2:** Answer R1–R8 with file/line references from the installed 0.99.1 and append a "Research findings" section to this plan. Commit `docs: record virtual-models research findings`.
**Step 3:** Rewrite Tasks 2–5 below into bite-sized steps with concrete code based on the findings (the writing-plans skill requires exact code; that is only possible after R1–R7). If R1 is negative, stop and ask the owner.

## Phase 1 — Compatibility (independent of the flag)

> Execution order note (roborev 649 LOW): Task 1 below runs BEFORE the Pi update (it is Task 0 Step 4 of the update runbook), while this plan's own Task 0 runs AFTER the update. Do not execute the tasks in numeric order.

### Task 1: One "never a candidate" predicate

**Why:** under 0.99.x any extension can register virtual models. `api: 'pi-virtual'` requests fail unless routed, and a virtual model may not route to another virtual model. The same predicate later keeps the shim out (I7).

**Runs before the Pi update** (Task 0 Step 4 of the update runbook), on the current `^0.83.0` types: compare against the string `'pi-virtual'` (`VIRTUAL_MODEL_API` is not importable on 0.87.1); mocks carry `api` as a plain field.

**Files:**
- `src/routing.ts`: replace `isVirtualGroupRef` (~377) with (or wrap it in) `isRouterIneligibleRef(ref, registry, groupNames)` — the registry-based signature fits every call site, because the candidate sources only hold refs: `allDiscoveredRefs()` builds refs from `cache.available_models` and `providers.*.free_models`, the diagnostics filter (~1065) works on `allModelRefs`, and `isRefUsable` (~42) receives a ref. The predicate resolves the model itself via `registry.find(provider, id)`; a missing model means "not virtual" (the fallback-cache case) and stays eligible. `ModelRegistryLike.find` returns `unknown`, so narrow with a type guard that reads `api` only on an object that has it. True for group self-refs, `model.api === 'pi-virtual'`, and provider `router-dispatch`. Apply it in `allDiscoveredRefs()` (~532–566) (roborev 649 MEDIUM).
- `src/hint-resolution.ts`: `isRefUsable` (~42) uses the same predicate — it gates the HINT fallback pool built from `getAvailable()` in `src/stream-orchestrator.ts` (~419–435). `rankHintCandidates` keeps *unusable* refs as last-resort candidates, so ineligible refs must be dropped from the HINT matches before ranking, not merely ranked last.
- `index.ts`: the registry-ref collection for dynamic-config generation (~1007) and the diagnostics filter (~1065) use the same predicate.
- Tests: extend `test/all-discovered-refs-excludes-virtual-groups.test.ts` (add `api` to `makeRegistry`) and the `isRefUsable` tests.

**Step 1:** Failing tests: a registry model with `api: 'pi-virtual'` from a foreign provider, and a `router-dispatch/<group>` model, must appear neither in any group's candidates nor in the HINT fallback pool. Prove red.
**Step 2:** Implement, green, commit `fix: exclude pi virtual models and router-internal refs from routing candidates`.

## Phase 2 — Config gate and registration

### Task 2: `use_virtual_models` flag, virtual models, shim provider

**Files:** `src/types.ts` (`Config`), `index.ts` (`load()` whitelist; new `registerGroups()` that replaces **both** `registerGroupProviders()` call sites, ~1676 and ~3343, and dispatches to `registerGroupProviders()` or `registerGroupVirtualModels()`); test: new `test/virtual-model-registration.test.ts` (pi mock with `registerVirtualModel`/`unregisterVirtualModel`/`unregisterProvider` recorders).

**Registration order (I8, revised per roborev 649 HIGH — see I11):** the load call site has no `modelRegistry`, and Pi queues load-phase `registerProvider` calls (`loader.js:169`, flushed in `runner.js:188`), so a registry lookup there would always miss. Build the shim `Model` objects **locally**, from the same literals passed to `registerProvider` — the shim provider is router-owned, so no lookup is needed. Register `router-dispatch` first; each virtual model's `route` closure captures its group's locally built shim `Model`. If `registerProvider` throws or the virtual-model API is missing, fall back to `registerGroupProviders()` and log one router-log warning. Each registration pass re-registers the shim and the virtual models, so the closures always hold the current shim objects. R8 records whether 0.99.1 still queues load-phase registrations; the locally built shim is queue-proof either way.

**Shim model metadata:** same values as today's group models (`reasoning: true`, `input: ['text','image']`, zero cost, `contextWindow`/`maxTokens` as in `registerGroupProviders()`), plus the full `thinkingLevels` list if R1 shows the field exists on provider models. The shim provider gets its own **unique `api` id** (e.g. `router-dispatch-stream`, following today's `router-group-${groupName}` convention) — never `pi-virtual` and never an existing api id, so it cannot overwrite or be confused with another provider's API implementation (roborev 649 LOW). Zero cost is harmless only because Task 1 excludes the shim from candidates.

**Flag flip (R7):** the flag is read once per extension load; flipping it takes effect on `/reload` or restart. If R7 shows Pi keeps registrations across reloads, `registerGroups()` removes the opposite path's entries first (`unregisterProvider(<group>)` when switching to virtual models; `unregisterVirtualModel` + `unregisterProvider('router-dispatch')` when switching back).

Tests first (each proven red):
- `use_virtual_models` survives `load()` (new keys must be whitelisted there).
- Flag on + API present, per registration pass: one virtual model per group (`provider: <group>`, `id: <group>`, `:use-static` variant for dynamic groups), `thinkingLevels` = the full list `off, minimal, low, medium, high, xhigh` (C3); **no** `registerProvider` call for group ids; exactly one `registerProvider('router-dispatch', …)` whose models are `<group>` / `<group>:use-static`, with `streamSimple` = `groupStream`.
- The post-scan pass (the ~3343 call site) with the flag on makes no `registerProvider(<group>)` call (I9).
- With the shim models in the registry, no `router-dispatch/*` ref is returned by `resolve()` or selected by the dynamic path (I7).
- With the session thinking level `high`, `groupStream` receives `high` in its options (C3).
- Shim registration that throws (or the virtual-model API is missing): old path, one warning, no virtual models (I8).
- Flag on + API missing (Pi < 0.99, including a rollback to 0.87.1): old path unchanged, one router-log warning.
- Flag off: old path unchanged, no virtual-model calls.
- `session_shutdown` with the flag on unregisters the virtual models and the `router-dispatch` provider.

Commit `feat: register router groups as virtual models behind use_virtual_models`.

### Task 3: `route()` → shim

**Files:** new `src/virtual-route.ts`; test `test/virtual-route.test.ts`.
Tests first: for every reason (`user`, `continuation`, `retry`, `direct`) the route returns the captured shim model of its group and passes `request.thinkingLevel` through. The `:use-static` virtual id maps to the `:use-static` shim. The route never throws (I1/I8). No state is returned (I5).
Per R6: stamp `sourceModel` in `groupStream` with the model Pi's overflow recovery compares against (the virtual selection or the shim). Regression test: a context-overflow error emitted through the shim is recognized by the overflow-recovery check (non-vacuous: it fails when `sourceModel` carries the other model).
Adapt the orchestrator's `:use-static` detection (`stream-orchestrator.ts` ~218, `index.ts` ~3036) if R5 shows the shim id reaches it differently.
Commit `feat: route virtual group models through the dispatcher shim`.

## Phase 3 — Attribution and display

### Task 4: Attribution guard + footer

**Files:** `index.ts` (`turn_end` ~1922–1982, footer parts); tests: extend the footer/cost tests.
- Guard test (C2): with the flag on, a completed turn is tracked under the physical candidate ref (cost, usage log, metrics), never under a group or shim ref.
- Per R1/R4: if Pi keeps physical attribution, rely on it and keep our footer parts (cost sum, `⚠N err`, escalation narration); otherwise render `selection • level → dispatched • level` in our footer.
- Per R5: if `model_select` fires per routed request, the `activeGroup` reset only applies to user-initiated selections; test that a routed request keeps `activeGroup`.
Commit `feat: attribute and display dispatched models under virtual groups`.

## Phase 4 — Flip and cleanup — **next version, owner GO required**

- Default `use_virtual_models: true`. A startup log line flags explicit use of the old path as deprecated. One version later, remove the fake-provider path.
- Version bump and release **only** with the owner's explicit, release-specific approval (AGENTS.md §1; review required before any tag).

## Constraints (repo rules that apply)

- English comments/docs/commits (AGENTS.md §3); Conventional Commits with *why* in the body (§5).
- `npx tsc --noEmit` + `npx vitest run` green before every commit; every test proven red first, never against a stub that cannot fail for the real reason (§4).
- New config keys go into the whitelist in `index.ts` `load()`.
- State lives in the cache object, never in module variables (esbuild double-bundle hazard).
- Ü1 invariant: the shim provider `router-dispatch` is router-owned, so re-registering it with its full model list is safe. Never register group ids as providers while the flag is on — at any registration site.
- Router-internal refs (group self-refs, `router-dispatch/*`) and `pi-virtual` models are never routing candidates (Task 1 predicate).
- No tag/release/publish without the owner's explicit approval (§1).
