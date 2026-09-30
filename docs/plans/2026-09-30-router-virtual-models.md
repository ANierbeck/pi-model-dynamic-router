# Router Virtual Models Migration Plan (Pi 0.99.x) — Hybrid with Dispatcher Shim

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Expose the router's groups as Pi virtual models (`pi.registerVirtualModel()`) instead of fake group providers. Keep today's in-stream orchestration (candidate failover, stall/empty timeouts, repetition/truncation detection, wait-for-reset, text-scan) intact through a router-owned dispatcher shim, so robustness does not regress.

**Architecture:** Each group becomes a virtual model `<group>/<group>` (plus `<group>/<group>:use-static` for dynamic groups). Model refs, `settings.json` defaults, and existing sessions stay valid. `route()` classifies nothing. It returns the group's **shim model**: a physical model of the router-owned provider `router-dispatch` whose `streamSimple` is today's `groupStream`. Classification, escalation, blocklists, cooldowns, and failover stay inside the orchestrator and run per request exactly as now. Pi owns selection (`model_change`), thinking-level clamping, and its own auto-retry on top.

**Tech Stack:** `pi.registerVirtualModel()` / `pi.unregisterVirtualModel()` (Pi ≥ 0.99.0), `pi.registerProvider()` for the shim, existing `src/stream-orchestrator.ts`, `index.ts` wiring.

**Owner decisions (2026-09-30):**
- **D1 — Full replacement of the fake group providers.** The `use_virtual_models` flag gates the new path; the old path stays one version as fallback, then is removed.
- **D2 — Claude-Bridge is out of scope** (third-party project). Its models stay ordinary physical candidates.
- **D3 — Hybrid with dispatcher shim** (decided after the plan review below). Pure native routing (`route()` → physical model) was rejected because Pi's auto-retry covers only part of our failover.
- **D4 — The `/router` classifier-display fix is split out** into its own plan and commit. It is independent of virtual models and can be done on Pi 0.87.1.

---

## Review record (2026-09-30)

Checked against the real 0.99.1 sources (`docs/virtual-models.md`, `dist/core/virtual-models.d.ts`, `dist/core/extensions/types.d.ts`, `dist/core/agent-session.js`, `pi-ai/dist/utils/retry.js`) and the router code. Findings on the first draft (commit e4741c8) and their resolution:

| # | Finding | Resolution |
|---|---|---|
| C1 | Pi's auto-retry only triggers on `isRetryableAssistantError` (allow-list: overloaded, 5xx, rate-limit wording), with backoff (`retry.baseDelayMs` 2000, `maxRetries` 3). 422/403/404/guardrail errors and context overflow are not retried. `route()` runs before the request and cannot see the stream, so stall/empty timeouts, repetition/truncation, text-scan, and wait-for-reset cannot live there. | D3: the dispatcher shim keeps the orchestrator in the stream path. |
| C2 | Cost/metrics/usage-log attribution uses `router.getCurModel(turnStart)` in `turn_end` (`index.ts` ~1949–1982), which the orchestrator sets. Direct physical dispatch would starve it, and `recordStreamFailure` too. | Resolved by D3 (orchestrator stays in path). Task 4 adds a guard test. |
| C3 | `thinkingLevels` defaults to `["off"]`. Without the full list, the session's `defaultThinkingLevel: "high"` is silently lost. Pi clamps the level to the routed model, so no mapping table is needed. | Task 2 registers the full level list; the route passes the level through. |
| I1 | `route()` must never throw or return a virtual model (the request ends with an error). Candidate lists may contain other extensions' virtual models (`api === 'pi-virtual'`) under 0.99.x, **regardless of our flag**. | Task 1 filters virtual models from discovery; also added to the update runbook. |
| I2 | Mid-loop escalation (periodic `_checkAndEscalate`, `src/escalation.ts`) would be frozen by `continuation → previous`. | Resolved by D3: the orchestrator still reads `escalation.level` per request. |
| I3 | `direct` (compaction summaries) must not be re-classified onto a small-context model. | Resolved by D3: `direct` goes through the shim exactly as today. |
| I4 | The parity-corpus test "proven red against a stub" was vacuous (AGENTS.md §4). | Dropped: selection logic is unchanged by D3, so no parity corpus is needed. Tests target the new seams only. |
| I5 | Session state would have had two sources of truth (route state vs. cache object); "sessionQuality inputs" belong to unstarted Phase B. | Dropped: no route state in this migration (YAGNI). |
| I6 | devDependencies are still `^0.83.0`, so `tsc` can't check the new API. | Task 0 bumps them. |
| M1 | G2 was already answered: a virtual model under an unused provider id "is always available", with no provider stub. | Folded into the design. |
| M2 | The classifier-display fix is unrelated to virtual models. | D4. |

## Research gates — Task 0, after the Pi update

The remaining unknowns decide how much the hybrid gains. **R1 is a stop point:** if R1 is negative, report back to the owner before Phase 2, because the hybrid then mostly changes plumbing.

- **R1 — Physical attribution through the shim.** When the shim's `streamSimple` emits an `AssistantMessage` whose `provider`/`model` name the physical candidate that actually answered, does Pi keep those fields (native footer `dynamic • high → openrouter/… • medium`, per-physical cost in `/session`, real context limits), or does it overwrite them with the routed shim model? Read the dispatch code in `dist/core/agent-session.js` / the model runtime around `findLatestResponse` and `_modelForMessage`.
- **R2 — Shim visibility.** Can the `router-dispatch` provider's models be kept out of `/model` selection? If not, they must at least be clearly labelled (`name: "<group> (dispatch — select <group>/<group> instead)"`).
- **R3 — Retry interplay.** When the orchestrator has exhausted all candidates and the shim ends with `stopReason: "error"`, Pi may auto-retry (reason `retry`). Confirm this matches 0.87.1 behavior, and decide whether exhaustion errors should use non-retryable wording to avoid a second full chain run after backoff.
- **R4 — Footer.** Is the native routed-model display rendered by the built-in footer only (which we replace via `ui.setFooter`)? If so, our footer renders `selection → dispatch` itself.
- **R5 — `model_select`.** Does `pi.on('model_select')` (`index.ts` ~1909) fire for virtual selections, and does the `:use-static` detection via `ctx.model.id` (`index.ts` ~1847) still see the virtual id?

## Task 0: Dependencies and research — **agent, after the Pi update**

**Step 1:** Bump `devDependencies` `@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui` from `^0.83.0` to `^0.99.1`; run `npm install`, `npx tsc --noEmit`, `npx vitest run` (expected: green, as in the 2026-09-30 compatibility check). Commit `chore: bump pi devDependencies to 0.99.1`.
**Step 2:** Answer R1–R5 with file/line references from the installed 0.99.1 and append a "Research findings" section to this plan. Commit `docs: record virtual-models research findings`.
**Step 3:** Rewrite Tasks 2–5 below into bite-sized steps with concrete code based on the findings (the writing-plans skill requires exact code; that is only possible after R1–R5). If R1 is negative, stop and ask the owner.

## Phase 1 — Compatibility (independent of the flag)

### Task 1: Never route to virtual models

**Why:** under 0.99.x any extension can register virtual models. `api: 'pi-virtual'` requests fail unless routed, and a virtual model may not route to another virtual model.

**Files:** `src/discovery.ts` / candidate assembly (see `test/all-discovered-refs-excludes-virtual-groups.test.ts` for the existing seam); test: extend that test file.
**Step 1:** Failing test: a registry model with `api: 'pi-virtual'` from a foreign provider must not appear in any group's candidates. Prove red.
**Step 2:** Filter on `api === 'pi-virtual'` (string constant; `VIRTUAL_MODEL_API` is not importable on 0.87.1). Green, commit `fix: exclude pi virtual models from routing candidates`.

## Phase 2 — Config gate and registration

### Task 2: `use_virtual_models` flag, virtual models, shim provider

**Files:** `src/types.ts`, `index.ts` (`load()` whitelist, new `registerGroupVirtualModels()` next to `registerGroupProviders()` at ~1627); test: new `test/virtual-model-registration.test.ts` (pi mock with `registerVirtualModel`/`unregisterVirtualModel` recorders).

Tests first (each proven red):
- `use_virtual_models` survives `load()` (new keys must be whitelisted there).
- Flag on + API present: one virtual model per group (`provider: <group>`, `id: <group>`, `:use-static` variant for dynamic groups), `thinkingLevels` = the full list `off, minimal, low, medium, high, xhigh` (C3); **no** `registerProvider` call for group ids; exactly one `registerProvider('router-dispatch', …)` whose models are `<group>` / `<group>:use-static` with `streamSimple` = `groupStream`.
- Flag on + API missing (Pi < 0.99): old path unchanged, one router-log warning.
- Flag off: old path unchanged, no virtual-model calls.
- `session_shutdown` unregisters the virtual models when the flag was on.

Commit `feat: register router groups as virtual models behind use_virtual_models`.

### Task 3: `route()` → shim

**Files:** new `src/virtual-route.ts`; test `test/virtual-route.test.ts`.
Tests first: for every reason (`user`, `continuation`, `retry`, `direct`) the route returns the group's shim model from `ctx.modelRegistry.find('router-dispatch', <id>)` and passes `request.thinkingLevel` through. The `:use-static` virtual id maps to the `:use-static` shim. If the shim is missing, the route returns a clear error via a thrown `Error` whose message names the group. No state is returned (I5).
Adapt the orchestrator's `:use-static` detection (`stream-orchestrator.ts` ~218, `index.ts` ~3036) if R5 shows the shim id reaches it differently.
Commit `feat: route virtual group models through the dispatcher shim`.

## Phase 3 — Attribution and display

### Task 4: Attribution guard + footer

**Files:** `index.ts` (`turn_end` ~1922–1982, footer parts); tests: extend the footer/cost tests.
- Guard test (C2): with the flag on, a completed turn is tracked under the physical candidate ref (cost, usage log, metrics), never under a group or shim ref.
- Per R1/R4: if Pi keeps physical attribution, rely on it and keep our footer parts (cost sum, `⚠N err`, escalation narration); otherwise render `selection • level → dispatched • level` in our footer.
Commit `feat: attribute and display dispatched models under virtual groups`.

## Phase 4 — Flip and cleanup — **next version, owner GO required**

- Default `use_virtual_models: true`. A startup log line flags explicit use of the old path as deprecated. One version later, remove the fake-provider path.
- Version bump and release **only** with the owner's explicit, release-specific approval (AGENTS.md §1; review required before any tag).

## Constraints (repo rules that apply)

- English comments/docs/commits (AGENTS.md §3); Conventional Commits with *why* in the body (§5).
- `npx tsc --noEmit` + `npx vitest run` green before every commit; every test proven red first, never against a stub that cannot fail for the real reason (§4).
- New config keys go into the whitelist in `index.ts` `load()`.
- State lives in the cache object, never in module variables (esbuild double-bundle hazard).
- Ü1 invariant: the shim provider `router-dispatch` is router-owned, so re-registering it with its full model list is safe. Never register group ids as providers while the flag is on.
- No tag/release/publish without the owner's explicit approval (§1).
