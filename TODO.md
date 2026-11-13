# 🚀 pi-model-dynamic-router - Current Tasks & Roadmap

> **Status**: 2.0.0 prepared (`2.0.0-SNAPSHOT`), release awaits the owner's go
> (AGENTS.md §1). Items closed in v1.6.1 or earlier are removed from this file;
> their history lives in `CHANGELOG.md` and git.
> **Last Updated**: 2026-11-08

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

### 🟢 **Lint burn-down (gate shipped 2026-11-04, baseline 0 — DONE 2026-11-08)**

The gate is live (`npm run lint`, step in the required `test` job,
`docs/plans/2026-11-04-lint-gate.md`). Baseline: **0 findings / 0 entries** —
the burn-down is complete (was 1217 / 299; S3 took it to 919 / 159, the
Prettier reformat to 915, S4 to 810 / 130, S4 factory interfaces to 803 / 123,
the sessionCtx typing in the PR #120 review round to 732 / 121, S5 in PRs
#131-#133 to 0 / 0; `CEILING_FINDINGS` is 0). Each slice lowered
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
- [x] **S5** long tail — **done 2026-11-08, PR #133: baseline 0 findings /
      0 entries, `CEILING_FINDINGS` 0** (732 → 654 → 235 → 0, PRs
      #131/#132/#133): `no-explicit-any` + the `no-unsafe-*` family, per-file
      slices. Slice 1 typed `context-utils` (19→0), `error-signatures`
      (20→0), `delegation` (21→0), `free-model-registration` (18→0); slice 2
      typed the five biggest files — `content-classifier` (101→0),
      `group-registration` (94→0), `stream-proxy` (84→0), `scan-runner`
      (72→0), `stream-orchestrator` (64→0) — against the real host types
      (`ExtensionContext`, `AssistantMessageEvent`, `Model<Api>`,
      `ProviderConfig`, `ClassificationOptions`). The 415 direct findings
      plus the `no-unsafe-*` chains they fed downstream cut the baseline by
      419 in one slice. Notable: the private `registry.runtime`
      reach-throughs (streamSimple/completeSimple) are now TYPED and
      documented at every site (stream-proxy, stream-orchestrator,
      scan-runner, hint-resolution); `hint-resolution.ts`'s
      `ModelRegistryLike` dropped the `runtime` field (private-name clash)
      in favour of an explicit reach-through cast; the classifier's
      completeSimple hook may resolve `undefined` (pinned inert contract,
      now guarded readably in the cloud loop instead of a TypeError); the
      delegation fixtures were modernized to the current host protocol
      (done/message.usage, not the pi-0.83 `message_end`). Slice 3 (PR #133)
      typed the remaining 23 files, including event-handlers (30),
      classifier-cloud-probe (28), dynamic-config-runner (25), metrics (25),
      tools (15), bulk-read (11) and every JSON.parse site. The ratchet is
      closed: the gate fails on ANY new finding.

Note: the dev-only `minimatch` alert (CVE-2026-118764) is closed by an
`overrides` entry (2026-11-08, see the dependency-security round below), not
by an ESLint move — there is no ESLint 11.

### 🔴 **Post-merge review 2026-11-04 — open items (owner decisions)**

Independent review of `38d2a27..fde54f8` (the structural question behind most of these — should the router keep its own turn-state machine at all? — is `docs/plans/2026-11-04-virtual-models-routing.md`; mapping of every item in `docs/research/2026-11-04-virtual-models-fit.md`). Critical C1/C2 and Important I1, I2 (suppression), I6 are fixed on `fix/subcall-scope-async-local`). What remains needs a decision, each as its own plan (§11), none of it blocks the fix:

- [x] **I3 — a tool follow-up falls back to `simple` whatever the turn's group is** — FIXED 2026-11-07 (PR #120). Plan `docs/plans/2026-11-07-tool-follow-up-group.md` (first registered 2026-10-25; `stream-orchestrator.ts` `isToolFollowUp`: `[lastDynamicModel, ...simple candidates]`). A planning/design/code_complex run whose driver hits one 429 or stall degrades to cheap/free models for the rest of the agent run and stays there after the driver's cooldown. Implemented and merged 2026-11-07 (PR #120): the run's driver and group are remembered at classification and at a HINT pin; follow-up order = driver (once cooled down), current ref, the run group's candidates, that group's `fallback_groups`; with tools in the context free-tier models are skipped (fail-open) unless the run group is `simple`.
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
- [x] **I5 — compaction continuity trusts any "large" last model** (`content-classifier.ts`) — FIXED 2026-11-07 (PR #120). Plan `docs/plans/2026-11-07-compaction-continuity.md` (implemented and merged 2026-11-07, PR #120): the decision now uses the real context window via the reserve-aware `planOutputBudget`, fail-closed on unknown windows, with `:free`/meta-router refs excluded.
- [x] **I2 remainder / M1 — turn state is per process, not per session** — FIXED 2026-11-07 (PR #120). Plan `docs/plans/2026-11-07-session-keyed-turn-state.md` (implemented and merged 2026-11-07, PR #120). Subagent sessions in the same process share `lastDynamicModel`/`curModel`; clearing `lastDynamicModel` on `session_shutdown` would let a child wipe the parent's turn model, so it was NOT done. Turn state is now keyed per session.
- [x] **M3 — turn latency includes tool and sub-call time** — FIXED
  2026-11-08 (PR #126, plan `docs/plans/2026-11-07-turn-latency-tool-time.md`,
  measurement `docs/research/2026-11-08-turn-latency-stream-share.md`): `turn_end` books the whole turn
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

### ✅ **"fallback" naming — DONE 2026-11-08 (PR #127)**

"fallback" named six different things. Rounds 1 (dead vocabulary) and 2
(cloud chain) are done; the ratchet is `test/fallback-naming.test.ts`
(retired names cannot come back; a new `fallback` identifier must be added to
an honest-meaning allowlist). Breaking config rename: `classifier_cloud_fallback`
→ `classifier_cloud_chain` (warned, not aliased). Plan:
`docs/plans/2026-10-25-fallback-naming.md`. **Owner go given 2026-11-08
(part of the 2.0.0 Laya gate):** the `~/.laya-ft` labeling tooling's
`fallback` corpus label is renamed before 2.0.0 — migrating existing labels
(corpus, queue, labels, golden set) is owner-side work that does not ship
with the router.

### ✅ **Compaction reason text named the wrong group — CLOSED 2026-11-02 (already fixed)**

`classifyPromptUncounted` (`src/content-classifier.ts`) returned
`category: 'code_complex'` with the reason "routing to strategic". Both the
category and the text now agree with the five-group layout: the branch
returns `code_complex` with "Compaction — routing to code_complex for large
context window" (and "... last model is in cooldown, routing to code_complex"
for the cooldown case, lines 733-734). Verified by grep on 2026-11-02, no
code change needed.

### ✅ **Tool follow-up steps fail over into the free pool — group fixed 2026-11-07, migration decided against**

> **Status 2026-11-12:** closed. The group part is fixed (review item I3 below, PR #120). The structural answer
> (Pi virtual models) was decided against on 2026-11-07 and is re-evaluated on Pi host upgrades
> (`docs/plans/2026-11-04-virtual-models-routing.md`). The measurement below is kept as the record.

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

**Quality cascade (closed as a branch 2026-11-12, feature deferred past 2.0).**
The model-identity plan of 2026-10-10 (`feat/quality-cascade`, never merged)
had six defects. D1-D3, D6 were already fixed on `main` by other changes
(variant-token veto in `slug-matcher.ts`, working capability extraction), D4
no longer applies (the `min_gdpval` floors are now 1600-1700 per group), D5 (two
sibling-pointing `model-map.yaml` entries) was fixed in PR #162. What remains
is Phase C/D, an opt-in quality score built from percentiles of AA signals
with the intelligence index as a ceiling. It is the same open question as the
felt-quality item above and needs the owner's choice of weights and
thresholds, so it gets its own plan (§11) after 2.0. The branch, its worktree and the
unfinished `model-identity.ts` were discarded; the plan itself is kept as
`docs/plans/2026-10-10-model-identity-and-quality-cascade.md` (status deferred).

---

### 🔎 **Open (2026-11-11): how much of the original `pi-model-router` is left? — before 2.0**

The repository is a fork of `a-canary/pi-model-router` and the MIT `LICENSE`
names both authors. The owner wants to separate from the base project and
decide this **before 2.0**: measure what remains of the original (lines still
attributed to its commits, files that exist unchanged), then decide whether
the fork relationship, the README banner and the second copyright line stay.
The upstream repository has no licence text of its own (`package.json` says
MIT), so the notice must not be dropped before that is settled.

> **Status 2026-11-12:** measured; copyright split decided by the owner and done
> and merged (PR #156; `LICENSE`, `docs/upstream-attribution.md`: 21 files keep the original
> notice, all others the owner's name). README banner reworded as an origin note. Upstream is
> archived and its tip has the same tree as our fork point, so nothing is missing; the package
> metadata needs no change. **Done.**
> Plan: `docs/plans/2026-11-12-fork-remainder.md` (done). Measurement:
> `docs/research/2026-11-12-fork-remainder-measurement.md` — 571 of 2933 baseline
> lines still at HEAD (at most 19.5 %), 0 of 15 upstream files byte-identical.

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
### Code Quality
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
### Integration & Extensibility
- **Optional integrations: one contract, one config block**
  (`docs/plans/2026-11-08-optional-integrations-config.md`, in progress
  2026-11-11). **Done 2026-11-11:** the contract (`src/integration.ts`),
  the schema with unknown-key warnings (`src/config-schema.ts`) and the rename
  `classifier_laya` → `integrations.laya` with a `RENAMED` warning.
  **Open, in this order:**
  (1) **DONE 2026-11-11:** the `/router status` "Integrations" section and
  the `/router config integration <name> on|off|<mode>` subcommand (nested
  delta in `src/user-config-store.ts`, renderer over the health registry);
  (2) consumers outside the repository: **DONE 2026-11-11** — the owner's
  `router-config.user.json` block moved under `integrations.laya` (loaded by
  the real loader: same values, no warnings), the sidecar manager extension
  reads `integrations?.laya?.enabled === true` (a readable file without it now
  means off, like the shipped default; an unreadable file stays fail-open), and
  `~/.laya-ft/shadow_eval/common.py` reads the threshold from the new path.
  A session that was already running keeps the old code in memory and sees no
  Laya block after a config reload until Pi is restarted;
  (3) the CodexBar plan continues on this contract. Original note — the
  contract + rename are a 2.0.0 blocker since decision 1 is DECIDED,
  2026-11-08): Laya is wired ad hoc (own block, own validator, own health state);
  unknown config keys are silently ignored and a project layer can enable
  integrations. The plan proposes `integrations.*` with per-layer trust and a
  core-only invariant test. Decision 1 DECIDED 2026-11-08: rename
  `classifier_laya` → `integrations.laya` before 2.0.0 (with `RENAMED_*`
  warning, no alias). Decision 3 DECIDED 2026-11-08: a project layer may
  enable an integration (the core-only invariant test and the loopback rule
  make that harmless; both pinned). The invariant test for Laya exists
  (`test/laya-chain.test.ts`). Decision 4 DECIDED: the router gets
  a way to start the sidecar, later (see below). Decision 2 DECIDED
  2026-11-08: a hand-maintained schema plus a test that it matches `Config`.
  Prerequisite for the CodexBar plan.
- **External usage source: CodexBar**
  (`docs/plans/2026-11-08-external-usage-source-codexbar.md`, proposed, not
  started): the router only sees its own counters — quota windows, reset
  times and balances surface only as errors (ADR-0003 Option C, deferred).
  Read-only, loopback-only, background-polled adapter; identity stripped;
  staged modes observe → pace → exhausted; needs a new ADR. Owner decisions:
  who runs `codexbar serve`, providers in v1, complement vs replace the own
  counter for pacing. Builds on the integration contract plan above.
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

### ✅ **Post-spike-merge mutation triage: classification/HINT region in stream-orchestrator — CLOSED 2026-11-08** (owner-mandated 2026-10-15; kept as the record)

> **Status 2026-11-08:** slice 1 done (257/272 killed, 15 equivalent). Slice 2
> (`driveStream`) triaged 2026-11-05: of 329 non-killed mutants, 205 REAL GAP
> (sketches in `docs/mutation-data/slice2-triage/`), 118 EQUIVALENT, 1 false
> survivor, 1 dead store removed. Slice-2 test round: batches 1–3 (2026-11-06,
> 34 mutants verified killed) plus batch 4 (2026-11-08: lookahead guards
> 498–503, repetition/truncation narrations 749/751/752, the wait-retry
> abort/slot family 659–694, context-window persistence 706–708, the overflow
> candidate filter 713/717/720/722 — 28 killed, see
> `docs/mutation-triage.md`). Slice 3 (helpers) triaged 2026-11-06 and its test
> round is done 2026-11-08 (outer-abort chaining 7 of 9 killed / 2 equivalent,
> breaker evidence phrase + narration 14 killed; the detail-less overflow
> verdicted EQUIVALENT — production unreachable). Round total: 49 killed, 5
> equivalent; the Sourcery review round on PR #123 hardened the fixtures
> (deferred consume, frozen clock, reason pins, provider+id lookup) with all
> kills re-verified. CLOSED 2026-11-08 (PR #129): the cluster H leftovers
(the consume-reject catch path — the first fixture for it, the existing
breaker fixtures all use error-EVENT streams), the thrown-OPEN seam (a
rejecting tryStream is a different code path with its own mutants), the
blocklist observer gates (main loop + post-wait-retry twin — the "expensive
multi-turn fixture" was unnecessary, the observable is the observeFailure
call itself), and the silent-skip path (871). 23 mutants hand-verified
killed (`test/thrown-stream-blocklist-seams.test.ts`, ledger in
`docs/mutation-triage.md`); a boyscout fix rode along (the thrown-open
narration printed raw provider text — now sanitized like the consume-catch
narration). The 205 slice-2 real gaps are fully closed. The metrics.ts /
routing.ts remainders are closed too (nightly N11, 2026-11-08: 59 triaged —
10 killed by the suite, 22 EQUIVALENT, 27 real gaps pinned in
`test/mutation-n11-remainders.test.ts`). Plan:
> `docs/plans/2026-11-04-orchestrator-mutation-triage.md`.

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

metrics.ts / routing.ts remainders: CLOSED 2026-11-08 (nightly N11 — see
`docs/mutation-triage.md`).

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

**vitest 5 migration round — DONE 2026-11-08 (PR #130):** vitest
4.1.12 -> 5.1.0 (+ @vitest/coverage-v8 5.1.0, @stryker-mutator/core and
vitest-runner 10.0.0 -> 10.1.1 for the `>=2.0.0` peer). No API breaks: the
suite (2866 passed / 3 skipped) and tsc are green unchanged. The predicted
red coverage run (74.27 % branches vs the pinned 76 % threshold, measured
2026-10-04 on a much smaller suite) did NOT materialize: coverage-v8 5.x
accounting lands at 85.19 % branches — the pinned thresholds
(63/76/63/63) pass UNCHANGED, no re-derivation needed (§4 satisfied: nothing
was lowered). Stryker dry run (1259 tests) passes on the vitest-5 runner.
The vitest-majors ignore is removed from .github/dependabot.yml and the
guard test now pins that it STAYS removed (a re-added ignore would silently
freeze vitest again).

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
- `minimatch` (Dependabot alert #51, medium, CVE-2026-118764, DoS via
  globparts amplification, patched only in 11.0.1) — **FIXED 2026-11-08 by
  `"overrides": { "minimatch": "^11.0.1" }`** (section 10, third step). The
  premise "blocked until ESLint 11 / typescript-eslint / Stryker support 11"
  was wrong: there is no ESLint 11 (latest 10.14.0 keeps `^10.2.6`,
  typescript-estree 8.72.1 `^10.2.2`, Stryker 10.1.1 `~10.2.4`), so waiting
  never ends. Checked before applying: minimatch 11 needs Node `20 || >=22`
  (engines `>=22.19`), ships ESM + CJS, the lock diff is upgrades only
  (minimatch 10.2.6 -> 11.0.5 plus its own `@isaacs/nonrecursive-glob-match`
  1.1.0; the host's nested 11.0.3 copy dedupes away), `npm audit` 0 (was 11
  moderate), tsc / lint gate (732) / suite / coverage thresholds / build
  green, a Stryker dry run (1238 tests) passes on minimatch 11. Reach was
  already nil (dev tools, our own repo-controlled globs, not in dist).
  Pinned by `test/dependency-lock-security.test.ts`. **Remove the override
  once eslint, typescript-eslint and Stryker themselves allow minimatch
  11** (re-check at the next ESLint/Stryker bump); the Dependabot alert
  closes with the merged lock — dismissal is not needed.

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
  **2.0.0 blocker** (owner 2026-11-08: everything Laya before the release).
  Open decision 3 (where the sidecar lives: subdirectory with its own release
  vs. separate repo). Decision 4 is evaluated: the 2026-11-08 spike
  (`docs/research/2026-11-08-onnxruntime-node-spike.md`) shows
  `onnxruntime-node` reaches 100 % golden-set argmax parity with the MLX
  sidecar and p99 < 800 ms latency (Apple Silicon), so Python is not a hard
  runtime requirement for inference — the tradeoff moves to the 290 MB native
  dependency (AGENTS.md §10) and 1.29 GB weights. int8 is ruled out (69 %
  agreement). Remaining steps (`/health` contract tests done 2026-11-08):
  r2 weights publish (own §1 approval) — the last open step. Packaging is
  DONE 2026-11-12: the ONNX sidecar package `laya-sidecar/` (plan
  `2026-11-11-onnx-sidecar-package.md`, PR #157 — npm package, parity
  180/180 golden and 298/300 corpus) and the one-backend installer (PR #159:
  MLX left the installer, `router@1.0.0` ships the ONNX set only). The
  live-queue parity run is DONE 2026-11-13: 259/260 vs the MLX reference, the
  single disagreement a near-tie (top-2 margin < 0.005,
  `docs/research/2026-11-13-laya-live-queue-parity.md`); the per-platform
  install docs are complete (Windows start example included). Linux/Windows
  latency WAIVED by the owner 2026-11-08 (modern PCs assumed similar).
- **Laya model artifact + install skill**
  (`docs/plans/2026-11-08-laya-model-artifact.md`, in progress 2026-11-08;
  **2.0.0 blocker**, part of "everything Laya"): no artifact a user can
  install — `checkpoint` is a hand-typed HF path, the router never downloads
  weights, nothing verifies what arrived, and the head was not pinned to the
  router's head. **In progress 2026-11-08:** manifest, head parity gate and the
  `pi-laya-model` installer, the `/health` identity (router + reference
  sidecar) and the `/router status` mismatch warnings landed, and so did the
  install skill `skills/router-laya-install/`. Remaining: the owner's
  weights release go (§1) and a smoke test of the skill in Pi (unverified: the
  skill's call of `pi-laya-model`, and whether the bin reaches the PATH). Owner decisions 2026-11-08: weights as GitHub Release
  assets + manifest in the repo, ONNX as the default backend, an install skill
  that asks first; install root `~/.pi/agent/laya-models/`, a Pi-independent
  `pi-laya-model` bin, runtime (Python/Node) and backend chosen by the user,
  weights in a dedicated release line of this repo. Open: whether the first
  weights publish stays a 2.0.0 blocker (publish itself needs its own §1 go).
  **2026-11-12:** the release staging directory is cleaned (four hard-linked
  MLX files removed, originals intact) and `laya-release-check` passes for
  `router@1.0.0`; the installer offers the ONNX backend only (PR #159).
- **Router-managed sidecar start** (owner 2026-11-08, "can happen later"; not
  a 2.0.0 blocker; needs its own plan per AGENTS.md §11 when scheduled): the
  router should be able to start an installed sidecar itself instead of
  leaving that to a user-level extension. Prototype: the sidecar manager the
  owner runs outside the repository (health-first adoption, start lock,
  last-client shutdown). Depends on the model artifact plan below and the
  integration contract.
- **Router config UI: guided path for integrations**
  (`docs/plans/2026-11-08-router-config-ui.md`, proposed 2026-11-08; depends
  on the integrations contract): `/router config` is read-mostly, enabling
  Laya needs six hand-edited keys, and a wrong value silently disables the
  stage — while `ctx.ui.select/confirm/input` sit unused. Proposes an
  interactive `config integration <name>` wizard plus one "Integrations"
  section.
- **Laya as sole classifier — open steps** (`docs/plans/2026-10-25-laya-sole-classifier.md`):
  live check and the timeout failure test are DONE (2026-11-08; the test
  exposed a one-timeout-disables-for-5-minutes defect, fixed). Open:
  disagreement labeling, the `continue` step (both need real Laya decisions
  to accumulate; measured 2026-11-12: 91 paired laya/comparator records since
  the 2026-11-08 restart, 49 distinct prompts, 23 raw-category
  disagreements), and whether the momentum observation (enabled in the
  owner's user layer) gets evaluated. Laya stays in the data-reconciliation
  phase (owner 2026-11-07). **State 2026-11-12** (`docs/research/2026-11-12-laya-r2-owner-accuracy.md`):
  all 248 owner labels re-classified with r2 — 22.8 % category accuracy on
  live prompts (majority baseline 30.5 %), held-out golden 43.2 % vs 53.4 %
  for the cloud teachers; the pre-registered rule re-run says NO-GO (R2 now
  decided on 150 paired items, −2.7 pp, p = 0.76, after the evaluation
  tooling fix). Laya nonetheless stays ACTIVE in the owner's live setup
  (owner 2026-11-12: it works well for him; `continue` answering less often
  may be the better read).
- **Felt quality vs. benchmark ranking** (2026-10-31 observation): needs its
  own plan — how owner ratings per model and task type enter the ranking
  (user layer, allowed per ADR-0025 §2C) without model names in shipped code.
- **Task-type balancing — closed 2026-11-08**
  (`docs/plans/2026-10-05-task-type-balancing.md`): Phases 0–5b are done;
  5d is closed by the owner after the measurement
  (`docs/research/2026-11-08-task-type-balancing-remainder.md`: all 27
  November compactions cost $2.97). Only 5c (fresh-session suggestion) stays
  deferred to a later 2.0.x by owner decision.
- **Release prep for 2.0.0** (owner 2026-11-07: target the next release as
  2.0.0; `package.json` is on `2.0.0-SNAPSHOT`): the fallback-rename (V3) and
  M3 landed in 2.0.0 (PR #126/#127). The §1 whole-range code review RAN
  2026-11-08 (requesting-code-review over v1.6.1..main, four reviewer lanes
  via the subagent fanout, run ab1760b9): 0 Critical, 1 Important — FIXED in
  PR #128 (turn_end recorded a failed turn as a model success and closed the
  provider breaker right after a failed cascade; red-first pin in
  test/cache-usage-wiring.test.ts), 6 Minor fixed or justified (stale
  comments, dead costTracker field, breakerState tuning at two sites, dead
  hasNewRegistryRefs, budget-pacing clock-skew guard documented).
  `npm audit` 0 / 0 prod (minimatch fixed by override, PR #125); pi devDep
  1.5.0 = installed host 1.5.0; shipped `log_level: "warn"`. Remaining before
  a release may be proposed: nothing from the review, but the Laya gate:
  **"everything Laya" ships before 2.0.0** (owner 2026-11-08, expanded the
  same day from the labeling-only gate): (1) sole-classifier steps 3/5/6 —
  disagreement labeling, momentum decision, `continue` decision, closing
  numbers (exit criteria proposed in
  `docs/plans/2026-10-25-laya-sole-classifier.md`, "Release gate");
  (2) sidecar distribution — `/health` contract tests DONE, packaging DONE
  2026-11-12 (ONNX sidecar package, PR #157; one-backend installer, PR #159);
  the live-queue parity run is DONE 2026-11-13 (259/260 vs the MLX
  reference, the single disagreement a near-tie) and so are the per-platform
  install docs; only the r2 weights publish remains (own §1 approval);
  Linux/Windows latency WAIVED (owner: modern PCs assumed similar); the
  versioned artifact + install skill are
  `docs/plans/2026-11-08-laya-model-artifact.md`; (3) rename `classifier_laya` ->
  `integrations.laya` — COMPLETE 2026-11-12 (contract, rename, migration
  warning, status section, config subcommand, consumers in and outside the
  repo; plan closed, PR #166); (4) the `~/.laya-ft` fallback label migration —
  DONE 2026-11-13 (owner go 2026-11-08): the labeling tooling speaks the v2-r3
  taxonomy and the five-group layout; the stored corpus labels were migrated
  (`fallback` -> `continue` with a `consensus_v1` provenance field:
  labels.jsonl 1251 rows, golden.jsonl 67; raw teacher files, `owner_cat`,
  `continue_ok`, `truth_v2` untouched; backups next to the files). The release itself
  (tag / publish) is a separate explicit owner approval per AGENTS.md §1 —
  never implied by this list.

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

**`docs/plans/2026-10-05-task-type-balancing.md` remainder** — Phases 0–3, 4
(budget pacing), 5a, 5b (cache-aware compaction) are DONE and 5d is closed
(measured, see the closed entry in the deferred list above). Only 5c
(fresh-session suggestion) is deferred to a later 2.0.x.

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

*Last updated: 2026-11-08*
