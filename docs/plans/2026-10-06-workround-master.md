# Master Plan: Work Round 1.7.0 — Tracks 1–4 in One Pass

> **REQUIRED SUB-SKILL:** Use `subagent-driven-development` to execute this
> plan. Each lane runs in its own git worktree (using-git-worktrees;
> `.worktrees/` exists and is gitignored) with ONE writer per worktree. This
> plan ORCHESTRATES the four existing sub-plans — it does not duplicate
> them; every implementer prompt carries the full sub-plan section text.

**Goal:** Land ADR-0025 Phase A, Circuit-Breaker Phase 1, `/router config`
Phases 1–2, and Task-Type Phases 2–3 in one supervised round — the owner
does not sit and watch; the round reports back with a verified, reviewed PR.

**Architecture:** Lane A (the ratcheting guard) lands first because its
baseline pins the current state of `src/` and the shipped config — the other
three lanes must then keep it green, which is exactly the point of the
guard. Lanes B/C/D touch disjoint file sets and run in PARALLEL worktrees
after A integrates. Sequential integration onto one branch, one PR for the
whole round (§8: batch related work), full-range review before merge.

**Tech Stack:** TypeScript, vitest (4.1.11), esbuild bundle, pi 1.0.4
devDeps (aligned — see the model matrix for the subagent model pinning).

---

## Decisions taken by default (owner may veto at plan review)

The sub-plans left open questions that would otherwise block. For "in one
pass" these are resolved as follows, each traceable to its sub-plan:

| Sub-plan question | Decision for this round |
|---|---|
| Breaker Q1 (one mechanism vs cloud-only) | **One generalized mechanism** (`provider-breaker.ts`), local parity preserved |
| Breaker Q2 (cooldown ladder) | Ladder `[2, 5, 15]` min for cloud AND local; success resets |
| Breaker Q3 (401/402) | **Not counted in Phase 1** — separate signal class, needs its own narration design; stays open for Phase 2 |
| Breaker Q4 (volatile state) | Confirmed: breaker state volatile across restarts, stats persisted (D7 as written) |
| Router-config Q1 (write target) | Global user file only (`router-config.user.json`); project override stays hand-edited |
| Router-config Q2 (confirmation) | Informational match count, applies immediately |
| Router-config Q3 (scope v1) | Exclude/unexclude + display + compaction stub, nothing more |

## Model matrix (owner directive 2026-10-06)

| Lane | Complexity | Subagent model | Rationale |
|---|---|---|---|
| A — guard + baseline | intricate (scanning logic, ratchet semantics, JSON baseline tooling) | `claude-bridge/claude-opus-5-5` | the hardest, most consequential piece |
| B — breaker core | state machine, evidence classes, half-open probing | `claude-bridge/claude-sonnet-5-5` | well-specified design (D1–D9 fixed), needs care not genius |
| C — /router config | handler + persistence safety (delta writes, .bak, atomic) | `claude-bridge/claude-sonnet-5-5` | well-specified (D1–D6 fixed) |
| D.1 — fallback inherits category | classifier semantics, guards (HINT/compaction, decay) | `claude-bridge/claude-sonnet-5-5` | core classification flow |
| D.2 — `category_groups` key | mechanical: types + loader + resolver lookup + tests | `mistral/mistral-large-4` | "clear what must change" → the cheaper model may run |
| D.3 — docs/test-bulk sub-tasks (README, CHANGELOG, TODO ticks, autocomplete rows) | mechanical | `mistral/mistral-medium-3.5` | per owner: the "dumb" model for clearly-scoped edits |
| Spec + quality reviews (every task) | fresh context, evidence-based | `claude-bridge/claude-opus-5-5` | review quality must exceed implementer quality |
| Final full-range review (§1 gate) | whole round | `claude-bridge/claude-opus-5-5` | fresh context |

Dispatch: `subagent({ agent: "worker", model: "<exact id>", task: <full text>, cwd: <lane worktree> })`.
Reviews: `agent: "reviewer"`, same model pin, fresh context.

## Repo bar (applies to every task, no exceptions)

AGENTS.md §4 red-first (test observed failing against unfixed code, evidence
in the task report), §3 English-only, `npx tsc --noEmit` clean,
`npx vitest run` green, coverage thresholds UNCHANGED. New code in lanes
B/C/D must not introduce model literals (Lane A's guard is live by then —
a red guard test in a lane is a finding, not a baseline entry).

---

## Lane A — ADR-0025 Phase A: guard + ratcheting baseline

**Sub-plan:** `docs/plans/2026-10-06-no-hardcoded-models.md` → "Phase A".
**Worktree:** `.worktrees/round-a-guard` from `main`. **Model:** Opus 5.5.

**Files:**
- Create: `test/no-hardcoded-models.test.ts`
- Create: `scripts/hardcoded-model-baseline.json`
- Create: `scripts/scan-hardcoded-models.ts` (shared scanner used by the test; keep it pure so the test can import it)
- Test: `test/no-hardcoded-models.test.ts` (self-testing: bogus literal red, stale baseline entry red)

**Tasks (each red-first, own commit):**

1. **A1 scanner module** (`scripts/scan-hardcoded-models.ts`): pure
   function `scan(source, { allowPaths, familyTokens })` returning
   `{ file, literal, line }[]`. Model-shaped literal = `provider/model`
   refs and family-prefixed ids built from the family tokens of
   `src/model-matcher.ts`. Comment-only lines excluded (strip `//`, `/* */`,
   JSDoc before matching). Path allowlist (class A/B): `capabilities.ts`,
   `providers.ts`, `ollama-gdpval.ts`, `model-matcher.ts`, plus `test/**`.
2. **A2 config structural scan**: named-model positions in the shipped
   `router-config.json` — `providers.*.free_models[]`,
   `model_metrics.*` keys, `model_groups.*.classifier_model|classifier_fallback`,
   `exclude.models[]`, `non_agent_model_prefixes[]` — reported as
   `config:<jsonpath>` entries, NOT class-B.
3. **A3 baseline + guard test**: baseline JSON = the audit result (the
   scanner's output on current `src/` + config, sorted, with a
   `"generated_from"` note). Guard fails on (a) any literal/class-B-external
   finding NOT in the baseline, (b) any baseline entry that no longer
   exists (stale → ratchet only shrinks). Red-first proof is built into the
   test itself: two fixture files (one with a bogus literal, one stale
   baseline entry) assert the guard fails on each.
4. **A4 class-B invariant tests** (from the sub-plan A4): a registry without
   model X plus a `gdpval_builtin` entry for X ⇒ X absent from
   `allDiscoveredRefs`, persisted dynamic groups, and classifier
   candidates.
5. **A5 commit + verify**: `fix:`→`test:` style per §5; full bar; commit
   message names the red evidence.

**Exit:** guard green on the lane's `main` state with the audit baseline;
baseline count recorded in the task report (it is the ratchet's starting
number — every later phase must shrink it).

## Lane B — Circuit-Breaker Phase 1: core module + local parity

**Sub-plan:** `docs/plans/2026-10-06-provider-circuit-breaker.md` →
"Phase 1" (D1–D9, decisions table above).
**Worktree:** `.worktrees/round-b-breaker` from integration HEAD after A.
**Model:** Sonnet 5.5.

**Files:**
- Create: `src/provider-breaker.ts`
- Modify: `src/provider-watchdog.ts` (thin re-exports of the new module; no behavior change)
- Create: `test/provider-breaker.test.ts`
- Verify (no edits expected): `test/provider-watchdog.test.ts`, `test/provider-watchdog-integration.test.ts`

**Tasks:**
1. **B1 evidence classification** (D1): `classifyFailureEvidence(kind, text)`
   → `counts | ignores`; rate-limit/reset-time, 400/404/422 request-shape,
   aborts, overflow, truncated excluded; connection/5xx-shaped
   `provider_error` counts. Red-first: mistral-400/422-shaped failures must
   NOT trip (fixture), connection-shaped must.
2. **B2 trip rule + state machine** (D2/D5, ladder per decisions): distinct
   models (cloud 3 / local 2) in window 10 min, no success in between →
   open; half-open single probe; success closes and clears. Injected clock.
   Red-first unit tests: distinct-model requirement, window expiry, ladder
   escalation, per-provider isolation.
3. **B3 local parity**: `provider-watchdog.ts` becomes re-exports; the
   existing watchdog test suite must stay green UNCHANGED (parity pin);
   `WEDGE_*` constants keep their values via the new module.
4. **B4 parity audit**: prove in the task report that no exported symbol
   used by `index.ts`, `stream-orchestrator.ts`, `commands.ts`,
   `content-classifier.ts` changed signature (grep + tsc).
5. **B5 commit + verify.** NOTE: volatile cache key + stats persistence and
   all Phase 3 visibility are OUT of this lane's scope (Phase 3 runs later).

## Lane C — /router config Phases 1–2

**Sub-plan:** `docs/plans/2026-10-06-router-config-command.md` → Phases
1–2 (D1–D6, decisions table above).
**Worktree:** `.worktrees/round-c-config` from integration HEAD after A.
**Model:** Sonnet 5.5 (docs/autocomplete sub-task may go to Medium 3.5).

**Files:**
- Create: `src/user-config-store.ts` (read/merge/validate/persist delta; `.bak` on first write; atomic temp+rename; refuse on unreadable)
- Modify: `src/commands.ts` (subcommand dispatch + display + autocomplete rows)
- Modify: `src/config-loader.ts` ONLY IF the origin-marker view needs a read-only helper — coordinate with Lane D (same file); prefer adding the helper in a new module if D integrated first
- Create: `test/user-config-store.test.ts`, `test/router-config-command.test.ts`

**Tasks:**
1. **C1 store module** red-first: delta write keeps every existing key,
   shipped `router-config.json` byte-identical, `.bak` written, corrupt
   existing file → refuse + error, atomic rename (crash-safe).
2. **C2 display (`/router config`)** red-first: sources with origins,
   every exclude rule with origin marker (`shipped`/`user`/`project`) and
   current match count, compaction state ("Phase 5b pending").
3. **C3 exclude/unexclude** red-first: user-layer pattern persisted +
   live-effective via in-place mutation + `rt.load()`; un-exclude removes
   only user-layer entries, shipped ones get the honest D4 message;
   scan-cycle note in the output; glob validation rejects junk.
4. **C4 autocomplete + docs rows** (Medium 3.5): subcommand completions,
   README `/router` section, CHANGELOG "Added" entry.

## Lane D — Task-Type Phases 2–3

**Sub-plan:** `docs/plans/2026-10-05-task-type-balancing.md` → Phases 2–3
(approved by the owner 2026-10-05).
**Worktree:** `.worktrees/round-d-tasktype` from integration HEAD after A.
**Models:** D.1 Sonnet 5.5; D.2 Mistral Large 4; D.3 Medium 3.5.

**Files:**
- Modify: `src/content-classifier.ts` (inheritance; mapping lookup)
- Modify: `src/types.ts` (`category_groups?: Record<string,string>`)
- Modify: `src/config-loader.ts` (merge key; validation warning on unknown category/group)
- Modify: `README.md`; Create/extend tests

**Tasks:**
1. **D.1 fallback inherits last category** (Sonnet 5.5) red-first: "design
   turn, then 'ok, continue'" routes to the design group (RED today:
   tactical). Guards: HINT/compaction sources never overridden; inheritance
   does not survive a session restart (fresh context ⇒ configured
   default). Mechanism mirrors the existing low-confidence path.
2. **D.2 `category_groups` config key** (Large 4) red-first: user layer
   maps `code_complex → planning`, resolver follows (RED today: built-in
   mapping). Unknown categories/groups rejected with a load-time warning.
   Defaults unchanged. Threading only: types → loader → classifier lookup.
3. **D.3 docs** (Medium 3.5): README config section, CHANGELOG entries,
   TODO ticks (task-type phases 2–3 done).

---

## Integration & verification protocol (parent session)

1. `plan_tracker` initialized with lanes A, B, C, D and their tasks.
2. Lane A runs FIRST, integrates into `workround-2026-10-07` branch, full
   bar green (guard live).
3. Lanes B, C, D dispatch in parallel (async, separate worktrees, one
   writer each). Per task: implementer → spec review → quality review
   (both Opus 5.5, fresh context) → fix loop → `plan_tracker` complete.
4. Integration order B → D → C (C last: its `config-loader.ts` touch is the
   only potential overlap, with D.2). After EACH lane merge into the
   integration branch: `npx tsc --noEmit`, `npx vitest run`, coverage
   thresholds unchanged, `npm run build`, guard test green. Rebase the lane
   if needed — never merge red.
5. One PR for the whole round. All three review endpoints read (§8).
   Final full-range review with the `requesting-code-review` skill
   (Opus 5.5, fresh context) — Critical/Important must be fixed before the
   PR is even proposed as mergeable.
6. Owner gets ONE report: red evidence per lane, baseline number (and how
   the guard proved the lanes clean), review results, CI green. Merge per
   the owner's standing decision for this round.

## Risk register

| Risk | Mitigation |
|---|---|
| Lane A's baseline becomes stale the moment B/C/D land (they must not add literals) | Guard is integration-blocking: any lane adding a literal fails its own bar; baseline entries are only REMOVED by ADR-0025 B-phases (later rounds) |
| C and D both touch `src/config-loader.ts` | Integration order D → C, C rebases; or C places its helper in `user-config-store.ts` |
| Parallel lane worktrees drift behind integration | Lanes branch from post-A HEAD; rebase at integration time; full bar re-run after each lane |
| Subagent drift from repo bar (red-first, English) | Full sub-plan text + bar in every prompt; spec review checks exactly this; §7 boyscout applies inside lanes too |
| The round grows unbounded | Scope is frozen: any finding beyond lanes B/C/D scope becomes a TODO entry + report line, not a lane |
