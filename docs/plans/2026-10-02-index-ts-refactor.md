# index.ts Refactoring Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Shrink `index.ts` (3749 lines) to a pure wiring file (<1200 lines) by extracting its coherent blocks into `src/` modules — behavior-preserving, one module per task, suite-green after every step.

**Architecture:** Code motion + closure parameterization (the proven "C1" pattern already documented in `src/dynamic-config.ts`): every extracted function group becomes a module-level factory `createX(deps)` returning the same functions with explicit dependencies instead of implicit closure over `cfg`/`cache`/`pi`. `index.ts` builds the shared runtime objects once and wires handlers/tools/commands to the module factories. No behavior change, no API change, no config change.

**Tech Stack:** TypeScript (esbuild bundle), pi ExtensionAPI, vitest (1117 tests as the regression safety net), `npx tsc --noEmit` as the type gate.

---

## Preconditions (hard)

- **Timing (owner decision 2026-10-02, supersedes the original
  "after the 1.6.0 tag" precondition):** the refactoring lands BEFORE
  Release 1.6.0 — refactor first, then several live test rounds on the
  refactored build, then the release. The work happens on the
  `refactor/index-ts` branch in `.worktrees/refactor-index-ts` so the
  owner's live pi (loaded from the main checkout) stays stable.
- Fresh worktree per the using-git-worktrees skill; `main` must be green
  (`npx tsc --noEmit`, `npx vitest run` = 1114 passed / 3 skipped,
  `npm run build`).
- **esbuild double-bundle rule:** `cache` stays THE one shared object —
  modules receive the reference, never a copy, never module-local state.
- **`session_shutdown` ordering rule:** the final save must stay the LAST
  registered handler (tests depend on it).
- No changes to `DYNAMIC_CONFIG_RESYNC_KEYS`, config semantics, or the
  public extension surface (tools/commands/flags keep names and behavior).

## Block inventory of index.ts (source line ranges at plan time)

| Block | Lines | ~Size | Target module |
|---|---|---|---|
| Session-error status + save glue | 197–250 | 55 | `src/session-errors-glue.ts` (Task 9) |
| populateLlmMatches | 252–340 | 90 | `src/scan-runner.ts` (Task 4) |
| load() / loadCache / saveCache / discoverKeys | 351–504 | 155 | stays in index.ts (wiring) |
| hasModelBudget … fetchJson … scan() | 505–998 | 495 | `src/scan-runner.ts` (Task 4) |
| generateDynamicConfigNow | 1000–1352 | 355 | `src/dynamic-config-runner.ts` (Task 5) |
| Metrics/limit/blocklist/cost glue | 1354–1560 | 210 | `src/limit-glue.ts` (Task 2) |
| resolve / fmtModel / getTopModels / detectGroup | 1564–1630 | 70 | `src/model-resolve-glue.ts` (Task 3) |
| registerGroupProviders + buildOrchestratorContext | 1631–1803 | 175 | `src/group-registration.ts` (Task 8) |
| Event handlers (7× pi.on) | 1804–2110 | 305 | `src/event-handlers.ts` (Task 9) |
| 4× registerTool | 2113–2308 | 195 | `src/tools.ts` (Task 10) |
| hostStreamSimple / localStreamLimit / isLocalProvider | 2310–2369 | 60 | `src/stream-proxy.ts` (Task 7) |
| registerFreeModelOnDemand | 2371–2439 | 70 | `src/free-model-registration.ts` (Task 6) |
| tryStream / consumeWithDetection | 2440–2893 | 455 | `src/stream-proxy.ts` (Task 7) |
| Context utilities | 2894–3126 | 235 | `src/context-utils.ts` (Task 1) |
| groupStream | 3127–3179 | 55 | `src/stream-proxy.ts` (Task 7) |
| registerGroupModels (Ollama merge) | 3180–3380 | 200 | `src/group-registration.ts` (Task 8) |
| /router command | 3381–3716 | 340 | `src/commands.ts` (Task 11) |

Task order is by ascending risk: pure functions first, stateful machinery
last, wiring cleanup at the end.

---

### Task 1: Extract context utilities → `src/context-utils.ts`

**Files:**
- Create: `src/context-utils.ts`
- Modify: `index.ts:2894–3126`
- Test: existing suite (pure move); no new test file — the functions are
  already covered via classifier/stream tests.

**What moves:** `extractLastUserPrompt`, `estimateContextTokens`,
`getModelContextWindow`, `updateModelContextWindow`, `isReasoningModel`,
`getEmptyResponseTimeout`, `getStallTimeout`, `getRateLimitWaitMaxMs`,
`isCompactionTurn`, `extractLastAssistantSnippet`,
`extractPreviousUserMessage`.

**Steps:**
1. Create `src/context-utils.ts` with a header comment stating the C1
   pattern (code motion from index.ts, behavior-preserving). Move the
   functions. Functions reading `cfg` (the three timeout/getters) take
   `cfg: Config` as first parameter; `updateModelContextWindow`/`getModelContextWindow`
   take the shared `cache` object (by reference — double-bundle rule).
2. In index.ts, replace the block with
   `import { ... } from './src/context-utils.ts'` and thin wrappers only
   where call sites would otherwise churn (prefer updating call sites
   directly — fewer indirections).
3. Run: `npx tsc --noEmit` — expect clean.
4. Run: `npx vitest run` — expect 1114 passed / 3 skipped.
5. Run: `npm run build` — expect success.
6. Commit:
   `refactor: extract context utilities from index.ts to src/context-utils.ts`

### Task 2: Extract metrics/limit/blocklist/cost glue → `src/limit-glue.ts`

**Files:**
- Create: `src/limit-glue.ts`
- Modify: `index.ts:1354–1560`

**What moves:** `getM`, `updateMetrics`, `resolveKeyValue`, `costMux`,
`isLimited`, `recordLimit`, `recordOk`, `formatBlocklist`,
`observeFailure`, `clearLimit`, `recordSoftFailure`,
`recordStreamFailure`, `limitSecs`, `formatResetMsg`, `getUsage`,
`lookupPrice`, `effCost`.

**Pattern:** factory `createLimitGlue(deps: { cfg: Config; cache: Cache })`
returning the function bundle. All functions are thin wrappers over
`src/metrics.ts`, `src/model-blocklist.ts`, `src/rate-limit.ts` — they stay
wrappers, only the closure becomes explicit deps.
index.ts: `const limitGlue = createLimitGlue({ cfg, cache })` and call
sites switch to `limitGlue.isLimited(...)` etc.

**Steps:** same verify loop as Task 1 (tsc → full suite → build), then
commit `refactor: extract limit/metrics glue from index.ts to src/limit-glue.ts`.

### Task 3: Extract model-resolve glue → `src/model-resolve-glue.ts`

**Files:**
- Create: `src/model-resolve-glue.ts`
- Modify: `index.ts:1564–1630`

**What moves:** `resolve`, `fmtModel`, `getTopModels`, `detectGroup`.
Factory over `{ cfg, limitGlue }` (resolve needs isLimited/effCost).
Same verify loop; commit
`refactor: extract model-resolve glue from index.ts`.

### Task 4: Extract the scan → `src/scan-runner.ts`

**Files:**
- Create: `src/scan-runner.ts`
- Modify: `index.ts:252–340, 505–998`

**What moves:** `populateLlmMatches`, `hasModelBudget`,
`extractGdpvalScores`, `fetchJson`, `scan`.

**Pattern:** factory `createScanRunner(deps: { cfg: () => Config; cache: Cache; paths: {...}; llmStream: (…) => Promise<…> })`.
Note `cfg` passes as a getter — index.ts swaps `cfg` on resync, and the
scan must always see the CURRENT config. `scan()` keeps its postconditions:
cache updated in place, `routerLog` lines unchanged (grep-pin the
`[scan-union]`-free wording).

**Steps:**
1. Move code, parameterize closures, keep all `routerLog` strings
   byte-identical (they are part of the live verification Achim does).
2. Verify loop (tsc, full suite, build).
3. Commit: `refactor: extract scan machinery from index.ts to src/scan-runner.ts`.

### Task 5: Extract dynamic-config orchestration → `src/dynamic-config-runner.ts`

**Files:**
- Create: `src/dynamic-config-runner.ts`
- Modify: `index.ts:1000–1352`

**What moves:** `generateDynamicConfigNow` — the orchestration around the
already-extracted pure core (`src/dynamic-config.ts`).
Factory over `{ cfg, setCfg, cache, scanRunner, paths }`. The in-memory
cfg swap semantics (`generateDynamicConfigNow` replaces the live `cfg`
object reference) must be preserved exactly — thread the swap through a
`onConfigSwap` callback instead of closing over `let cfg`.

**Steps:** verify loop, then commit
`refactor: extract dynamic-config orchestration from index.ts`.

### Task 6: Extract free-model registration → `src/free-model-registration.ts`

**Files:**
- Create: `src/free-model-registration.ts`
- Modify: `index.ts:2371–2439`

**What moves:** `registerFreeModelOnDemand` (ADR-0021 exception: acts only
on explicitly configured `free_models`; Ü1 invariant via
`getRegisteredProviderIds`).
Factory over `{ cfg, cache, pi, routerLog }`.
Existing regression tests: `test/register-group-providers-u1-guard.test.ts`
and the ADR-0021 test — both must stay green unchanged.

**Steps:** verify loop, then commit
`refactor: extract registerFreeModelOnDemand from index.ts`.

### Task 7: Extract stream proxying → `src/stream-proxy.ts`

**Files:**
- Create: `src/stream-proxy.ts`
- Modify: `index.ts:2310–2369, 2440–2553 (tryStream), 2554–2893 (consumeWithDetection), 3127–3179 (groupStream)`

**What moves:** `hostStreamSimple`, `localStreamLimit`, `isLocalProvider`,
`tryStream`, `consumeWithDetection`, `groupStream`.

**Pattern:** factory `createStreamProxy(deps: { cfg, cache, orchestrator,
limitGlue, escalation, routerLog, buildOrchestratorContext })`. This is
the riskiest task — the functions share the proxy/stream machinery and
escalation state. Move as one unit; do NOT split tryStream from
consumeWithDetection (they are one call graph).

**Steps:**
1. Move code with explicit deps; no logic edits.
2. `npx tsc --noEmit`, full suite (`test/stream-abandon-and-text-scan.test.ts`,
   `test/tool-result-rate-limit.test.ts`, `test/escalation-*.test.ts` are
   the sensitive ones — run them first, then the full suite).
3. `npm run build`.
4. Commit: `refactor: extract stream proxy machinery from index.ts to src/stream-proxy.ts`.

### Task 8: Extract group registration → `src/group-registration.ts`

**Files:**
- Create: `src/group-registration.ts`
- Modify: `index.ts:1631–1803, 3180–3380`

**What moves:** `registerGroupProviders`, `registerGroupModels` (incl. the
Ollama MERGE block — keep the GUARD FIX comment block intact),
`buildOrchestratorContext` stays in index.ts (it wires live session ctx).
Factory over `{ cfg, cache, pi, routerLog }`.
Sensitive tests: `test/ollama-merge-registration.test.ts` (8),
`test/register-group-providers-*.test.ts`, ADR-0021 test.

**Steps:** verify loop, then commit
`refactor: extract group/Ollama registration from index.ts to src/group-registration.ts`.

### Task 9: Extract event handlers → `src/event-handlers.ts`

**Files:**
- Create: `src/event-handlers.ts`
- Modify: `index.ts:197–250, 1804–2110`

**What moves:** the session-error status/save helpers and all 7
`pi.on(...)` handler bodies. The module exports
`registerEventHandlers(pi, runtime)`; each handler body becomes a named
function. `session_shutdown` must remain the LAST registration inside
`registerEventHandlers` (test-order rule).
Sensitive: `test/session-errors-*.test.ts`, `test/session-shutdown` ordering.

**Steps:** verify loop, then commit
`refactor: extract pi event handlers from index.ts to src/event-handlers.ts`.

### Task 10: Extract tools → `src/tools.ts`

**Files:**
- Create: `src/tools.ts`
- Modify: `index.ts:2113–2308`

**What moves:** the 4 `pi.registerTool` blocks (`bulk_read`,
`set_model_from_group`, `resolve_model_group`, `update_model_metrics`)
as `registerTools(pi, runtime)`.
Sensitive: `test/expensive-model-read-block.test.ts`, `test/bulk-read*.test.ts`,
`test/update-model-metrics-*.test.ts`.

**Steps:** verify loop, then commit
`refactor: extract tool registrations from index.ts to src/tools.ts`.

### Task 11: Extract the /router command → `src/commands.ts`

**Files:**
- Create: `src/commands.ts`
- Modify: `index.ts:3381–3716`

**What moves:** the `pi.registerCommand('router', ...)` handler (~340
lines). Split into one function per subcommand (`cost`, `errors`,
`status`, `top`, `blocklist`, `models`, `login`, `scan`, … — check the
actual subcommand table) in `src/commands.ts`; export
`registerRouterCommand(pi, runtime)`.
Sensitive: `test/cost-report.test.ts`, `test/version.test.ts`, and any
`/router` output-format tests — output strings must stay byte-identical.

**Steps:** verify loop, then commit
`refactor: extract /router command from index.ts to src/commands.ts`.

### Task 12: Final wiring cleanup + docs

**Files:**
- Modify: `index.ts` (whatever remains)
- Modify: `README.md` (architecture section: mention the new module layout)
- Modify: `PI.md` only if it references index.ts internals.

**Steps:**
1. `wc -l index.ts` — target < 1200 lines (expected ~900–1100: default
   export, load(), loadCache/saveCache, discoverKeys, runtime object
   construction, registration wiring).
2. Dead-code sweep: no unused imports, no orphan wrappers.
3. Full verify: `npx tsc --noEmit` + `npx vitest run` + `npm run build`.
4. Review round per AGENTS.md §1 (superpowers requesting-code-review,
   reviewer subagent, BASE_SHA = release tag of 1.6.0).
5. Commit: `refactor: index.ts wiring cleanup after module extraction`.

---

## Implementation notes — deviations as executed (2026-10-02)

All 12 tasks landed (`300dbf5`..`2c35d47`); index.ts went from 3749 to
641 lines. Where the execution differs from the task text above:

- **Factory naming (all tasks).** Every module exports `createX(deps)`
  instead of `registerX(pi, runtime)`. Deps are wired as live getters (plus
  setters for state the moved code writes), so no module captures a stale
  value of a `let` binding in index.ts.
- **Task 9: session-error helpers stay in index.ts.** The block inventory
  above names `src/session-errors-glue.ts` as the target for
  `updateErrorStatusLine` / `scheduleSessionErrorSave`. That module was
  never created: both helpers close over `statusUpdater`,
  `sessionErrorSaveTimer`, `sessionStart` and `saveCache`, and are consumed
  by limit-glue and event-handlers, so they stay in index.ts as shared
  wiring and reach both factories via getters. index.ts is well under the
  size target with them.
- **Task 9: the final `session_shutdown` is not inside the factory.** The
  task text asks for `session_shutdown` to be the last registration inside
  `registerEventHandlers`. The handler that resets the session anchor, and
  the process-exit/signal cleanup, were registered at the very bottom of the
  original index.ts, after the tools and the `/router` command. They stay
  there so the relative handler order is unchanged. The cache-saving
  `session_shutdown` handler moved into `src/event-handlers.ts` in its
  original position.
- **Task 11: the `/router` handler moved as one unit.** It was not split
  into one function per subcommand. The subcommand if-chain moved as pure
  code motion, which keeps the output byte-identical with no further
  verification. The split remains possible as a separate follow-up
  (documented in the `src/commands.ts` header).

Task 7 follows the plan as written (one unit; the functions form a call
cycle).

## Verification commands (every task)

```bash
npx tsc --noEmit                 # expect: no output, exit 0
npx vitest run                   # expect: 1114 passed | 3 skipped (or higher)
npm run build                    # expect: dist/index.js builds
git status --short               # expect: only the task's files
```

## Risk notes

- **Bundle identity:** esbuild bundles index.ts + src/ — moved code must
  import the SAME `cache` object; a second state copy reintroduces the
  double-bundle bugs the cache manager guards against.
- **`let cfg` swap:** index.ts reassigns `cfg` on resync; extracted modules
  must never capture a stale reference — pass a getter or the swap hook.
- **Log strings are contract:** Achim's live log verification greps for
  router.log wording; keep every routerLog string byte-identical.
- **Test hermeticity:** tests import `../index.ts` and drive session_start —
  they cover the wiring end-to-end and are the primary safety net; a task
  that only makes the suite green but changes observable behavior (logs,
  command output, config file format) is NOT done.

## Out of scope

- No renaming of tools/commands/flags, no config key changes, no
  performance work, no feature work (Phase B session-quality demotion and
  ADR-0018 HINT repair remain separate).
- No public-API or package-structure changes beyond new src/ files.
