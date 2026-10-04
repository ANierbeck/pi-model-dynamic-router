# AA Multi-Benchmark Capability Sourcing — Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.
>
> **STATUS: IMPLEMENTED 2026-10-04** (branch `aa-capability-sourcing`). All five
> tasks landed as planned. Two sharpenings over the plan text: the parser
> chunk-parses each leaderboard entry in isolation (a non-greedy regex over
> the whole payload could pair fields across entries), and the coding blend
> rounds to 2 decimals for determinism across the cache JSON boundary.

**Goal:** Feed the already-fetched Artificial Analysis per-benchmark columns
(briefcase Elo for planning, SciCode/Terminal-Bench for coding) into
task-type-aware group scoring, so tiers rank by what the task actually is.

**Architecture:** No new network fetch — the existing GDPval scrape
(`src/scan-runner.ts` → `artificialanalysis.ai/evaluations/gdpval-aa`)
already downloads the full RSC payload containing every column per model
(verified empirically 2026-10-04, see Evidence). We extend the parser to
extract a capability profile per model, persist it next to `gdpval_scores`,
and make `calculateScore(ref, column)` finally use its taskType parameter
via a new per-group `score_by` config. Floors (`min_gdpval`,
`max_gdpval`) stay on the global GDPval — they are quality gates, not
task-type rankings; the per-task columns only affect ordering WITHIN a
group's pool. Missing column → gdpval fallback (exactly today's behavior).

**Tech Stack:** TypeScript, vitest, no new dependencies.

---

## Evidence (empirical, 2026-10-04, `/tmp/aa-gdpval.html`, 1.4 MB)

The single page fetch the router ALREADY performs contains per-model
entries (escaped-JSON RSC payload, `\"key\":value` form) with:

| Field in payload | Occurrences | Scale | Example |
|---|---|---|---|
| `\"gdpvalBreakdown\"` + existing Formats A/B (today's parser) | 150/30 | Elo | 1900 |
| `\"briefcaseElo\":` + `\"briefcaseBreakdown\":{elo, lower95ci, upper95ci, analyticalQuality…}` | 93 | **Elo** | 1807.81 |
| `\"scicode\":` | 61 | 0–1 | 0.669 |
| `\"terminalBench40\":` (+ `terminalBench21`, `terminalbenchHard`) | 179 | 0–1 | 0.596 |
| `\"automationBench\"`, `\"gdpPdf\"`, `\"omniscience\"`, `\"intelligenceIndex\"` | 90/90/91/60 | mixed | — |

Per-model identity in the same payload: `\"displayName\":\"Claude Opus
5.5 (Max, Default Fallback)\"` — the same displayName→slug mapping the
existing Format-B parser builds (from `\"slug\":\"…\",\"name\":\"…\"`
pairs) applies unchanged. **We fetch all of this today and discard it
after parsing one field.**

## Scale normalization decision

`briefcaseElo` is on the SAME Elo scale as GDPval-AA (same anchor family)
— used as-is. `scicode`/`terminalBench40` are percentages; the coding
blend converts monotonically: `coding = 3000 * max(scicode, terminalBench40)`
(0.67 → 2010). The absolute calibration never meets a floor (floors read
GDPval via `lookupGdp`); only the within-group ORDER matters, and any
monotonic map preserves it. This is documented in code, not tuned by feel.

## Files touched

- `src/types.ts` — `Cache.capability_profiles`, `Group.score_by`
- `src/scan-runner.ts` — `extractGdpvalScores` → also extract profiles
- `src/metrics.ts` — `setCache` merge, `lookupCapability`, `getCapabilityProfiles`
- `src/metrics.ts` — `calculateScore(ref, column)` (taskType finally used)
- `src/routing.ts` — `sortBy` passes the group's `score_by` into `calculateScore`
- `router-config.json` + `router-defaults.yaml` — `score_by` on planning/tactical
- `test/aa-capability-sourcing.test.ts` — new (parser, lookup, scoring, e2e)
- `CHANGELOG.md`, `README.md` — docs

---

### Task 1: Types — cache field and group knob

**Files:** Modify `src/types.ts`.

**Step 1:** Extend `Cache` with:

```ts
  /**
   * Per-slug capability profile from the Artificial Analysis scrape
   * (ADR-0023 round 2). Same additive-merge lifecycle as gdpval_scores.
   */
  capability_profiles?: Record<string, { gdpval?: number; briefcase?: number; coding?: number }>;
```

**Step 2:** Extend `Group` with:

```ts
  /**
   * Which capability column ranks WITHIN this group (ADR-0023 round 2):
   * 'gdpval' (default) | 'briefcase' (agentic knowledge work — planning)
   * | 'coding' (scicode/terminal-bench blend). Floors stay on gdpval;
   * this only affects intra-group ordering. Missing column → gdpval.
   */
  score_by?: 'gdpval' | 'briefcase' | 'coding';
```

**Step 3:** Run `npx tsc --noEmit` → clean.

**Step 4:** Commit: `feat: types for AA capability profiles and per-group score_by`

### Task 2: Parser — extract the profiles from the SAME html (red-first)

**Files:** Modify `src/scan-runner.ts` (the `extractGdpvalScores` area),
Test: `test/aa-capability-sourcing.test.ts` (new).

**Step 1: Write the failing test** with a fixture built from the real
payload shapes (escaped-JSON, normalized like production does):

```ts
const FIXTURE = String.raw`
{\"slug\":\"claude-opus-5-5\",\"name\":\"Claude Opus 5.5 (Max, Default Fallback)\"}
{\"slug\":\"glm-5-3\",\"name\":\"GLM-5.3\"}
{\"id\":\"x\",\"displayName\":\"Claude Opus 5.5 (Max, Default Fallback)\",\"creator\":{\"name\":\"Anthropic\"},\"gdpvalBreakdown\":{\"elo\":1900},\"enterpriseOpsGym\":null,\"enterpriseOpsGymAvgConversationTurns\":null,\"briefcaseElo\":1810.2,\"briefcaseBreakdown\":{\"elo\":1810.2,\"lower95ci\":1795.14,\"upper95ci\":1819.97,\"analyticalQuality\":40},\"opennessIndex\":null,\"scicode\":0.66,\"tau2\":null,\"terminalbenchHard\":null,\"terminalBench40\":0.596,\"confidenceInterval\":1}
{\"id\":\"y\",\"displayName\":\"GLM-5.3\",\"creator\":{\"name\":\"Z AI\"},\"gdpvalBreakdown\":{\"elo\":1643.62},\"briefcaseElo\":1700.5,\"scicode\":0.71,\"terminalBench40\":0.62,\"confidenceInterval\":1}
`.replace(/\\"/g, '"');
```

Assertions:
- profiles for both slugs exist; `briefcase` is the Elo (1810.2 / 1700.5)
- `coding` = `3000 * max(scicode, terminalBench40)` (0.66 → 1980; 0.71 → 2130)
- a model with no briefcase/scicode fields gets NO profile entry (null stays absent — absent is the gdpval-fallback signal, never 0)
- production normalization (`html.replace(/\\"/g, '"')` happens in `scan()`) is applied by the test exactly as in `scan()`

**Step 2: Run it → FAIL** (`extractCapabilityProfiles is not a function`).

**Step 3: Implement** in `src/scan-runner.ts` next to `extractGdpvalScores`:

```ts
  /**
   * Extract per-model capability profiles from the SAME AA payload the
   * gdpval parser reads (ADR-0023 round 2). briefcaseElo is Elo-scale
   * (used as-is); scicode/terminalBench40 are 0–1 percentages blended
   * monotonically into the Elo range (3000 * max) — floors never see
   * these values, only intra-group ordering does.
   */
  function extractCapabilityProfiles(html: string): NonNullable<Cache['capability_profiles']> {
    const profiles: NonNullable<Cache['capability_profiles']> = {};
    const slugByDisplayName = new Map<string, string>();
    const slugRe = /"slug":"([^"]+)","name":"([^"]+)"/g;
    let s;
    while ((s = slugRe.exec(html))) slugByDisplayName.set(s[2], s[1]);
    const entryRe = /\{"id":"[^"]+","displayName":"([^"]+)","creator":\{[^}]+\},.*?"briefcaseElo":([0-9.]+),.*?"scicode":(null|[0-9.]+).*?"terminalBench40":(null|[0-9.]+)/g;
    let em;
    while ((em = entryRe.exec(html))) {
      const displayName = em[1];
      const slug = slugByDisplayName.get(displayName)
        ?? displayName.toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      if (!slug) continue;
      const profile: { gdpval?: number; briefcase?: number; coding?: number } = {};
      const briefcase = parseFloat(em[2]);
      if (Number.isFinite(briefcase)) profile.briefcase = briefcase;
      const scicode = em[3] === 'null' ? null : parseFloat(em[3]);
      const tb = em[4] === 'null' ? null : parseFloat(em[4]);
      const best = scicode != null || tb != null ? Math.max(scicode ?? 0, tb ?? 0) : null;
      if (best != null && best > 0) profile.coding = 3000 * best;
      if (Object.keys(profile).length) profiles[slug] = profile;
    }
    return profiles;
  }
```

Export it via the scan-runner module surface the same way
`extractGdpvalScores` is exposed for tests today.

**Step 4: Run test → PASS.** Commit: `feat: parse AA capability profiles from the existing scrape payload`

### Task 3: Persist + lookup (metrics.ts)

**Files:** Modify `src/metrics.ts`.

**Step 1: Failing test** (same file): after
`setCache({ capability_profiles: { 'glm-5-3': { briefcase: 1700.5 } }, available_models: [] })`,
`lookupCapability('mistral/zai-glm-5-3', 'briefcase')` returns `1700.5`;
`lookupCapability('mistral/unknown-model', 'briefcase')` returns `null`;
`lookupCapability('mistral/zai-glm-5-3', 'coding')` returns `null`
(absent column, NOT 0).

**Step 2: Implement** — mirror `lookupGdp`'s slug pipeline:

```ts
export function lookupCapability(ref: string, column: 'briefcase' | 'coding'): number | null {
  const slug = resolveSlug(ref);
  if (!slug) return null;
  const profile = (cache as Cache).capability_profiles?.[slug];
  if (!profile) return null;
  const v = profile[column];
  return typeof v === 'number' ? v : null;
}
```

and extend `setCache` to merge `capability_profiles` additively (same
pattern as `gdpval_scores`; builtins win).

**Step 3: In `scan()`** (scan-runner.ts), after the successful gdpval
extract: `rt.cache.capability_profiles = { ...rt.cache.capability_profiles, ...extractCapabilityProfiles(html) };`
— same try/catch containment, no new fetch, no new TTL flag (the existing
`gdpval_scraped` gate covers the fetch once).

**Step 4: Test PASS.** Commit: `feat: persist and look up AA capability profiles`

### Task 4: Task-type-aware scoring (calculateScore + group wiring)

**Files:** Modify `src/metrics.ts` (`calculateScore`), `src/routing.ts`
(`sortBy` best-branch), config files, test.

**Step 1: Failing test** — the routing contract:

- `planning` group (`score_by: 'briefcase'`): with profiles
  `{ 'claude-sonnet-5-5': { briefcase: 1860 }, 'claude-opus-5-5': { briefcase: 1810.2 } }`
  and gdpval 1900/1844 — **sonnet ranks FIRST** (briefcase column orders
  the group; the gdpval window is irrelevant to the floor). Opus second.
- `tactical` group (`score_by: 'coding'`): glm-5-3
  (`coding: 2130`) ranks above a model with higher gdpval but lower
  coding (`mistral-medium-3.5`, coding 1500).
- Missing profile → pure gdpval order (today's behavior, regression pin).
- `score_by` absent/`'gdpval'` → today's behavior including the quality
  window (existing `best-quality-window-max-gdpval.test.ts` must stay
  green UNCHANGED).

**Step 2: Implement.**

`calculateScore` in `src/metrics.ts`:

```ts
export function calculateScore(ref: string, column?: string, _config?: Config): number {
  // ADR-0023 round 2: the column parameter (a group's score_by) finally
  // selects the capability ranking. Fallback is the global GDPval — the
  // exact pre-round behavior for every group that sets nothing.
  if (column === 'briefcase' || column === 'coding') {
    const v = lookupCapability(ref, column);
    if (v !== null) return v;
  }
  return getM(ref).gdpval;
}
```

`src/routing.ts` `sortBy` best-branch and the quality-window pool: replace
`scoreOf = (r) => calculateScore(r, taskType, this.cfg)` so that callers
pass the GROUP's `score_by` as taskType (resolveGroup/getTopModels already
have the group config at the call site; thread `g.score_by ?? 'gdpval'`
through). The window fraction and the cost tiebreaks keep working on the
same relative scale.

**Step 3:** Wire the shipped config:
`router-config.json`: `planning.score_by: "briefcase"`,
`tactical.score_by: "coding"`; `router-defaults.yaml`: comment that
`score_by` defaults to `gdpval`.

**Step 4: Test PASS, existing window test UNCHANGED and green.**
Commit: `feat: task-type-aware best-group scoring via score_by`

### Task 5: Docs + verification sweep

**Files:** `CHANGELOG.md` (Unreleased → Changed), `README.md` (the
ADR-0023 paragraph from PR #7 extended with one sentence), this plan file
(status line → implemented).

**Step 1:** CHANGELOG entry: multi-benchmark sourcing live — planning
ranks by AA-Briefcase Elo, coding groups by the SciCode/Terminal-Bench
blend, gdpval fallback everywhere; zero new network requests (same page).

**Step 2:** Full verification: `npx tsc --noEmit && npx vitest run` →
green (expected count: current 1218/3 + new ~10).

**Step 3:** Commit, branch → PR (protected main, AGENTS.md §8), read all
external reviews before merge.

---

## Deliberate non-goals

- No new fetch/URL/TTL — the single existing scrape page carries all
  columns (verified; if AA splits them later, the parser fails closed to
  gdpval, never to an empty cache).
- No AA Pro/Data-API (paid) — the public payload suffices.
- No normalization of `automationBench`/`gdpPdf`/`omniscience` yet —
  stored only if trivially present in the entry regex; consumption comes
  when a group needs them (YAGNI).
- Floors/caps/window stay GDPval-only — a column never changes which
  models ADMITTED, only their order within the pool.

## Risks

- **AA payload drift**: the entry regex can break on redesign. Fallback
  is gdpval (today's behavior) — degrades, never breaks. The fixture test
  pins the current shape; a `router.log` line `[scan] No capability
  profiles extracted` (mirroring the existing gdpval warning) makes drift
  visible in the next scan.
- **Column gaps** (e.g. local Ollama models are unscored by AA): absent
  column → gdpval; Ollama gdpval estimates already exist and flow through
  unchanged.
- **Escaped-JSON fragility**: production normalizes `\"` before parsing —
  the test fixture applies the identical normalization.
