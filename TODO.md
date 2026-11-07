# 🚀 pi-model-dynamic-router - Current Tasks & Roadmap

> **Status**: Updated with cascading fallback, group-based cost/quality routing, model momentum, and status line integration
> **Last Updated**: August 2026
> **Current State**: ✅ All critical fixes implemented and verified

## 📌 **IMPORTANT RULES**

### Documentation Language
- **ALL documentation MUST be in English** - This includes:
  - Code comments
  - JSDoc comments
  - Markdown files (README.md, TODO.md, etc.)
  - Commit messages
  - Type definitions and interfaces
- **Rationale**: International project, English is the lingua franca of development
- **Exception**: None - all German comments/documentation must be translated to English

---

## 🎯 **Prioritized Tasks (Next Steps)**

### 🟡 **Lint burn-down (gate shipped 2026-11-04, baseline open)**

The gate is live (`npm run lint`, step in the required `test` job,
`docs/plans/2026-11-04-lint-gate.md`). Baseline: **732 findings / 121 (file, rule)
entries** (was 1217 / 299; S3 took it to 919 / 159, the
Prettier reformat to 915, S4 to 810 / 130, S4 factory interfaces to 803 / 123,
the sessionCtx typing in the PR #120 review round to 732 / 121). Each slice lowers
`scripts/lint-baseline.json` **and** `CEILING_FINDINGS` in
`test/lint-baseline.test.ts` in the same commit:

- [x] **S1** cheap real defects — done 2026-11-04: `no-empty` (10 documented
      swallows), `prefer-const`, `no-useless-assignment`, `preserve-caught-error`
      (`{ cause }` on three rethrows), `no-control-regex` (two documented
      directives — ESLint 10 removed the rule's `allow` option),
      `no-unused-vars` (79: dead imports/state in `src/`, unused test fixtures),
      `no-regex-spaces`, `require-yield`, `no-useless-escape`,
      `no-irregular-whitespace`
- [x] **S2** real bug classes — done 2026-11-04. `no-floating-promises` found a
      real hang: `driveStream` was started fire-and-forget by three callers and
      had no outer guard, so a throw outside the candidate loop became an
      unhandled rejection AND left the proxy without a terminal event
      (`test/drive-stream-never-rejects.test.ts`). Also: `require-await` (8, the
      handler/tool contracts allow sync bodies), `no-base-to-string` (new
      `textOf()` helper), `restrict-template-expressions`,
      `no-redundant-type-constituents`
- [x] **S3** `prefer-nullish-coalescing` + `prefer-optional-chain` — done
      2026-11-05. `prefer-nullish-coalescing`: 32 findings → 0 in the baseline.
      9 `||` sites are kept on purpose, each with a one-line
      `eslint-disable-next-line` and its reason (an empty string must fall
      through; a `false` from `includes()` must still reach the provider-rule
      check). The rest were converted to `??`/`??=`. (The earlier "18 converted /
      14 kept" split did not match the tree; the directive count is the
      checkable number.) The 4 `prefer-optional-chain` findings became the
      existing `invokedDirectly()` helper in five scripts. Baseline
      955 → 919 findings, 183 → 159 entries. The `no-unnecessary-type-assertion`
      part was already burned down by the `--fix` run in the S1+S2 commit
      One conversion is not behaviour-neutral and is noted here: `fuzzyMatch ?? null`
      in `src/utils.ts` differs from `||` only for an empty-string ref, which no
      caller reaches in practice.
- [x] **S4** `explicit-function-return-type` — done: 105 of 116 annotated
      (TypeScript-checker-driven codemod); the remaining 11 were baselined — 7
      factory functions whose inferred return type is a 100+ char inline object
      (now named: `ContextUtils`, `FreeModelRegistration`, `LimitGlue`,
      `ModelResolveGlue`, `ScanRunner`, `StreamProxy`, `WalkGroupSummary`) and 4 whose
      honest type is `any` (still baselined) (S5 territory: `sessionCtx` getter, `readJson`,
      `hasConfiguredAuth`, `createGroupRegistration`). Owner decision D3: keep
      and burn down, explicit return types are treated as an API contract
- [ ] **S5** long tail (~732): `no-explicit-any` + the `no-unsafe-*` family,
      per-file slices. May never reach zero; the ratchet only requires it never
      grows.

Note: keeping ESLint keeps the dev-only `minimatch` alert
(CVE-2026-118764) open until ESLint 11 / typescript-eslint / Stryker move to
minimatch 11 (see the dependency-security round below).

### 🔴 **Post-merge review 2026-11-04 — open items (owner decisions)**

Independent review of `38d2a27..fde54f8` (the structural question behind most of these — should the router keep its own turn-state machine at all? — is `docs/plans/2026-11-04-virtual-models-routing.md`; mapping of every item in `docs/research/2026-11-04-virtual-models-fit.md`). Critical C1/C2 and Important I1, I2 (suppression), I6 are fixed on `fix/subcall-scope-async-local`). What remains needs a decision, each as its own plan (§11), none of it blocks the fix:

- **I3 — a tool follow-up falls back to `simple` whatever the turn's group is** — plan `docs/plans/2026-11-07-tool-follow-up-group.md` (first registered 2026-10-25; `stream-orchestrator.ts` `isToolFollowUp`: `[lastDynamicModel, ...simple candidates]`). A planning/design/code_complex run whose driver hits one 429 or stall degrades to cheap/free models for the rest of the agent run and stays there after the driver's cooldown. Implemented and merged 2026-11-07 (PR #120): the run's driver and group are remembered at classification and at a HINT pin; follow-up order = driver (once cooled down), current ref, the run group's candidates, that group's `fallback_groups`; with tools in the context free-tier models are skipped (fail-open) unless the run group is `simple`.
- [x] **I4 — tool-call markup emitted as text counted as a good answer** — FIXED
      2026-11-05 (`test/tool-markup-as-text.test.ts`). It happened again live on
      2026-11-05 10:53–10:54Z: `openrouter/openrouter/free` served ten
      consecutive turns with `stopReason: toolUse` and 0–3 chars, printing
      `<dots_function_call>…</dots_function_call>` as prose, and `recordOk`
      rewarded it. `consumeWithDetection` now holds the answer's opening (200
      chars) whenever the request carries tools and drops it as a soft failure
      (`reason: 'tool_markup_as_text'`) when the stream ends with no tool-call
      event and the held text opens with a wire marker
      (`isToolCallMarkupText` in `src/detection.ts` — format markers only,
      including the generic `<*_function_call>` shape, never model names). The
      hold ends at a real tool-call event or when the window fills, so a
      healthy stream pays at most 200 chars of latency. Format markers cannot
      identify the model, so the user-layer `non_agent_model_prefixes` still
      has to carry the family judgement: `free` was added there on 2026-11-05
      (it matches only the `openrouter/openrouter/free` meta-router, not the
      `…:free` variants).
- **I5 — compaction continuity trusts any "large" last model** (`content-classifier.ts`) — plan `docs/plans/2026-11-07-compaction-continuity.md` (implemented and merged 2026-11-07, PR #120): the decision now uses the real context window via the reserve-aware `planOutputBudget`, fail-closed on unknown windows, with `:free`/meta-router refs excluded.
- **I2 remainder / M1 — turn state is per process, not per session** — plan `docs/plans/2026-11-07-session-keyed-turn-state.md` (implemented and merged 2026-11-07, PR #120). Subagent sessions in the same process share `lastDynamicModel`/`curModel`; clearing `lastDynamicModel` on `session_shutdown` would let a child wipe the parent's turn model, so it was NOT done. Needs per-session turn state.
- **M3 — turn latency includes tool and sub-call time** — plan
  `docs/plans/2026-11-07-turn-latency-tool-time.md` (owner go 2026-11-07,
  approved, not started): `turn_end` books the whole turn
  (`Date.now() - rt.turnStart`, `src/event-handlers.ts:303`) as the model's
  latency sample, so tool/sub-call time inflates `avg_latency_ms` and deflates
  `throughput_tps`/`benchmarks`, which the ranking reads. Fix per the plan:
  measure the stream, not the turn.
- [x] **C2 data — RESOLVED 2026-11-07 (owner): no reset.** Benchmarks/health/
  breaker values written for reader models before the fix decay via EMA and the
  health windows; intervene only if a reader model ranks oddly.

### ✅ **Categories and groups did not line up — CLOSED 2026-11-02 (five-group layout shipped)**

7 categories against 13 groups, names pointing at the wrong category, 5
groups no category reached. Resolved by the five-group layout
(`docs/plans/2026-10-25-category-group-mismatch.md`, merged to `main` in
#81): each category now selects the group of the same name, and the shipped
`router-config.json` has exactly the groups the categories reach.

### 🔎 **Open (2026-10-25): "fallback" naming (code smell)**

"fallback" names six different things (group, failover cascade, classifier
candidates, decision-log stage, retired category, stream retry). Plan:
`docs/plans/2026-10-25-fallback-naming.md`.

### ✅ **Compaction reason text named the wrong group — CLOSED 2026-11-02 (already fixed)**

`classifyPromptUncounted` (`src/content-classifier.ts`) returned
`category: 'code_complex'` with the reason "routing to strategic". Both the
category and the text now agree with the five-group layout: the branch
returns `code_complex` with "Compaction — routing to code_complex for large
context window" (and "... last model is in cooldown, routing to code_complex"
for the cooldown case, lines 733-734). Verified by grep on 2026-11-02, no
code change needed.

### 🔍 **Open (2026-10-25): tool follow-up steps fail over into the free pool**

Same problem as review item I3 below, kept as ONE entry there (measured now:
the 2026-11-03 incident is the live case). Structural answer proposed in
`docs/plans/2026-11-04-virtual-models-routing.md`.

The spike is done and the decision is made 2026-11-07 (owner: **no
migration**, merged in PR #119; re-evaluation trigger on Pi host upgrades,
see `docs/plans/2026-11-04-virtual-models-routing.md`). Measured on real
turns 2026-10-28..2026-11-06 (corrected figures — the report now classifies
every failure of a turn, not only the first; `docs/research/2026-11-06-virtual-model-spike.md`
§2): 93 turns, 68 (73.1 %) finished unchanged, 9 (9.7 %) recovered through
Pi's retry, 16 (17.2 %) lost — 15 because Pi treats a `Claude quota exceeded`
429 body as final, 1 a mid-chain empty response Pi is blind to. Pi also has
no stall detection and does not retry a well-formed empty response, so the
in-request failover stays. The turn-state problems (I2/M1, I3, I5) are fixed
in the current design (PR #120).

### ✅ **`delegation.expensive_groups` omitted `planning` — CLOSED 2026-11-02 (already fixed)**

The shipped `router-config.json` now lists `["planning", "code_complex"]`,
so the read block covers `planning` explicitly instead of relying on a
model overlap with a group that no longer exists. Verified against the
shipped config on 2026-11-02, no code change needed.

### 🔎 **Open (2026-10-31): felt quality does not match the benchmark ranking**

Owner observation, not a measurement: working with an explicit `HINT` on the
newest Fable and on Opus, the difference to the models the groups pick is
clearly noticeable, although the benchmark columns the ranking sorts by
(GDPval, Briefcase) do not show it. The ranking therefore cannot express what
the owner experiences. Open question: how does felt quality enter the ranking
(e.g. owner ratings per model and task type, collected like the Laya live
labels) without model names in shipped code (AGENTS.md §9; the user layer is
allowed)? Needs its own plan (§11) once the owner wants it. Related facts: the
user layer excludes the older Fable for its token consumption, Opus/Sonnet 5.5
are back in because they are frugal, and the newest Fable has no consumption
measurement yet (zero turns in the session files). It also inherits the older
Fable's GDPval value by fuzzy slug match (a borrowed value, not a measured one).

### ✅ **A1 — Shared group-candidate filters (DONE 2026-08-23)**

`applyGroupFilters(refs, g, cfg, dedup?, dedupFn?)` in `src/routing.ts` is the
single source of truth for the method-independent filter pipeline:
exclude_providers, exclude_models, min_gdpval/pct, max_cost, max_cost_per_m.

- **`resolveGroup`** (live selection) and **`getTopModels`** (display) both
  call it — the display path no longer diverges (the old display path dropped
  ALL unknown-cost models, so `/router` showed models the live path kept —
  now billing-aware: subscription/local = sunk cost = kept, payg = dropped).
- **`generateDynamicConfig`** (persist) deliberately does NOT use it: its
  `max_cost`/`max_cost_per_m` semantics diverge (`max_cost=0` groups admit
  ONLY genuine $0 free models, excluding subscription models that cost real
  money). Documented inline. Only the truly shared bits (exclude, min_gdpval)
  match in spirit.
- **min_gdpval <= 0** = "no gate" (unscored models pass); **strict positive**
  threshold drops unscored models (`lookupGdp null`). This is the fix for the
  13/148-style collapse where unscored models leaked past the gate via the
  old `filterByQualityMin` `return filtered.length ? filtered : refs` fallback
  (that fallback was removed — it was error-masking, not a feature).
- Tests: `test/apply-group-filters.test.ts` (12), updated 8 driveStream tests
  to set `min_gdpval: 0` explicitly (they relied on the old fallback).

### ✅ **F1 — Ollama module cleanup (DONE 2026-08-24)**

Removed dead `estimateOllamaModelsGdpval` (non-slug variant) export from
`src/ollama-gdpval.ts` — nothing consumed it, only
`estimateOllamaModelsGdpvalAsSlugs` is wired into the cache. Evaluated
consolidating the three Ollama modules (`ollama-gdpval.ts`,
`ollama-context.ts`, `ollama-utils.ts`) and declined: distinct concerns
(pure scoring math / context-window resolution / live HTTP client), distinct
consumers. Documented the decision in each file header instead.

### ✅ **A2 — Single GDPval resolution pipeline (DONE 2026-08-24)**

`src/metrics.ts` is now the sole owner of GDPval resolution, documented as a
file-header block answering two questions: **Q1** "which slug does a ref
mean?" (`resolveSlug`: model-map.yaml → LLM-assisted match → algorithmic
fuzzy matcher) and **Q2** "what score does that slug have?" (`lookupGdp`:
`gdpval_builtin` wins, merged additively over `cache.gdpval_scores`,
self-healing against `setGdpval()`'s replace-semantics wipe). Removed a
dead, drifted duplicate pipeline in `src/model-matcher.ts`
(`resolveModelScores`/etc.) that was never called from `index.ts`. Fixed a
same-scan visibility gap: newly-discovered Ollama models are now visible to
`generateDynamicConfig()` within the same scan cycle via a `setCache()`
resync.

### ✅ **F3 — German→English comment translation (DONE 2026-08-24)**

All German prose comments in `index.ts` translated to English (1:1, no code
changes). `Ü1`/similar short code-names kept as-is (project shorthand, not
prose).

### ✅ **C1 — index.ts oversized-function extraction (DONE 2026-08-24)**

`index.ts`: 3583 → 3254 lines (-329, -9.2%), pure code motion. Extracted
`src/dynamic-config.ts` (pure computational core of `generateDynamicConfig`:
filter/sort/collect/fallback-group logic) and `src/stream-driver.ts`
(`pushStreamError`/`buildErrorAssistantMessage`, the zero-cost error-envelope
boilerplate duplicated 6x across `driveStream`/`groupStream`, plus
`isExpectedTransientError`). `groupStream`'s HINT model-target resolution
(~130 lines) was intentionally left in place — too entangled with mutable
session state to extract safely in this pass.

### ✅ **"Context-size mismatch on model switch breaks compaction" — was already fixed, not a new fix (verified 2026-08-26)**

This bug (previously listed under Open Issues, observed 2026-07-27) was already
resolved by v1.3.1 (`0506abb`, 2026-08-14) and the driveStream reliability pass
(`16a8f89`, 2026-08-16) — the TODO entry just never got updated. `driveStream`'s
context-window guard (`index.ts`, near `getModelContextWindow`) pre-emptively
skips any candidate whose `contextWindow` is smaller than the estimated
conversation size, for every switch path (fallback cascade, HINT override,
dynamic classification — they all funnel through the same `driveStream` loop).
If every candidate in the cascade is skipped for that reason, the router emits
a synthetic "prompt is too long" error matching the pattern Pi's
`isContextOverflow()` recognises, so Pi's native compaction fires instead of
the session hanging. Because the router never calls `pi.setModel()` for group
routing, Pi's own compaction call re-enters the router's virtual group
provider too, so the summarization call itself benefits from the same guard.
Regression tests: `test/context-overflow.test.ts` (3 cases: total skip →
compaction signal, non-overflow failures still walk the normal cascade,
a fallback group with enough room is tried before signalling overflow).

### ✅ **`resolve()` "→ none" for dynamic groups — code-quality fix (DONE 2026-08-26)**

`resolve()` returning `null` for `method: 'dynamic'` groups is intentional
(documented invariant in `src/routing.ts`: the classifier hook resolves those
per-prompt, not `resolve()`) — not a bug to fix. The actual rough edge was
cosmetic: `registerGroupProviders()` called `resolve()` anyway for display
purposes, showing the misleading `"dynamic → none"` in Pi's model picker. Now
dynamic-method groups skip the call entirely and show `"dynamic →
auto-classify"` instead. Also improved the log line when a HINT targets the
dynamic group itself (`HINT: use group dynamic`) — previously logged as
"group not found" (implying a typo), now explicitly notes it falls through to
normal classification. Tests: `test/register-group-providers-label.test.ts`.

### 🔥 **Immediately Actionable** (Quick Wins - 1-2 hours)

#### ✅ D2 — Shared logger (DONE 2026-08-23)

`src/logger.ts` is the SINGLE source of truth for router log output:
`routerLog`, `writeLogLine`, `appendRawLog`, `setProjectLogDir`. `index.ts`
re-imports them (no longer defines them locally). All four `src/` modules
that used `console.*` now route through `routerLog`:
- `content-classifier.ts` (11 → 0)
- `cost-tracker.ts` (6 → 0, still gated by `DEBUG_COST_TRACKER`)
- `escalation.ts` (4 → 0)
- `metrics.ts` (1 → 0)

Why: `console.*` bypasses Pi's TUI (`ctx.ui.notify`) and can land in the
user's input field, corrupting the prompt. The file logger writes to both
`~/.pi/logs/router.log` and the project-local `.pi/logs/router.log` — never
to stdout/stderr. Tests: `test/cost-tracker.test.ts` updated to assert
`routerLog` is called and `console.*` is NOT (the D2 goal).

#### Code Quality & Maintenance
- [x] **Test coverage floor + CI enforcement (DONE 2026-08-26)** — actual
  coverage was 67.7% overall (not the ~80% previously claimed here — that
  number was never measured, just aspirational). Raised to 70.5% by adding
  real unit tests for `src/dynamic-config.ts` (9.7% → 85.7%; it was extracted
  in C1 specifically to be unit-testable but shipped without tests) and
  replacing a pre-existing `test/dynamic-config.test.ts` that never actually
  imported the module under test (it mocked `metrics.ts` and reimplemented
  the sort/filter logic inline, asserting against itself — zero real
  regression coverage despite the misleading name). Added `coverage.thresholds`
  to `vitest.config.ts` (68% stmts/funcs/lines, 78% branches — a few points
  below the measured baseline) so `npm run test:coverage` fails the build on
  a real regression instead of coverage silently drifting down again. Raise
  these thresholds as coverage improves; don't lower them to unblock a red CI
  run without fixing the actual regression.
- [x] **Audit other roborev-findings test files for the same tautological-test
  pattern found in the old `dynamic-config.test.ts` (DONE 2026-08-28)** —
  swept all 58 test files for (a) `vi.mock()` targeting the module under
  test itself (only legitimate dependency mocks found: `ollama-utils`,
  `metrics`, `logger`, `discovery`, `node:os` — never the tested module), and
  (b) locally-reimplemented business logic asserted against itself (only
  hit was `refactor-golden-master.test.ts`'s `makeRouter()`, which
  constructs a real `Router` and calls real methods — legitimate test
  setup, not a reimplementation). No other instances of the anti-pattern
  found; the `dynamic-config.test.ts` fix from that review pass was the only
  occurrence.
- [x] **Improve mock data for unit tests / Add performance tests (CLOSED —
  not pursued, 2026-08-28)** — too vague to act on without a concrete
  failing scenario; would produce busywork with no tied regression. Revisit
  if a specific gap surfaces.

#### Build & Deployment
- [x] **CI pipeline runs tsc + coverage (with enforced thresholds) + build on
  every push/PR to main (DONE 2026-08-26)** — `.github/workflows/test.yml`
  now also runs `npm run build` after tests, so a broken esbuild bundle (not
  caught by `tsc --noEmit` alone) fails CI too.
- [x] **Optimize build process (CLOSED — not a real problem, 2026-08-28)** —
  measured: 5.6s total (`tsc` type-check + esbuild bundle), esbuild bundling
  itself is 101ms. Not worth chasing.

---

## 🚀 **Medium-term Improvements** (1-3 days)

### Locale Robustness (date/reset-time parsing)
- [x] **Multi-locale month-name parsing — DONE 2026-10-08 (owner: “international, best case”)** — `src/detection.ts`
  currently recognizes only German month names ("Okt.", "März" …), because
  we render our own reset messages with `de-DE` locale and parse them
  back. Provider messages and foreign-locale systems produce English
  ("Oct 4th, 12:37 PM") or other locales. Owner decision: keep the
  deliberately German-readable log AND make the parser robust — explicit
  month tables for at least en-US + en-GB + de-DE (short and full forms,
  with/without trailing dot), plus a regression test per locale. Small
  extension, registered 2026-10-04. Implemented with en-US (12-hour clock,
  `GMT±N` zone tokens), en-GB and de-DE in short and long form; zone-less
  texts ("Oct 4th, 12:37 PM") deliberately stay unparsed (guessing the zone
  is the unsafe direction), ambiguous US abbreviations too.

### Resilience & Fallback Strategies
- [x] ~~Implement caching for classification~~ DONE in v1.5.0 (LRU+TTL, `test/classification-cache.test.ts`)
- [x] ~~Add batch processing - Parallelize classification requests~~ DROPPED
  2026-11-06: there is exactly one classification per turn (plus the
  classification cache), so there is nothing to batch or parallelize.
- [x] ~~Optimize model selection - Evaluate smaller models for
  classification~~ DONE 2026-10-07 via ADR-0025 Phase C (PR #50): the local
  classifier chain is DERIVED from the scan, ordered smallest-first — the
  probed chain prefers the smallest schema-capable local model, with a
  24 h re-probe; no hardcoded pick remains.

### Extended Classification
- [x] ~~Add more categories - More specific distinction~~ SUPERSEDED
  2026-11-06: the v2 taxonomy and the five-group layout fixed the category
  set (`docs/plans/2026-10-25-category-group-mismatch.md`); a new category
  is a taxonomy decision, not an open task.
- [x] ~~Pinned continuation does not update the category memory~~ FIXED 2026-11-06
  (`fix/pinned-turn-category-memory`, red-first in `test/orchestrator-hint-wiring.test.ts`,
  `test/strip-hint-head.test.ts`). Original report (found 2026-10-22,
  code read, not yet reproduced live). A `HINT:` model pin bypasses the
  classifier, so the turn returns no `category`, and
  `lastClassifiedCategory` (`src/stream-orchestrator.ts:419`) keeps the value
  from before the pin. A following unpinned "weiter" then inherits a stale
  category. Routing of the pinned turn itself is unaffected (the pin decides
  the model); only the next turn's category and the calibration label are
  wrong. Planned fix: a pinned turn classifies its content, but keeps the
  model pin, and writes its category to the memory. Needs a red-first test.
  Background: `docs/research/2026-10-22-hint-category-signal.md`.
- [ ] **Use explicit HINT pins as owner category labels** (research, 2026-10-22).
  Hand-labelled, 96 unique pinned prompts in the local session logs: code_complex 67,
  planning 11, continue 9, design 5, simple 2, standard 2. A Sonnet pin mostly
  means code_complex, but not always (4 of 33 are continuations). An Opus pin
  is planning in 5 of 12 cases, code_complex in 7 (plan checks count as
  code_complex under the taxonomy). The 4 Haiku pins are not enough to
  support "Haiku = simple". Pins are NOT a routing rule; they are a
  label source for calibration. Open: keep labels separate from model
  predictions (`owner_label` field) and decide the category handling of
  "plan check" (taxonomy says code_complex).
- [x] **Context-based classification (partially done, 2026-08-29)** — the
  classifier already accepted `lastCategory` (short-prompt momentum: "yes",
  "do it", "mach das" inherit the prior task's category) and
  `previousUserMessage` (fed into the LLM's context block) in its type, but
  the real call site in `index.ts` never populated either field — both were
  silently `undefined`, so momentum never fired outside of unit tests that
  set them directly. Fixed: `index.ts` now tracks `lastClassifiedCategory`
  as session state (mirrors the existing `lastDynamicModel` pattern) and
  extracts the previous user message via a new `extractPreviousUserMessage()`
  helper. Regression test:
  `test/dynamic-classification-momentum.test.ts` (drives two real turns
  through `groupStream()`, asserts the LLM classifier is called once, not
  twice, on a short follow-up, and that the previous user message shows up
  in the LLM prompt on the next real classification call). Still open:
  going beyond a single previous turn (e.g. rolling session summary) — not
  pursued, no concrete need identified yet.

### Code Quality
- [x] **Refactor resolveGroup() and getTopModels()** - DONE as A1 (see above): both call `applyGroupFilters()` in `src/routing.ts`
- [x] **`resolve()` returns null for dynamic groups** — intentional (see the
  `✅ resolve() "→ none" for dynamic groups` entry above, DONE 2026-08-26),
  not a bug. Cross-referenced here to stop it resurfacing as "open".
- [x] ~~Improve error handling - Better error messages and recovery~~
  DROPPED 2026-11-06: no concrete defect named. Concrete error-handling work
  is tracked where it was found (mutation triage, provider breaker, the
  never-rejects contract of `driveStream`).
- [x] ~~Add more unit tests - Increase coverage for edge cases~~ DONE
  2026-10-07 via the Nightly R1 mutation triage: the edge cases the suite
  was missing ARE what mutation survivors pointed at — +152 tests now pin
  gate boundaries, comparator permutations, pricing fallbacks, usage
  windows and the turn pin (docs/mutation-triage.md, Finding 2).

---

## 🌟 **Long-term Features** (1-2 weeks)

### Extended Provider Management
- [x] ~~Add more providers / Improve provider detection~~ SUPERSEDED
  2026-11-06: the router never registers models Pi does not know (ADR-0021,
  AGENTS.md §6) — the provider and model inventory is Pi's registry; the
  router only enriches what Pi already resolves.

### Intelligent Routing
- [ ] **Multi-label classification** - Assign multiple categories to a single prompt (needs an ADR before implementation)
  - *Idea*: Allow prompts to match multiple categories (e.g., "code_simple" + "explanation")
  - *Benefit*: More accurate model selection based on combined requirements
- [ ] **Implement learning from user feedback** - Improve classification based on corrections (needs an ADR before implementation)
- [x] **Add user-specific configurations (already built, closed 2026-08-29)**
  — `src/config-loader.ts`'s layered config already does exactly this:
  embedded defaults → `~/.pi/agent/router-config.user.json` (global user
  overrides) → `<cwd>/.pi/router-config.json` (per-project overrides), deep-
  merged. This IS "personalized model preferences" — the TODO predated it
  and was never updated.

### ✅ Intelligent Failure Management (already built, TODO was stale — closed 2026-08-28)

This section described functionality that was already fully implemented in
`src/rate-limit.ts`'s `RateLimitManager`, just under different names than
what this TODO originally envisioned:

- [x] **recordFailure(model, reason)** → `recordLimit(ref, providerKeys)` (hard:
  rate-limit/auth, with key rotation) + `recordSoftFailure(ref)` (soft:
  timeout/empty response) — reason-differentiated exactly as planned.
- [x] **recordSuccess(model)** → `recordOk(ref)` resets the hit counter.
- [x] **Temporary blacklist** → the cooldown ladder (`cooldown_until` per ref)
  IS the blacklist; a limited ref is filtered out of candidates until it
  expires.
- [x] **Cooldown period, exponential backoff** → `backoff_minutes: [1, 2, 4,
  8, 16, 32, 64, 90]` (hard failures) and `soft_backoff_ms: [30s, 60s, 120s,
  300s]` (soft failures) in `router-defaults.yaml` — a real escalation
  ladder, not a fixed cooldown.
- [x] **Integration in resolveGroup()** → `src/routing.ts:837` already does
  `c.filter((ref) => !this.isLimited(ref))`.

Tests: `test/rate-limit-cooldown.test.ts`, `test/cooldown-collapse.test.ts`.
Not pursued further: a *separate* hard-blacklist ("after N failures, sperren
24h regardless of ladder expiry") was considered and explicitly declined —
the existing ladder already caps at 90min and resets on success, which was
judged sufficient.

### Integration & Extensibility
- [ ] **Create plugin system** - Extensible architecture for new features
- [ ] **Add webhook support** - Notifications for model changes

---

## 📊 **Technical Debt**

### Low Priority
- [x] ~~Clean up archive directory~~ DONE: no root `archive/` exists in the
  checkout (checked 2026-11-06). The hygiene plan listed that git-ignored
  leftover for an owner decision (`docs/plans/2026-10-29-repo-hygiene.md`,
  Phase 1 Step 3); `docs/archive/` is the deliberate, versioned history
  location and stays.
- [x] ~~Update dependencies~~ standing process, not a task: Dependabot plus
  the per-alert evaluation rule (AGENTS.md §10); open alerts are tracked in
  this file's dependency section.

### Medium Priority
- [x] ~~Clean up test files - Remove redundant tests~~ DONE via repo hygiene
  phases 4-5 and the fixture-dedupe rounds; kept that way by the redundancy
  ratchet (`scripts/redundancy-report.ts`, `test/redundancy-baseline.test.ts`).
- [x] ~~Improve documentation - Add more examples and use cases~~ DROPPED
  2026-11-06: no concrete gap named. The redundancy report's removed-group
  name check and its plan-index check guard the docs against stale content.

---

## 🔭 **Future Tasks (registered)**

### Post-spike-merge mutation triage: classification/HINT region in stream-orchestrator (OWNER-MANDATED 2026-10-15 — do this first after laya-spike merges to main)

> **Status 2026-11-06:** slice 1 done (257/272 killed, 15 equivalent). Slice 2
> (`driveStream`) triaged 2026-11-05: of 329 non-killed mutants, 205 REAL GAP
> (sketches in `docs/mutation-data/slice2-triage/`), 118 EQUIVALENT, 1 false
> survivor, 1 dead store removed. The slice-2 test round started 2026-11-06:
> cascade head / overflow / breaker-probe gate, the collapse guard+duration+
> tie-break+signal cases, the pre-flight skip reasons and the post-wait retry
> block are pinned (34 mutants verified killed, see
> `docs/mutation-triage.md`); the repetition/truncation narrations, the paid
> labels and the recorded-state seams are still open. Then slice 3 (helpers).
> Plan: `docs/plans/2026-11-04-orchestrator-mutation-triage.md`.

Baseline (nightly runs 38537058246 + 38704671387, both main @ 6f4ac08, i.e.
the first nightly with the v2-r3 taxonomy): 3-file scope (stream-orchestrator,
metrics, routing), 2784 mutants, score **69.94 %** — 1947 killed / 573
survived / 264 no-coverage. Two consecutive nightlies are identical (+1 kill),
so the picture is stable.

**85 % of all undetected mutants sit in `src/stream-orchestrator.ts` (710)**,
concentrated in the classification/HINT region that v2-r3 rewrote
(line numbers for main @ 6f4ac08 — re-locate against the fresh report):

- classifyOpts context build (L401 region, 17 survived): lastCategory,
  lastModel, isCompaction, lastModelLimited wiring
- HINT alias matching, `namesMatch` over `allDiscoveredRefs()` (L476, 26
  survived) and the documented B3 follow-up clusters L465/L549
  (dynamic-HINT match)
- hint-not-found fallback cascade, including explicit-hint `clearLimit` and
  registry/provider lookups (L520–570, ~120 no-coverage)
- escalation gate after normal classification (L576+, ~32 undetected)
- plus B3 follow-up: breaker-dead-end wait guard (L1107)

The v2-r3 pin tests cover the classifier itself, but **no test drives the
orchestrator wiring mutation-lethally** — the most consequential selection
code in the router has the weakest mutation coverage. Round shape: red-first
tests around the orchestrator integration surface (classifyOpts context,
HINT resolution, hint-not-found cascade), mutant-by-mutant verification via
`scripts/mutation-recheck.ts`, verdicts ledgered in `docs/mutation-triage.md`.

**Why after the spike merge:** the laya-spike branch (prev logging,
output-budget guard) shifts stream-orchestrator line numbers, so today's
mutant references go stale. Re-run the nightly on merged main first, triage
against the fresh report, use the regions above as orientation.

**Owner decision 2026-10-15 (exit-cost rule):** laya-spike does NOT merge to
main while the Laya verdict is open — if Laya fails, it gets removed entirely
rather than un-merged later. So this round triggers in EITHER ending:
(a) Laya succeeds -> spike merge, or (b) Laya is dropped -> the non-Laya
orchestrator changes (output-budget guard, prev logging) are cherry-picked
to main first. In both cases: fresh nightly on the updated main, then triage.

metrics.ts (73) and routing.ts (54) remainders are low priority — after
batches 1–4 these look mostly like equivalents (slug/GDPval matching, group
constant lists, round-robin fields); confirm before spending a round.

---

### Periodic mutation-testing audit of the suite
A vacuous test (assert-true equivalent) is invisible to green runs — only
breaking the code it claims to cover reveals it. Hand-rolled spot campaign
2026-10-04: 9 core invariants mutated one at a time (calculateScore column
branch, min_gdpval floor, best_quality_window, demoteUnhealthy, effCost,
extractCapabilityProfiles, recordSoftFailure, sortBy-best scoreOf,
isFreeModelRef) — **9/9 killed**, minimum 2 killers each (isFreeModelRef:
88). Remaining risk: contract-change vacuance (a test's inputs never
reaching a new path — the calculate-score incident) cannot be caught
statically; the red-first rule (AGENTS.md §4, hard requirement since
2026-10-04) is the only guard at the moment of change.

**Phased StrykerJS decision (2026-10-04):**
- Phase 0 DONE: red-first in §4; `scripts/mutation-spot-campaign.sh`
  (repeatable, dirty-worktree guard, self-reverting; baseline 9/9 killed).
- Phase 1 (needs owner go): StrykerJS trial on the decision core ONLY
  (`src/metrics.ts` + `src/routing.ts`). Measure before extending: mutant
  count, wall time (est. thousands of mutants x coverage-selected test
  runs), equivalent-mutant triage load, and REAL findings yield.
- Phase 2 (go/no-go gate): extend suite-wide (or run nightly) only if
  Phase 1 finds genuine vacuity; if the yield is low and the triage tax
  high, stop at spot campaign + red-first. Rationale: the spot campaign
  found the suite alive (min 2 killers per invariant); a full campaign's
  value must beat its runtime + triage cost, not just exist.
- Phase 1 ACTIVATED (owner decision 2026-10-04, PR #19): nightly Stryker
  run on GitHub over the decision core, report-only. First local cold
  run measured 1670 mutants at ~75 min (aborted at 67%, 265 untriaged
  survivors — the baseline must come from CI). Open work once the first
  nightly report lands: triage the survivors (equivalent mutants vs real
  vacuity), then decide Phase 2 scope.
- Phase 1 first-report triage DONE (Nightly R1, 2026-10-07, run 37606222840,
  docs/mutation-triage.md): 435 undetected -> 254 real vacuity (58.4 %, all
  killed by +152 tests), 11 false survivors (2.5 %), 112 equivalent, 58
  dead/redundant (removed), 0 obsolete; projected score 75.6 -> ~93.5 %
  (re-measured by the next nightly).
  Phase 2 scope: owner go 2026-10-08 ("continue with mutation Phase 2")
  — executed: decision core kept as the 92.33 % healthy nightly; scope
  extended ONE module at a time to `src/stream-orchestrator.ts`
  (Nightly R3, LOCAL first report 2026-10-08: 31.5 %, 743 undetected =
  first-report baseline; 8/743 false survivors confirmed killed by the
  full suite, the rest uncovered coverage gaps to be closed over time;
  the first nightly with the extended scope produces the official artifact).
  B3 first slice DONE (2026-10-09): the cooldown-collapse retried-narration
  cluster (L1204 wait guard + L1262-1267 retried narrations, 17 of the 735
  gaps) is closed by test/cooldown-collapse-retried-narration.test.ts
  (3 red-first tests, mutants sabotage-verified) plus a vacuous-assertion
  fix in the existing rate-limit-wait collapse test. Remaining clusters
  for future rounds: the breaker-dead-end wait guard (L1107), the dynamic
  HINT match/start-group lines (L465/L549), and the identity mutants that
  need boundary scenarios — orchestration-surface harness, not
  mutant-by-mutant.
- Nightly R2 triage DONE (2026-10-08, run 37764383801, 92.33 % measured):
  132 undetected -> 111 equivalent (carried from R1), 12 recurring false
  survivors (perTest attribution; confirmed killed again), 4 real gaps
  (tested), 5 redundant (removed); projected ~93.5 %. New reports start
  with `scripts/mutation-carryover.ts`, then recheck, then triage.

**vitest 5 migration round (registered 2026-10-04, muted in Dependabot):**
UPDATE 2026-10-06: vitest is now on 4.1.11 (security round, see CHANGELOG) —
it passes the pinned coverage thresholds unchanged, so only the 4 -> 5 step
(the coverage-v8 5.x accounting below; the Node >= 22.12 requirement is met
since the package floor is node >= 22.19.0, 2026-11-04) is still open.
Dependabot proposed vitest 3.2.6 -> 5.0.3 (two majors, PRs #10/#13, both
closed). Red CI: coverage-v8 5.x counts branches differently and the run
lands at 74.27% against the pinned 76% threshold — AGENTS.md §4 forbids
lowering thresholds to unblock a red run. When this round is scheduled:
migrate the API surface, re-derive a JUSTIFIED branch threshold from the
new accounting (documented, not fitted to pass), and remove the
vitest-majors ignore in .github/dependabot.yml (guarded by
test/dependabot-config.test.ts).

**Host-pinned security alerts (evaluated 2026-10-06): RESOLVED** by the
host alignment round the same day: devDependencies pinned to
pi-coding-agent 1.0.4, which ships `undici` 8.10.2 and dropped the
`npm-shrinkwrap.json` that had made `overrides` impossible under 0.83.0
(overrides were ignored even on a fresh lock resolution). `npm audit` is
clean; the Dependabot alerts auto-close.

**Dependency-security round 2026-11-04 (per AGENTS.md section 10):**
- `qs` 6.16.0 -> 6.17.1 (PR #82, Dependabot, lockfile-only): dev-only via
  Stryker -> typed-rest-client, 0 bundle markers, CVE-2026-110816 needs
  attacker-controlled objects re-serialized with `arrayFormat: 'comma'` —
  not reachable; in-range lock refresh merged, alert auto-closed.
- `zod` 4.4.3 -> 4.6.7 (PR #92, lockfile-only): high (memory exhaustion on
  oversized constraints). The single dev-tree instance sat under Stryker's
  mutation-server-protocol 0.4.1 (zod `^4.1.12`) and, deduped, under
  @earendil-works/pi-ai -> @anthropic-ai/sdk 0.129.0 and openai 7.19.0;
  fix in range, refreshed. Full audit now: 0 prod, only the minimatch
  cascade left (12 moderate, dev-only).
- `minimatch` 10.2.6 (open Dependabot alert, medium, CVE-2026-118764,
  DoS via globparts amplification, patched only in 11.0.1): dev-only via
  eslint / typescript-eslint / Stryker. The pi host is NOT the blocker
  since 1.5.0: it ships minimatch 11.0.3 nested (patched). NOT REACHABLE
  (all consumers match our own repo-controlled globs, no attacker input)
  and BLOCKED: no fixed 10.x exists, and eslint (^10.2.4),
  typescript-eslint (^10.2.2) and Stryker (~10.2.4) keep the top-level copy
  on 10.x. An `overrides` force to 11 would be a major under three packages
  that do not declare support. `npm audit`'s suggested "fixes" are
  downgrades (eslint 9.39.5, typescript-eslint 6.15.0) — not applied per
  section 10. Re-evaluate when eslint / typescript-eslint / Stryker ship
  minimatch 11 support; the alert stays open as the tracker (dismissal
  needs the owner's go).

**Host-pinned undici alert — RESOLVED by the host (2026-11-04):** pi 1.5.0
pins undici 8.12.3 itself, so the `"overrides": { "undici": "8.12.2" }` from
the 2026-10-26 round is removed (overrides are the last resort under
AGENTS.md section 10). The lock-security guard now asserts that the top-level
undici equals the host's own pin. History of the 2026-10-26 round below.

**Host-pinned undici alert (evaluated 2026-10-26, PR fixing this repo's
tree):** Dependabot #48 (HIGH, CVE-2026-109869 — DoS via unhandled error on
excessive content-encodings, undici < 8.12.2). The vulnerable undici 8.10.2
is a DIRECT dependency of the host (@earendil-works/pi-coding-agent), and
even the latest host (1.4.0) still pins 8.10.2 — the fix cannot come from a
host bump yet. Dev-only scope here (0 bundle markers), exploit needs a
malicious provider endpoint answering with excessive content-encoding
headers. Applied `"overrides": { "undici": "8.12.2" }` (works since host
1.0.4 dropped its npm-shrinkwrap.json); the owner's globally installed
pi 1.4.0 still ships undici 8.10.2 until the host bumps upstream — surface
this upstream when convenient.

**Host pin drift (detected 2026-10-26, resolved by the alignment round the
same day):** repo devDependencies pinned @earendil-works/pi-coding-agent
1.0.4 while the installed host was `pi` 1.4.0 (latest). Alignment round done
per AGENTS.md section 10: devDependencies bumped to ^1.4.0 (pi-coding-agent,
pi-ai, pi-tui), undici override still effective (8.12.2). Findings: pi-ai
1.4.0 times terminal events inside `AssistantMessageEventStream.push()`
(done needs `message`, error needs `error`), which turned the router's
forwarding-exception swallow (catch → `return 'done'`, indistinguishable
from success) into a permanent consumer hang — fixed as a real soft failure
(`stream_threw`, test/forward-throw-terminates-stream.test.ts, red first);
38 stream fixtures updated to host-realistic terminal events. Reach-throughs
verified against the 1.4.0 host: `ModelRegistry.runtime.streamSimple` /
`completeSimple` still exist. tsc, suite (2110 passing / 3 skipped),
coverage (thresholds unchanged) and build all green.

**Host upgrade policy (pinned 2026-10-04, guarded by
test/dependabot-config.test.ts):** @earendil-works/pi-coding-agent is
never auto-bumped. Host upgrades are deliberate, planned rounds (see
docs/plans/2026-09-30-router-0.99.1-hardening.md); Dependabot PR #12
(pi 1.0.2, green CI proving nothing — the suite mocks most of pi) was
closed on exactly this ground.

### ⏸️ Deferred 2026-11-07 (owner: "do these later" — all registered, none started)

Recorded so nothing rots (AGENTS.md §7 escape: an explicit owner deferral).
Pick up in a later round, each as its own plan where noted (§11):

- **Laya sidecar distribution** (`docs/plans/2026-10-31-laya-sidecar-distribution.md`):
  open decisions 3 (where the sidecar lives: subdirectory with its own release
  vs. separate repo) and 4 (Python runtime acceptable for users vs.
  in-process `onnxruntime-node` — not yet evaluated; recommended first step is
  a small onnxruntime-node spike). Remaining steps: `/health` contract tests,
  ONNX conversion of `r2` + parity run, Linux/Windows latency, packaging with
  pinned revision + checksum.
- **Laya as sole classifier — open steps** (`docs/plans/2026-10-25-laya-sole-classifier.md`):
  live check after restart, disagreement labeling, timeout failure test,
  `continue` step, and whether the momentum observation (built, default off)
  gets enabled and evaluated. Laya stays in the data-reconciliation phase
  (owner 2026-11-07).
- **Felt quality vs. benchmark ranking** (2026-10-31 observation): needs its
  own plan — how owner ratings per model and task type enter the ranking
  (user layer, allowed per ADR-0025 §2C) without model names in shipped code.
- **Task-type balancing remainder** (`docs/plans/2026-10-05-task-type-balancing.md`):
  Phase 4 (provider budget pacing), 5b (cache-aware auto-compaction, opt-in),
  5d (compaction summary via a cheaper model, bulk_read thresholds). 5c stays
  deferred to a later 2.0.x by owner decision.
- **Release prep for 2.0.0** (owner 2026-11-07: target the next release as
  2.0.0; `package.json` is on `2.0.0-SNAPSHOT`): the §1 whole-range code review
  (requesting-code-review over v1.6.1..main), the `npm audit` summary in the
  report, the pi devDependency vs. installed-host check (AGENTS.md §10), the
  fallback-rename (V3) and M3 landing in 2.0.0. The release itself (tag /
  publish) is a separate explicit owner approval per AGENTS.md §1 — never
  implied by this list.

### Owner backlog (registered 2026-10-06, awaiting owner's go to start)

**No hardcoded models (ADR-0025)** — owner rule 2026-10-06: nothing shipped may
name a model that can admit, select, rank or exclude; everything derives from
what Pi uses, including the classifier flow. Plan with phases A–E (guard +
ratchet baseline, free_models / cost sentinels / exclusions out of the shipped
config, derived local classifier, `non_agent_model_prefixes` spike):
`docs/plans/2026-10-06-no-hardcoded-models.md`. Target line 1.7.0. **Phase A
DONE** (work-round 2026-10-07): AST scanner, ratcheting baseline guard (56
entries / 62 occurrences, ceiling-pinned) and class-B admission pins live.
**Phase B DONE** (merged 2026-10-07, PR #49): shipped
`free_models`, `model_metrics` sentinels, `exclude.models` and provider billing
removed — baseline 28 entries / 34 occurrences; the owner's
`router-config.user.json` needs the migration snippet from the CHANGELOG at
merge time (including deleting `router-config.dynamic.json` — removed
merge-key entries linger there). Phase B review follow-up (M3/I1, 2026-10-07) **DONE**
(branch `auto-prune-dynamic-config`): the dynamic-config resync records the
static layers' contribution (`_dynamic.static_contributions`) and prunes
entries they dropped — `providers.*.free_models` heals even on a pre-prune
file, but `model_metrics` sentinels of such a file (no provenance
recorded) stay until the dynamic file is deleted once. **Phases C–E DONE** (merged
2026-10-07, PR #50): derived local classifier chain
(`src/classifier-local-probe.ts`), `non_agent_model_prefixes` spike → outcome
(c), closure — **baseline 56 → 0 entries (62 → 0 occurrences), ceiling pinned
at 0**; the owner's `router-config.user.json` needs the
`non_agent_model_prefixes` snippet from the CHANGELOG at merge time. The
`model-map.yaml` guard-scope question is **RESOLVED 2026-10-07** (owner
decision): explicitly class B (annotation, never admitting), single
loader pinned by `test/model-map-class-b.test.ts`, ADR-0025 §2B updated —
no guard-scope extension. Still open: the final §1 whole-range review
before any release proposal.

**`/router config` command** — ✅ DONE (Phases 1–2):
`docs/plans/2026-10-06-router-config-command.md`. Implemented: `/router config` display (sources with origin, exclude rules with match counts), `/router config exclude <ref|glob>`, `/router config unexclude <ref|glob>` (user-layer only), `/router config compaction on|off` (Phase 5b stub). Writes to `router-config.user.json`; live exclusion applies immediately, persisted group lists regenerate at next scan cycle. Compaction flag gated on Phase 5b; un-exclude fully free after ADR-0025 B3 empties the shipped exclude list. Writes to `router-config.user.json` so changes survive the session but stay out of the shipped defaults.

Lane C follow-up — ✅ DONE 2026-10-08: a bare provider name now maps to `exclude.providers` (unknown bare names are rejected), see CHANGELOG.

**Cloud-provider wedge circuit breaker** — ✅ **DONE (Phases 1–4)**
(2026-10-07): core module + local parity (Phase 1), orchestrator wiring
with intra-walk short-circuit and never-dead-end forced probe (Phase 2),
narration + `/router` lines + counters + volatile state + `/router cooldowns
clear` (Phase 3), replay validation over the 6-day router.log — 0 false
trips, no trip on the Mistral 422 days, a trip on every bridge cascade,
172 avoided attempts — plus ADR-0026 (Phase 4). One generalized
local+cloud mechanism: evidence classification, distinct-model trip rule
(cloud 3 / local 2, 10-min window), cooldown ladder [2,5,15] min,
state under the `provider_breaker` cache key (volatile by policy,
`provider_breaker_stats` persists); `src/provider-watchdog.ts` is a shim
over it. Optional `provider_breaker` config with an `enabled` kill switch
for the cloud half. Original motivation: claude-bridge
prompt-capture/empty-response failures (P0.4) — a cloud provider that
wedges had no explicit "this whole provider is wedged" signal or
narration; the owner confirmed the idea 2026-10-06.

**`docs/plans/2026-10-05-task-type-balancing.md` remainder** — Phase 0, 1,
2, 3 and 5a are DONE (Phase 0, 1, 5a merged in PR #36; Phase 2, 3 in the
2026-10-07 work-round PR). Still open in that plan, each gated by the previous step or an
explicit owner decision: Phase 4 (optional provider budget pacing, needs
5a's cacheRead accounting — now available), 5b (cache-aware auto-compaction,
opt-in, builds on 5a's measurement), 5c (fresh-session suggestion — explicitly
deferred to a 2.0 version), 5d (compaction summary via a cheaper model,
bulk_read threshold review).

**Laya classifier integration** — full 9-task plan already committed:
`docs/plans/2026-10-05-laya-classifier-integration.md`. Ships disabled by
default; Task 0 (the spike: pinned checkpoint, ~1.7 GB local install)
needs the owner's explicit go before any of it starts. **Unblocked
2026-10-08**: the decision log (ADR-0027, Phases 0+1+3) and the replay
harness are merged, so the spike can be verified against real session data
and recorded known decisions (`docs/plans/2026-10-08-laya-spike-brief.md`);
evening spike on branch `laya-spike`.

**Classifier decision log — remaining phases** (ADR-0027, plan
`docs/plans/2026-10-08-classifier-decision-log.md`): Phase 2 (turn id +
outcome join + correction signals — real accuracy proxies), Phase 4
(shadow-classifier hook — live known-vs-candidate comparison, fire and
forget, cannot change routing), Phase 5 (`/router classifier` summary).
None blocks the Laya spike.

---

*Last updated: 2026-10-08 (classifier decision log ADR-0027 Phases 0+1+3:
confidence gate on the cloud path + invalid-category warning + working
classification cache, JSONL decision records with store_text privacy gate,
replay harness + session backfill; Laya spike unblocked and briefed. Suite
2004 passed / 3 skipped. Earlier:*
 PR #51 auto-prune of dynamic
merge keys, PR #52 routing-flow decision-tree doc, PR #53 Nightly R1
mutation triage — 435 mutants triaged, +152 tests, dead code removed;
`model-map.yaml` classified class B with canary pin, owner decision;
locale-parser direction decided (international); stale entries cleaned
up. Suite 1801 passed / 3 skipped, coverage 87.14/80.97, thresholds
pinned. In progress in worktree lanes: circuit breaker Phases 2–4,
task-type Phase 4 + 5b. Earlier same day: PR #46 ADR-0025 Phase A,
circuit breaker Phase 1, /router config Phases 1–2, task-type Phases
2–3; PRs #49–#50 ADR-0025 Phases B–E, baseline closed at 0; nightly
mutation testing live; Dependabot policy pinned)*
