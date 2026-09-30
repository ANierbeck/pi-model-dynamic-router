# Router Virtual Models Migration Plan (Pi 0.99.x)

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Replace the router's fake group providers (`registerProvider` + `streamSimple` override per group) with one `pi.registerVirtualModel()` per routing group, keeping classification, sticky/MHINT, momentum, and failover behavior — full replacement per owner decision 2026-09-30, with the old provider path kept behind a config flag for exactly one version.

**Architecture:** Under Pi 0.99.x a virtual model is a selectable model whose `route(request, ctx)` picks the physical model (and thinking level) per request. Pi records selection and dispatch separately, shows the routed model in the footer natively, lists per-physical-model cost in `/session`, checks compaction against the routed model's real limits, and keeps routing state (JSON-serializable, branch-scoped, compaction-surviving) for the router. The router keeps everything it does today *around* model choice — content classification (Ollama → cloud → static chain), sticky/MHINT escalation, momentum, learned blocklists, cost tracking, `/router` — and moves the *choice* into `route()`.

**Tech Stack:** `pi.registerVirtualModel()` (Pi ≥ 0.99.0), existing `src/content-classifier.ts`, `src/routing.ts`, `src/model-blocklist.ts`, `src/cost-tracker.ts`, `index.ts` wiring.

**Owner decisions (2026-09-30):**
- **D1 — Full replacement.** `use_virtual_models` config flag gates the new path; the old `registerProvider` path stays for one version as fallback, then is removed.
- **D2 — Claude-Bridge is out of scope.** It is a third-party project; its models stay ordinary physical candidates in our groups. The owner's observation that virtual models will also affect that project is noted, nothing more.

---

## Design gates — resolve BEFORE implementing (Phase 0)

The go/no-go question for the whole plan:

**G1 — Does Pi re-invoke `route()` on request failure?**
`request.reason` includes `'retry'` with `request.failed` (physical model + assistant message of the failed attempt), and the docs say "Returning `failed` for retry can switch models". We must verify in the installed 0.99.1 source *when* reason `retry` is produced: automatic on stream/request error within one user turn, or only on user/system-driven retries.
- **If automatic:** map our candidate chain 1:1 — hard failure → Pi re-asks `route()` → we consult blocklists/cooldowns and return the next candidate. Preferred end state.
- **If NOT automatic:** full per-request routing would silently *lose automatic failover*, which is unacceptable. Fallback design: `route()` returns one physical "dispatcher" model of a router-owned provider whose `streamSimple` keeps today's in-stream orchestration (candidate chain, stall timeouts, abandoned candidates). Selection/UX still moves to virtual models; dispatch transparency (footer, per-physical `/session` cost) is then partially ours to render.

**G2 — Does a virtual model need a provider registration?**
`provider` is "the provider the model is listed under" and may be one with physical models. Verify whether a *pure virtual* provider id (our group names `dynamic`, `strategic`, `tactical`, `operational`, `scout`) works without an accompanying `registerProvider` call, or whether a minimal provider stub is still required. Check `examples/extensions/jev-router.ts` and the source behind `pi.registerVirtualModel`.

**G3 — Thinking-level mapping.** Virtual `thinkingLevels` are ours to define; the returned physical `thinkingLevel` is per physical model. Define the map (session default is `high` today; free models often need `off`/`low`) and how `:use-static` interacts.

**G4 — Footer interplay.** Our extension replaces Pi's built-in footer (`ui.setFooter`). Determine whether the native routed-model display (`auto • high → model • level`) is visible under a replaced footer or must become a part of our custom footer. Audit which of our footer parts (cost sum, `⚠N err`, escalation narration) stay.

**G5 — `model_select` interception.** `index.ts` registers `pi.on('model_select')`. Under virtual models selection is recorded natively (`model_change`/`thinking_level_change`). Verify whether the hook still fires for virtual selections and what still needs it (e.g. `:use-static` pinning).

## Task 0: Research — **agent, after the Pi update**

**Step 1:** Read the full `docs/virtual-models.md` and `examples/extensions/jev-router.ts` from the installed 0.99.1 (`~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/`).
**Step 2:** Read the virtual-model dispatch source in `dist/` to answer G1–G5 exactly, with file/line references.
**Step 3:** Append a "Research findings" section to this plan file with the answers and the resulting design choice for G1 (per-request routing vs dispatcher shim). Commit as `docs: record virtual-models research findings`.

## Phase 1 — Config gate

### Task 1: `use_virtual_models` flag

**Files:** Modify `src/types.ts`, `index.ts` (`load()` whitelist), `src/dynamic-config.ts` if needed; Test: `test/dynamic-config.test.ts`, `test/config-loader.test.ts`.

**Step 1: Failing whitelist test** — assert `use_virtual_models` passes `load()` (new config keys MUST be whitelisted there; known repo rule).
**Step 2:** Run it, prove red.
**Step 3:** Add `use_virtual_models?: boolean` to `RouterConfig` + whitelist entry. Default: `false` in the introducing version.
**Step 4:** Tests green, `npx tsc --noEmit` clean.
**Step 5:** Commit `feat: add use_virtual_models config flag` — body explains it gates the virtual-models migration (D1).

## Phase 2 — Registration

### Task 2: Register one virtual model per group

**Files:** Modify `index.ts` (new `registerGroupVirtualModels()` next to `registerGroupProviders()`); Test: new `test/virtual-model-registration.test.ts` (extend the test pi mock with a `registerVirtualModel` recorder).

**Step 1: Failing tests** — when the flag is on and `pi.registerVirtualModel` exists:
- one virtual model per `cfg.model_groups` entry: `provider: <groupName>, id: <groupName>`, name label `"<group> → auto-classify"`, `thinkingLevels` per G3, `input: ['text','image']`;
- for `method: 'dynamic'` groups an additional `<group>:use-static` id (policy flag lives in the route closure);
- when the flag is off or the API is missing: no `registerVirtualModel` calls, old path unchanged.
**Step 2:** Prove red, implement, green.
**Step 3:** Commit `feat: register router groups as virtual models behind use_virtual_models`.

Registration notes: registering the same provider+id replaces the virtual model (documented) — safe on `session_start` reload; `pi.unregisterVirtualModel()` on shutdown when the flag was on. No module-level state: everything the route closure needs comes from the cache object (esbuild double-bundle rule).

## Phase 3 — Route decisions

### Task 3: `route()` for the four reasons

**Files:** Modify `index.ts` (route implementation, likely a new `src/virtual-route.ts`); Tests: new `test/virtual-route.test.ts`.

**Step 1: Failing tests, one per reason** (mocked classifier + registry):
- `reason: 'user'` → runs today's classification chain (`classifyPrompt` → sticky/MHINT → momentum → blocklist/cooldown filtering), returns `{ model: <physical ref>, thinkingLevel: <mapped> , state }`; state initialized with sticky candidate + momentum window.
- `reason: 'continuation'` → returns `previous` unchanged (keeps prompt caches and thinking signatures valid) without invoking the classifier.
- `reason: 'retry'` → given `failed`, returns the next candidate exactly in the old candidate-chain order, applying `model-blocklist`/cooldown exclusions; records the failure for the blocklist as `recordStreamFailure` does today.
- `reason: 'direct'` → route as `'user'`, no state returned (Pi ignores it).
**Step 2:** State contract test: the state object is JSON-serializable and carries exactly {stickyCandidate, momentumWindow, lastCategory, sessionQuality inputs}; round-trips through `route()` calls.
**Step 3:** If G1 answered "dispatcher shim": implement the shim provider here instead of the retry mapping, and route() returns the shim model; note the divergence in this plan.
**Step 4:** Commit `feat: route virtual group requests through the classifier chain`.

## Phase 4 — Parity

### Task 4: Parity corpus test

**Files:** Test: new `test/virtual-route-parity.test.ts`.

**Step 1:** Build a corpus of ≥20 prompts spanning the nine categories (trivial … fallback, including the known text-scan trap words). With identical classifier mocks, the virtual `route()` decision per prompt must equal the old `resolve()`/groupStream selection.
**Step 2:** Prove at least one case red against a stub, then implement fully, then green.
**Step 3:** Commit `test: virtual-model routing parity with the provider path`.

## Phase 5 — Footer and `/router` display

### Task 5: Display updates

**Files:** Modify `index.ts` (footer parts, `/router` overview around line 3572); Tests: extend footer/overview tests.

**Step 1:** Per G4: keep cost sum, `⚠N err`, escalation narration in our custom footer; add the dispatched-model part (`dynamic • high → openrouter/… • medium`) if the native display is not visible under the replaced footer.
**Step 2:** Fix the known hardcoded overview line ("Routes per prompt via Ollama (gemma2:2b)") — show the *actual* classifier chain from live state (configured/probed Ollama primary/fallback, cloud fallback, static) and derive the category list from `CATEGORY_TO_GROUP` (`src/content-classifier.ts:845`) instead of the hardcoded `cats` array. This closes the open UI issue from 2026-09-29.
**Step 3:** Tests green, commit `feat: show real dispatch and classifier chain in footer and /router`.

## Phase 6 — Flip and cleanup — **next version, owner GO required**

### Task 6: Default flip and deprecation

- Default `use_virtual_models: true`; startup logs a deprecation line when the old path is explicitly requested; one version later remove `registerGroupProviders()` and the fake-provider path entirely.
- Version bump + release **only** with the owner's explicit, release-specific approval (AGENTS.md §1; roborev review required before any tag).

## Constraints (repo rules that apply)

- All comments/docs/commits in English (AGENTS.md §3); Conventional Commits with *why* in the body (§5).
- `npx tsc --noEmit` + `npx vitest run` green before every commit; every bug fix gets a non-vacuous regression test proven red first (§4).
- New config keys go into the dynamic-config whitelist in `index.ts` `load()`.
- Router state lives in the cache object / `route()` state, never module variables (esbuild double-bundle hazard).
- Registration must never wipe existing provider registrations (Ü1 invariant) — virtual-model registration is additive, but the Phase 2 tests must still assert no `registerProvider` calls happen for groups while the flag is on.
- No tag/release/publish without the owner's explicit approval (§1).
