# Model Identity & Quality Cascade Implementation Plan

Status: **deferred 2026-11-12 — Phases A/B done elsewhere or obsolete, Phase C/D (opt-in quality cascade) open, to be re-planned after 2.0.** This plan was written on the unmerged branch `feat/quality-cascade` (2026-10-10) and covers several problems (§11), so it is kept as history and not edited further. Checked against `main` `51a2472` on 2026-11-12: D1/D2 (variant-token veto, `src/slug-matcher.ts`) and D3/D6 (capability extraction; the live cache holds 42 profiles) are fixed; D4 no longer applies (the `min_gdpval` floors are 1600-1700 per group); D5 (two sibling-pointing `model-map.yaml` entries) was fixed in PR #162. What remains is the cascaded quality score of Phase C/D, which needs the owner's weights and thresholds and overlaps the felt-quality item in `TODO.md`. Section references to `src/model-identity.ts` and `src/aa-catalog.ts` describe files that were never merged.

> **REQUIRED SUB-SKILL:** Use the executing-plans skill (or subagent-driven-development) to implement this plan task-by-task.

**Goal:** Score every routable model by the *right* Artificial Analysis (AA) record — identity-exact, never a sibling variant — and rank/gate model groups by a **cascaded quality score** in which the AA Intelligence Index caps what single benchmarks (GDPval, coding) can add.

**Architecture:** Three layers replace the single-column GDPval pipeline. (1) **Source:** one record extractor reads the AA leaderboard payloads into structured `AaModelRecord`s (intelligence index + estimate flag, GDPval Elo, Terminal-Bench, SciCode, Briefcase, creator). (2) **Identity:** a data-derived identity matcher maps a provider ref to exactly one AA record; variant tokens (`mini`, `flash`, `small`, …) are *learned from the AA catalog itself* and must agree on both sides — it also vetoes the LLM matcher and the fuzzy fallback. (3) **Quality:** per-signal percentiles over the live AA population, combined per *profile* (`general`, `coding`, `planning`), with the intelligence percentile as a ceiling. Groups gate on `min_quality`/`max_quality` and rank with `score_by: quality`.

**Tech Stack:** TypeScript (ESM, `exactOptionalPropertyTypes`), Vitest 4.1.11, esbuild bundle in `dist/`, AA public pages (Next.js RSC payload).

**Branch / worktree:** `feat/quality-cascade` in `.worktrees/quality-cascade`, based on `origin/main` (7e8503b). Independent of `laya-spike`.

---

## 0. Evidence (measured 2026-10-10)

Probe: `curl` of `https://artificialanalysis.ai/leaderboards/models` (2.4 MB, 697 model records) and `https://artificialanalysis.ai/evaluations/gdpval-aa` (1.5 MB, 31 rich records), RSC payload with `\"` → `"` normalization.

**Record fields available per model** (leaderboard page): `slug`, `name`, `shortName`, `deprecated`, `isReasoning`, `modelCreatorName`, `paramClass`, `contextWindowTokens`, **`intelligenceIndex`**, **`intelligenceIndexIsEstimated`**, **`gdpvalNormalized`** (= (Elo − 500) / 2000), `terminalBench40`, `scicode`, `hle`, `gpqa`, `lcr`, `omniscience*`, `tau2`, … The GDPval page additionally carries `release: {slug, name}` (AA's own grouping of effort variants), `suffix` (effort label, e.g. `"Max, Default Fallback"`), `creator.slug` and `briefcaseElo`.

**Coding Agent Index** (`/agents/coding-agents`): 37 rows = *agent × model* (e.g. `Opencode - GLM-5.3`), ~20 distinct frontier models, `hostModelSlug` is an internal id (not a catalog slug), per row `evals[{weight, mean.reward}]`. **No free OpenRouter model is covered.**

**Cascade simulation on real data** (population = 262 non-deprecated records with an intelligence index; percentiles; `general` = I .5 / G .3 / C .2, `coding` = I .35 / G .15 / C .5, lift cap +15, estimate ×0.9):

| AA slug | II | GDPval Elo | pI | pG | pC | Q general | Q coding | today's Elo gate |
|---|---|---|---|---|---|---|---|---|
| claude-opus-5-5 | 57.6 | 1866 | 100 | 100 | 100 | 100.0 | 100.0 | complex |
| glm-5-3 | 44.8 | 1651 | 89 | 93 | 86 | 89.7 | 88.2 | complex |
| ling-3-1-flash | 41.1 | 1622 | 85 | 89 | 77 | 84.9 | 82.0 | complex |
| apodex-1-1 (full model!) | 26.4 | 1197 | 71 | 59 | 38 | 60.8 | 52.7 | complex |
| inkling-small | 25.7 | 1123 | 69 | 55 | 46 | 60.4 | 55.5 | complex |
| gemma-4-31b | 14.7 | 623 | 55 | 33 | 38 | 45.1 | 43.3 | **complex** |
| north-mini-code | 9.9 | 500 | 37 | 27 | 23 | 31.4 | 28.8 | **standard** |

**Identity vocabulary derivation** (734 catalog slugs): letter tokens are *discriminating* when removing them from one slug yields another catalog slug's identity (word set + version tuple): `mini`, `preview`, `instruct`, `lite`, `nano`, `pro`, `vl`, `flash`, `small`, `turbo`, `coder`, `medium`, … Distribution noise (`it`, `free`, `tee`, `mlx`) is **not even known** (never appears in the catalog). AA's catalog contains **only `apodex-1-1`** — there is no Apodex Mini record.

**Identity prototype validated against live data** (throwaway script, run 2026-10-10): the full `available_models` list of the live scan cache (69 refs) plus hand-picked cases all resolve as designed. The prototype exposed three rule bugs that are already baked into the design below — (1) version numbers must be compared as an **ordered tuple**, not a set (`claude-sonnet-5-5` ≠ `claude-sonnet-5`), (2) unknown letters may only be dropped **after** the family token, never around it (`voxtral-small-latest` must NOT match `mistral-small`), (3) a version-less ref (e.g. `mistral-medium-latest`) matches a family's un-versioned base only if no numbered sibling shares the same word set (else null → model-map/LLM decides). 19/69 live refs resolve identity-exact; the rest stay with model-map/LLM/vetoed fuzzy as today.

## 1. Defects this plan closes

| # | Defect | Where | Evidence |
|---|---|---|---|
| D1 | Variant leak: `openrouter/apodex/apodex-1.1-mini:free` inherits the full model's score (token-set fuzzy match ignores `mini`) | `src/slug-matcher.ts` `matchSlug` Stage 4 | all 19 free OpenRouter refs have no model-map entry and fall through to fuzzy/LLM |
| D2 | LLM matcher and its persisted cache have no variant veto | `src/metrics.ts` `resolveSlug` Stage 1 (+ `cache.model_score_cache`) | a wrong match persists across sessions |
| D3 | Capability extraction silently dead since 2026-10-04 → `tactical` (`score_by: coding`) and `planning` (`score_by: briefcase`) rank by plain GDPval | `src/scan-runner.ts` `extractCapabilityProfiles` (entry regex `{"id":…,"displayName":…}` no longer matches) | `router.log`: "No capability profiles extracted" on 10-04, 10-05, 10-06, 10-10 |
| D4 | Fixed Elo gates broken by AA's re-anchoring (2026-09-19, DeepSeek V4.1 Flash = 1600): II 14.7 model passes `complex` (≥600) | `router-config.json` `min_gdpval` 300/500/600 | table above |
| D5 | Curated model-map has the same defect class: `openai/gpt-4o-mini: gpt-4o`; `Qwen/Qwen3-235B-A22B-Thinking-2507: …-instruct-2507` | `model-map.yaml` | AA has distinct `gpt-4o-mini` and thinking/instruct records |
| D6 | `test/aa-capability-sourcing.test.ts` pins a fixture shape that is not the live payload → green test over dead code | test fixture `RAW_FIXTURE` | live records start with `{"slug":…,"name":…,"shortName":…}` / `{"id":"<uuid>","slug":…}` |

## 2. Target design

```
AA pages ──► src/aa-catalog.ts        extractAaRecords / mergeAaRecords / extractCodingAgentRows
                │  cache.aa_models (slug → AaModelRecord), cache.aa_coding_agent_rows
                ▼
          src/model-identity.ts      tokenizeModelId / buildIdentityVocabulary /
                │                    matchIdentity / identityCompatible
                ▼
          src/metrics.ts resolveSlug:
                0  model-map.yaml (explicit, audited by test)          — unchanged authority
                1  identity exact match against the AA catalog         — NEW
                2  LLM match (fresh or cached) IF identityCompatible   — vetoed
                3  fuzzy matchSlug IF identityCompatible               — vetoed
                4  null (unscored)
                ▼
          src/quality-score.ts       PercentileIndex / qualityScore / buildQualityContext
                ▼
          metrics.lookupQuality(ref, profile) ─► routing gates min_quality / max_quality
                                               ─► calculateScore(ref, 'quality:<profile>')
```

**Cascade rule (the core):** `base = Σ wₖ·pₖ / Σ wₖ` over the *available* signals of the profile; then
1. if the intelligence percentile `pI` exists: `Q = min(base, pI + lift_cap)` — a single benchmark can lift a model at most `lift_cap` points above its general intelligence, but can pull it down freely;
2. else: `Q = base × missing_intelligence_factor`;
3. if `intelligenceIndexIsEstimated`: `Q ×= estimated_factor`.

Percentiles (not raw values) make every signal scale-free: GDPval Elo re-anchoring (D4) or a new index version cannot silently shift the gates again.

**ADR-0025 compliance:** no model names anywhere in shipped code/config. The variant vocabulary is derived from AA catalog data at runtime (persisted in cache for offline starts); weights/caps/thresholds are numbers. Provider-id noise is simply "token not in the catalog vocabulary" — no curated list.

## 3. Owner decisions (recommendation first)

| ID | Question | Recommendation |
|---|---|---|
| OD1 | Hosted id without effort suffix (e.g. `zai-glm-5-3`) → which AA effort variant? | AA's base record (`glm-5-3` = "Max"); AA itself uses it as the model's representative. Alternative: lowest/median effort (more conservative). |
| OD2 | Coding Agent Index | Sparse refinement only: weight applies when present, absent = no penalty. Per model = **max** over harness rows (best demonstrated capability). |
| OD3 | Default profile weights / factors | `general` I .5 G .3 TB .1 SCI .1; `coding` I .35 TB .30 SCI .10 G .10 CA .15; `planning` I .5 G .4 BC .1; `lift_cap` 15, `estimated_factor` 0.9, `missing_intelligence_factor` 0.85 |
| OD4 | Gate migration | Opt-in first (PR-2), thresholds chosen by the owner from `scripts/quality-report.ts` on the live cache, shipped-config flip in its own PR-3. |
| OD5 | Data source | Public pages (as today, no key). AA's documented API (`/api/v2/language/models/free`, `x-api-key`, attribution required) as a later optional adapter — key via env `AA_API_KEY`, never `auth.json` (ADR-0022). |
| OD6 | Model with no AA record (e.g. `apodex-1.1-mini`) | Unscored → only in groups without a quality floor (trivial/simple/scout/fallback). |
| OD7 | model-map entries failing the identity audit | Fix to the identity-correct slug, or `~` when AA has no record. |

## 4. PR slicing

| PR | Content | Closes | Routing-policy change |
|---|---|---|---|
| PR-1 `fix:` | Phase A + B: AA records source, identity matcher + vetoes, model-map audit, capability profiles restored | D1 D2 D3 D5 D6 | none beyond correct data |
| PR-2 `feat:` | Phase C: quality cascade, `score_by: quality`, `min/max_quality`, profiles, report script | — | opt-in only |
| PR-3 `feat:` | Phase D: shipped groups gate/rank on quality (owner thresholds) | D4 | yes (owner-approved) |

Every PR: §4 red-first with named red evidence, `npx tsc --noEmit`, `npx vitest run` (count ratchets), coverage thresholds unchanged, `npm run build`, §8 all three review endpoints read before merge.

---

## Phase 0 — Preflight

### Task 0.1: Baseline

**Step 1:** `cd .worktrees/quality-cascade && npm install` (wires the pre-push hook).
**Step 2:** §10 host check: `pi --version` vs `npm ls @earendil-works/pi-coding-agent`. Mismatch → report to owner before continuing.
**Step 3:** `npx tsc --noEmit && npx vitest run 2>&1 | tail -5` — record the passed/skipped baseline in the PR body.

### Task 0.2: ADR-0028 (Proposed)

**Files:** Create `docs/adr/0028-model-identity-and-quality-cascade.md`; Modify `docs/adr/README.md` (index row).

Sections: Context (§0 evidence, D1–D6), Decision (§2 design + cascade rule), Consequences (scale-free gates, ADR-0023 `min/max_gdpval` superseded for shipped groups after PR-3, data-source drift risk), Owner decisions (§3 table, status per item).

**Commit:** `docs: ADR-0028 model identity + quality cascade (proposed)`

---

## Phase A — AA records source

### Task A1: Real-payload fixtures

**Files:** Create `test/fixtures/aa/leaderboard-models.sample.txt`, `test/fixtures/aa/gdpval-aa.sample.txt`, `test/fixtures/aa/coding-agents.sample.txt`, `test/fixtures/aa/catalog-slugs.json`.

**Step 1:** Fetch into an empty directory (untrusted data):
```bash
mkdir -p /tmp/aa-fixture-src && cd /tmp/aa-fixture-src
curl -s -A 'Mozilla/5.0' https://artificialanalysis.ai/leaderboards/models -o models.html
curl -s -A 'Mozilla/5.0' https://artificialanalysis.ai/evaluations/gdpval-aa -o gdpval.html
curl -s -A 'Mozilla/5.0' https://artificialanalysis.ai/agents/coding-agents -o ca.html
```

**Step 2:** Cut whole record chunks (normalized quotes) for these slugs — keep each chunk byte-exact from record start to the next record start: `apodex-1-1`, `ling-3-1-flash`, `ling-3-0-flash`, `gemma-4-31b`, `gemma-4-31b-non-reasoning`, `gemma-4-26b-a4b`, `glm-5-3`, `glm-5-3-low`, `glm-5-3-flash`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-sonnet-5-5-low`, `inkling`, `inkling-small`, `north-mini-code`, `gpt-4o`, `gpt-4o-mini`, `nvidia-nemotron-3-super-120b-a12b`, `mistral-large-3` (deprecated). From the GDPval page: `claude-opus-5-5`, `glm-5-3` (records carrying `release`/`suffix`/`briefcaseElo`). From the coding-agents page: the rows `Opencode - GLM-5.3 …` and `Claude Code - Opus 5.5 (max)`. Write a short throwaway cutter in `/tmp/aa-fixture-tools/cut.py` (run with `python3 -I`, paths as arguments) — not committed.

**Step 3:** `catalog-slugs.json` = the full slug list of the leaderboard catalog (`{"slug":"…","name":"…","deprecated"` entries ∪ record slugs), ~734 strings — the vocabulary tests run on real data.

**Step 4:** `npx tsx scripts/<secret-scan entry>` is not needed for fixtures, but the pre-push hook will scan them; they contain only public benchmark data.

**Commit:** `test: real AA payload fixtures (2026-10-10 cut)`

### Task A2: `extractAaRecords`

**Files:** Create `src/aa-catalog.ts`; Test `test/aa-catalog.test.ts`.

**Step 1: failing test**
```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { extractAaRecords, mergeAaRecords } from '../src/aa-catalog.js';

const lb = fs.readFileSync('test/fixtures/aa/leaderboard-models.sample.txt', 'utf-8');
const gd = fs.readFileSync('test/fixtures/aa/gdpval-aa.sample.txt', 'utf-8');

describe('extractAaRecords — leaderboard page', () => {
  const recs = extractAaRecords(lb);
  const bySlug = new Map(recs.map((r) => [r.slug, r]));

  it('reads the intelligence index, estimate flag and creator', () => {
    const a = bySlug.get('apodex-1-1')!;
    expect(a.intelligenceIndex).toBeCloseTo(26.41, 2);
    expect(a.intelligenceIndexEstimated).toBe(false);
    expect(a.creator).toBe('apodex');
    expect(bySlug.get('gemma-4-26b-a4b')!.intelligenceIndexEstimated).toBe(true);
  });

  it('converts gdpvalNormalized to Elo (500 + 2000·n)', () => {
    expect(bySlug.get('apodex-1-1')!.gdpvalElo).toBeCloseTo(1196.85, 1);
    expect(bySlug.get('glm-5-3')!.gdpvalElo).toBeCloseTo(1650.73, 1);
  });

  it('keeps effort variants as distinct records', () => {
    expect(bySlug.get('glm-5-3')!.intelligenceIndex).toBeGreaterThan(bySlug.get('glm-5-3-low')!.intelligenceIndex!);
  });

  it('missing field is null, never 0', () => {
    expect(bySlug.get('gemma-4-26b-a4b')!.terminalBench40).toBeNull();
  });

  it('nested creator objects are never mistaken for model records', () => {
    expect(bySlug.has('anthropic')).toBe(false);
  });

  it('unrecognized payload yields []', () => {
    expect(extractAaRecords('<html>nothing</html>')).toEqual([]);
  });
});

describe('extractAaRecords — gdpval page', () => {
  it('reads release grouping, effort suffix and briefcase', () => {
    const r = extractAaRecords(gd).find((x) => x.slug === 'claude-opus-5-5')!;
    expect(r.releaseSlug).toBe('claude-opus-5-5');
    expect(r.effortSuffix).toBe('Max, Default Fallback');
    expect(r.briefcaseElo).toBeCloseTo(1807.05, 2);
  });
});

describe('mergeAaRecords', () => {
  it('fills nulls from the second source without overwriting values', () => {
    const merged = mergeAaRecords(extractAaRecords(lb), extractAaRecords(gd));
    const r = merged['claude-opus-5-5'];
    expect(r.briefcaseElo).not.toBeNull();
    expect(r.intelligenceIndex).toBeCloseTo(57.62, 2);
  });
});
```

**Step 2:** `npx vitest run test/aa-catalog.test.ts` → FAIL (module missing). Then stub the exports returning `[]`/`{}` and re-run → assertion failures = the red evidence to name in the report.

**Step 3: implementation**
```ts
// src/aa-catalog.ts
/**
 * Structured reader for Artificial Analysis leaderboard payloads (ADR-0028).
 * Input is the page HTML with \" already normalized to ". Each model record
 * starts with `{"slug":"…","name":"…","shortName":` (leaderboard page) or
 * `{"id":"<uuid>","slug":"…","name":"…","shortName":` (evaluation pages);
 * nested creator objects never carry `shortName`, so they cannot start a
 * record. Fields are read inside ONE record chunk only. Fail-closed: an
 * unrecognized payload yields [].
 */
export interface AaModelRecord {
  slug: string;
  name: string;
  creator: string | null;
  releaseSlug: string | null;
  effortSuffix: string | null;
  deprecated: boolean;
  isReasoning: boolean | null;
  intelligenceIndex: number | null;
  intelligenceIndexEstimated: boolean;
  gdpvalElo: number | null;
  terminalBench40: number | null;
  scicode: number | null;
  briefcaseElo: number | null;
}

const RECORD_START = /\{(?:"id":"[0-9a-f-]{36}",)?"slug":"([^"]+)","name":"([^"]+)","shortName":/g;

function field(chunk: string, key: string): unknown {
  const m = new RegExp(`"${key}":(null|true|false|-?[0-9.eE+-]+|"(?:[^"\\\\]|\\\\.)*")`).exec(chunk);
  if (!m) return undefined;
  try { return JSON.parse(m[1]); } catch { return undefined; }
}
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function extractAaRecords(html: string): AaModelRecord[] {
  const starts: { idx: number; slug: string; name: string }[] = [];
  let m: RegExpExecArray | null;
  RECORD_START.lastIndex = 0;
  while ((m = RECORD_START.exec(html))) starts.push({ idx: m.index, slug: m[1], name: m[2] });
  const out: AaModelRecord[] = [];
  for (let i = 0; i < starts.length; i++) {
    const { idx, slug, name } = starts[i];
    const chunk = html.slice(idx, i + 1 < starts.length ? starts[i + 1].idx : idx + 20_000);
    const creatorSlug = /"creator":\{"id":"[^"]+","slug":"([^"]+)"/.exec(chunk)?.[1];
    const creatorName = field(chunk, 'modelCreatorName');
    const release = /"release":\{"slug":"([^"]+)"/.exec(chunk)?.[1] ?? null;
    const gdpN = num(field(chunk, 'gdpvalNormalized'));
    out.push({
      slug,
      name,
      creator: creatorSlug ?? (typeof creatorName === 'string' ? slugify(creatorName) : null),
      releaseSlug: release,
      effortSuffix: typeof field(chunk, 'suffix') === 'string' ? (field(chunk, 'suffix') as string) : null,
      deprecated: field(chunk, 'deprecated') === true,
      isReasoning: typeof field(chunk, 'isReasoning') === 'boolean' ? (field(chunk, 'isReasoning') as boolean) : null,
      intelligenceIndex: num(field(chunk, 'intelligenceIndex')),
      intelligenceIndexEstimated: field(chunk, 'intelligenceIndexIsEstimated') === true,
      gdpvalElo: gdpN === null ? null : Math.round((500 + 2000 * gdpN) * 100) / 100,
      terminalBench40: num(field(chunk, 'terminalBench40')),
      scicode: num(field(chunk, 'scicode')),
      briefcaseElo: num(field(chunk, 'briefcaseElo')),
    });
  }
  return out;
}

/** Merge record lists by slug: later sources only fill fields that are still null. */
export function mergeAaRecords(...sources: AaModelRecord[][]): Record<string, AaModelRecord> {
  const out: Record<string, AaModelRecord> = {};
  for (const list of sources) {
    for (const r of list) {
      const prev = out[r.slug];
      if (!prev) { out[r.slug] = { ...r }; continue; }
      for (const k of Object.keys(r) as (keyof AaModelRecord)[]) {
        if (prev[k] === null && r[k] !== null) (prev as any)[k] = r[k];
      }
    }
  }
  return out;
}
```
Note: `slugify('Z AI')` gives `z-ai`; creator comparisons later go through `tokenizeModelId`, so spelling differences (`zai` vs `z-ai`) are tolerated by token stripping (Task B3).

**Step 4:** test green. **Step 5:** commit `feat: structured AA record extractor (ADR-0028 source layer)`.

### Task A3: Coding Agent rows

**Files:** Modify `src/aa-catalog.ts`; Test `test/aa-catalog.test.ts`.

**Step 1: failing test** — `extractCodingAgentRows(fixture)` returns `{ label, modelName, modelCreator, index }`; for the `Opencode - GLM-5.3 …` row: `modelName` is the `display.model` string, `modelCreator` = first `modelCreators[].slug`, `index` = Σ `weight × mean.reward` over `evals` (pin the value computed from the fixture). A row with `isUnavailable: true` is skipped.

**Step 2–4:** implement with the same chunking approach (rows start at `{"id":"<32 hex>","isDefault":`), compute the index, green.

**Step 5:** commit `feat: extract AA Coding Agent Index rows`.

### Task A4: Scan integration + restore capability profiles (D3, D6)

**Files:** Modify `router-defaults.yaml` (add `aa_leaderboard_url: https://artificialanalysis.ai/leaderboards/models`, `aa_coding_agents_url: https://artificialanalysis.ai/agents/coding-agents`), `src/types.ts` (`Defaults` gains both urls; `Cache` gains `aa_models?: Record<string, AaModelRecord>`, `aa_coding_agent_rows?: CodingAgentRow[]`, `aa_identity_vocab?: { known: string[]; discriminating: string[] }`), `index.ts` (pass the urls into `createScanRunner` deps next to `GDPVAL_URL`), `src/scan-runner.ts` (`scan()`), `src/metrics.ts` (`setCache` mirrors `aa_models`); Test: extend `test/scan-sanity.test.ts` or create `test/scan-aa-records.test.ts` following its fetch-mock pattern; rewrite the fixture in `test/aa-capability-sourcing.test.ts` to the real shape (D6).

**Step 1: failing tests**
1. With fetch mocked to return the two fixture pages: after `scan(true)`, `cache.aa_models['apodex-1-1'].intelligenceIndex ≈ 26.41`; `cache.gdpval_scores['glm-5-3'] ≈ 1650.73`; `cache.capability_profiles['glm-5-3'].coding` = `round(3000·max(sci, tb40), 2)`; `cache.capability_profiles['claude-opus-5-5'].briefcase ≈ 1807.05`.
2. Sanity floor: a payload with < `MIN_AA_RECORDS` (100) records → previous `cache.aa_models` is kept and `warnLog` (not `routerLog`) is called with "AA payload shape may have drifted".
3. `aa-capability-sourcing.test.ts`: replace `RAW_FIXTURE` with the real cut (Task A1); its existing assertions must go **red against the current `extractCapabilityProfiles`** — that is the D6 red evidence.

**Step 2:** run → red (record the three red outputs).

**Step 3: implementation** in `scan()` inside the existing `if (!rt.cache.gdpval_scraped || force)` block:
- fetch the leaderboard page as well (same headers/timeout); `const records = mergeAaRecords(extractAaRecords(lbHtml), extractAaRecords(gdpvalHtml));`
- `if (Object.keys(records).length >= MIN_AA_RECORDS) { rt.cache.aa_models = records; } else { warnLog('[scan] AA payload shape may have drifted: …'); }`
- derived Elo: `const derived = Object.fromEntries(Object.values(rt.cache.aa_models ?? {}).filter(r => r.gdpvalElo !== null).map(r => [r.slug, r.gdpvalElo!]));` then `metricsModule.setGdpval({ ...scores, ...derived })` (legacy extraction stays as fallback for slugs only it knows).
- capability profiles: re-implement `extractCapabilityProfiles` on top of `extractAaRecords` (same output contract: `coding = Math.round(3000 * Math.max(sci ?? 0, tb ?? 0) * 100) / 100` when > 0; `briefcase = briefcaseElo`). Its "nothing extracted" message becomes `warnLog` — a dead capability column must be loud.
- coding agents: fetch `aa_coding_agents_url`, `rt.cache.aa_coding_agent_rows = extractCodingAgentRows(html)` (fail-closed: keep previous on 0 rows).

**Step 4:** green + full suite. **Step 5:** commit `fix: AA records feed gdpval + capability profiles again (dead since 2026-10-04)` — body names D3/D6 and the router.log evidence.

---

## Phase B — Identity

### Task B1: Tokenizer + vocabulary

**Files:** Create `src/model-identity.ts`; Test `test/model-identity.test.ts`.

**Step 1: failing tests**
```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { tokenizeModelId, buildIdentityVocabulary } from '../src/model-identity.js';

const slugs: string[] = JSON.parse(fs.readFileSync('test/fixtures/aa/catalog-slugs.json', 'utf-8'));

describe('tokenizeModelId', () => {
  it.each([
    ['openrouter/apodex/apodex-1.1-mini:free', ['apodex', '1', '1', 'mini', 'free']],
    ['openrouter/google/gemma-4-26b-a4b-it:free', ['gemma', '4', '26b', 'a4b', 'it', 'free']],
    ['ollama/gemma4:12b-mlx', ['gemma', '4', '12b', 'mlx']],
    ['qwen3-8-2-4t-a95b', ['qwen', '3', '8', '2', '4t', 'a95b']],
    ['mistral/mistral-medium-3.5', ['mistral', 'medium', '3', '5']],
  ])('%s', (id, toks) => expect(tokenizeModelId(id)).toEqual(toks));
});

describe('buildIdentityVocabulary (real AA catalog)', () => {
  const v = buildIdentityVocabulary(slugs);
  it('learns variant tokens from sibling slugs', () => {
    for (const t of ['mini', 'flash', 'small', 'pro', 'nano', 'lite', 'preview', 'turbo']) {
      expect(v.discriminating.has(t), t).toBe(true);
    }
  });
  it('distribution noise is not even known', () => {
    for (const t of ['it', 'free', 'tee', 'mlx']) expect(v.known.has(t), t).toBe(false);
  });
});
```

**Step 2:** red. **Step 3: implementation**
```ts
// src/model-identity.ts
/**
 * Model identity (ADR-0028): which AA record IS this provider ref?
 * Variant vocabulary is LEARNED from the AA catalog — a letter token is
 * "discriminating" when removing it from one catalog slug yields another
 * slug's identity. Identity = word SET (letters + size tokens) plus the
 * ORDERED tuple of version numbers (claude-sonnet-5-5 ≠ claude-sonnet-5:
 * different tuples). Tokens the catalog never uses (it, free, tee, mlx)
 * are provider noise. No model names live in this file (ADR-0025).
 */
const TOKEN_RE = /a\d+b|\d+[bt](?![a-z])|[a-z]+|\d+/g;

export function tokenizeModelId(id: string): string[] {
  const lower = id.toLowerCase();
  const tail = lower.slice(lower.lastIndexOf('/') + 1).replace(/\./g, '-');
  return tail.match(TOKEN_RE) ?? [];
}

export interface IdentityVocabulary {
  known: Set<string>;
  discriminating: Set<string>;
}

export const isLetter = (t: string) => /^[a-z]+$/.test(t);
const isNum = (t: string) => /^\d+$/.test(t);
/** Identity key: word set (letters + size tokens) + ordered version tuple. */
const key = (toks: string[]) =>
  [...new Set(toks.filter((t) => !isNum(t)))].sort().join('|') + '#' + toks.filter(isNum).join('.');

export function buildIdentityVocabulary(slugs: Iterable<string>): IdentityVocabulary {
  const known = new Set<string>();
  const sets = new Map<string, string>();
  const all: string[][] = [];
  for (const s of slugs) {
    const toks = tokenizeModelId(s);
    all.push(toks);
    for (const t of toks) if (isLetter(t)) known.add(t);
    sets.set(key(toks), s);
  }
  const discriminating = new Set<string>();
  for (const toks of all) {
    for (const t of new Set(toks)) {
      if (!isLetter(t)) continue;
      const rest = toks.filter((x) => x !== t);
      if (rest.length && sets.has(key(rest))) discriminating.add(t);
    }
  }
  return { known, discriminating };
}
```

**Step 4:** green. **Step 5:** commit `feat: model identity tokenizer + catalog-derived variant vocabulary`.

### Task B2: `matchIdentity` + `identityCompatible`

**Files:** Modify `src/model-identity.ts`; Test `test/model-identity.test.ts`.

**Step 1: failing tests** (catalog entries built from the A1 leaderboard fixture via `extractAaRecords`, vocabulary from `catalog-slugs.json`):
```ts
it.each([
  ['openrouter/apodex/apodex-1.1-mini:free', null],                 // D1: no Mini record exists
  ['openrouter/inclusionai/ling-3.1-flash', 'ling-3-1-flash'],
  ['openrouter/google/gemma-4-31b-it:free', 'gemma-4-31b'],          // base, not -non-reasoning
  ['openrouter/thinkingmachines/inkling-small:free', 'inkling-small'],
  ['openrouter/thinkingmachines/inkling:free', 'inkling'],
  ['mistral/zai-glm-5-3', 'glm-5-3'],                               // 'zai' = compact creator name, stripped
  ['openrouter/nvidia/nemotron-3-super-120b-a12b:free', 'nvidia-nemotron-3-super-120b-a12b'],
  ['openrouter/cohere/north-mini-code:free', 'north-mini-code'],
  ['openrouter/poolside/laguna-s-2.1:free', null],                  // family unknown to AA
  ['openai/gpt-4o-mini', 'gpt-4o-mini'],
  ['claude-bridge/claude-sonnet-5-5', 'claude-sonnet-5-5'],          // version tuple, not set
  ['mistral/voxtral-small-latest', null],                          // unknown family word must not vanish
  ['mistral/mistral-medium-latest', null],                         // ambiguous family (numbered siblings)
  ['mistral/mistral-small-latest', 'mistral-small'],                // hmm — see Step 2 note
])('matchIdentity(%s) → %s', (ref, slug) => {
  expect(matchIdentity(ref, catalog, vocab)?.slug ?? null).toBe(slug);
});

it('vetoes variant mismatches, tolerates effort and date differences', () => {
  expect(identityCompatible('openrouter/apodex/apodex-1.1-mini:free', 'apodex-1-1', catalog, vocab)).toBe(false);
  expect(identityCompatible('openai/gpt-4o-mini', 'gpt-4o', catalog, vocab)).toBe(false);
  expect(identityCompatible('mistral/zai-glm-5-3', 'glm-5-3-low', catalog, vocab)).toBe(true);
  expect(identityCompatible('mistral/mistral-medium-2604', 'mistral-medium-3-5', catalog, vocab)).toBe(true);
});
```
**Step 2 note:** before writing the implementation, run the case list against the fixture catalog and check which `-latest` refs are genuinely ambiguous (`mistral-medium-2603/2604` vs `mistral-medium-3-5` era). The version-less guard returns null when ANY numbered sibling shares the base's word set — verify against the fixture whether `mistral-small` has such a sibling and set the expected value accordingly. The prototype run (2026-10-10) returned null for ALL `-latest` refs of families with numbered siblings.
(If `mistral-medium-3-5` is not in the fixture catalog, add a hand-written entry `{slug:'mistral-medium-3-5', name:'Mistral Medium 3.5', creator:'mistral'}` in the test — tests may use model literals.)

**Step 2:** red. **Step 3: implementation**
```ts
export interface CatalogEntry { slug: string; name?: string | null; creator?: string | null }
export interface IdentityMatch { slug: string; kind: 'exact' | 'variant-base' }

/** Letter tokens of the record's own effort/mode annotation: "GLM-5.3 (Low)" → {low}. */
function effortTokens(e: CatalogEntry): Set<string> {
  const out = new Set<string>();
  for (const m of (e.name ?? '').matchAll(/\(([^)]*)\)/g)) for (const t of tokenizeModelId(m[1])) if (isLetter(t)) out.add(t);
  return out;
}

const compact = (c: string | null | undefined) => (c ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
/** Org segment of a 3+-part ref (openrouter/<org>/<id>) — stripped from BOTH sides. */
function orgTokens(ref: string): string[] {
  const segs = ref.toLowerCase().split('/');
  return segs.length >= 3 ? tokenizeModelId(segs[segs.length - 2]) : [];
}
/** Creator tokens for one record: slugified ('z-ai'), compacted ('zai'), plus the ref's org segment. */
function creatorTokens(ref: string, e: CatalogEntry): Set<string> {
  return new Set([...orgTokens(ref), ...tokenizeModelId(e.creator ?? ''), compact(e.creator)].filter(Boolean));
}

const words = (toks: string[]) => new Set(toks.filter((t) => !isNum(t)));   // letters + size tokens
const nums = (toks: string[]) => toks.filter(isNum).join('.');               // ORDERED version tuple
const minus = (a: Set<string>, b: Iterable<string>) => { const s = new Set(a); for (const x of b) s.delete(x); return s; };
const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * Ref tokens for ONE record candidate: creator/org stripped, family (first word
 * token) must be catalog-known; unknown letter tokens AFTER the family are
 * provider noise and dropped; unknown tokens BEFORE/AROUND the family are not
 * (voxtral-small ≠ mistral-small). Size tokens and numbers always kept.
 */
function refTokensFor(ref: string, e: CatalogEntry, vocab: IdentityVocabulary): string[] | null {
  const cr = creatorTokens(ref, e);
  const toks = tokenizeModelId(ref).filter((t) => !cr.has(t));
  const fi = toks.findIndex((t) => !isNum(t));
  if (fi < 0) return null;
  const family = toks[fi];
  if (!(isLetter(family) ? vocab.known.has(family) : true) || family.length < 2) return null;
  return toks.filter((t, i) => i === fi || !isLetter(t) || vocab.known.has(t));
}

export function matchIdentity(ref: string, catalog: CatalogEntry[], vocab: IdentityVocabulary): IdentityMatch | null {
  let best: { e: CatalogEntry; kind: IdentityMatch['kind']; extra: number; ref: string[] } | null = null;
  for (const e of catalog) {
    const base = refTokensFor(ref, e, vocab);
    if (!base) continue;
    const cr = creatorTokens(ref, e);
    const slugToks = tokenizeModelId(e.slug).filter((t) => !cr.has(t));
    if (nums(base) !== nums(slugToks)) continue;                     // version tuple must match
    const r = words(base);
    const s = words(slugToks);
    let kind: IdentityMatch['kind'] | null = null;
    let extra = 0;
    if (sameSet(r, s)) kind = 'exact';
    else if ([...r].every((t) => s.has(t))) {                        // slug has extra tokens
      const ex = minus(s, r);
      const eff = effortTokens(e);
      if ([...ex].every((t) => eff.has(t))) { kind = 'variant-base'; extra = ex.size; }
    }
    if (!kind) continue;
    const better = !best
      || (kind === 'exact' && best.kind !== 'exact')
      || (kind === best.kind && (extra < best.extra
        || (extra === best.extra && (e.slug.length < best.e.slug.length
          || (e.slug.length === best.e.slug.length && e.slug < best.e.slug)))));
    if (better) best = { e, kind, extra, ref: base };
  }
  if (!best) return null;
  // Version-less ref (no numbers in its tokens): only identity-safe when the
  // family has no numbered sibling sharing the base's word set — otherwise the
  // alias is ambiguous (mistral-medium-latest could be several generations).
  if (nums(best.ref) === '') {
    const w = words(tokenizeModelId(best.e.slug).filter((t) => !creatorTokens(ref, best.e).has(t)));
    const ambiguous = catalog.some((e) => {
      const st = tokenizeModelId(e.slug).filter((t) => !creatorTokens(ref, e).has(t));
      return nums(st) !== '' && sameSet(words(st), w);
    });
    if (ambiguous) return null;
  }
  return { slug: best.e.slug, kind: best.kind };
}

/** Veto for non-identity matchers: discriminating tokens must agree (effort/date ignored). */
export function identityCompatible(ref: string, slug: string, catalog: CatalogEntry[], vocab: IdentityVocabulary): boolean {
  const entry = catalog.find((e) => e.slug === slug) ?? { slug };
  const d = (toks: Iterable<string>, drop: Set<string>) =>
    new Set([...toks].filter((t) => vocab.discriminating.has(t) && !drop.has(t)));
  const r = d(tokenizeModelId(ref).filter((t) => !isLetter(t) || vocab.known.has(t)), new Set());
  const s = d(tokenizeModelId(slug), effortTokens(entry));
  return sameSet(r, s);
}
```
This is the exact rule set the validated prototype runs (all 30+ hand-picked cases green, 19/69 live refs identity-exact). Edge to keep in mind: `medium` is discriminating (effort siblings) **and** a tier word (`mistral-medium-3-5`) — both sides carry it, so `identityCompatible` holds. If a test disagrees, fix the rule — do not special-case the word.

**Step 4:** green. **Step 5:** commit `feat: identity-exact AA matching with variant veto`.

### Task B3: Wire into `resolveSlug` (D1, D2)

**Files:** Modify `src/metrics.ts` (`resolveSlug`, new memoized `identityCatalog()` / `identityVocab()`), Test `test/resolve-slug-identity.test.ts`.

**Step 1: failing tests** (pattern from `test/calculate-score.test.ts`: `setConfig`/`setCache`/`setGdpval`):
1. `setGdpval({ 'apodex-1-1': 1197.35, 'gpt-5-4': 1500, 'gpt-5-4-mini': 1100 })`, no `aa_models`: `resolveSlug('openrouter/apodex/apodex-1.1-mini:free')` → `null`. **Today it returns `'apodex-1-1'`** — that output is the D1 red evidence.
2. LLM veto: `setLlmMatches({ 'openrouter/apodex/apodex-1.1-mini:free': 'apodex-1-1' })` → still `null`.
3. Cached veto: `setCache({ model_score_cache: { '<same ref>': 'apodex-1-1' } })` → `null`.
4. Identity first: with `aa_models` from the A1 fixture, `resolveSlug('mistral/zai-glm-5-3')` → `'glm-5-3'` even if an LLM match says `'glm-5-3-flash'` (exact identity beats LLM).
5. Unchanged authority: a model-map entry still wins (use an existing entry such as `glm-5-2-tee → glm-5-2`).

**Step 2:** red (record 1–4). **Step 3: implementation**
- `identityCatalog()`: entries = `Object.values(cache.aa_models ?? {})` ∪ `{slug}` for every key of the current scores map and of `cfg.gdpval_builtin` not already present. Memoize on `(gdpvalVersion, aa_models object identity, builtin key count)` like `getSlugCanon`.
- `identityVocab()`: `buildIdentityVocabulary(catalog slugs)`; if the AA catalog is empty, fall back to `cache.aa_identity_vocab` (persisted by scan in A4 — add the write there) so an offline start keeps the veto strength.
- In `resolveSlug`, after the model-map stage and canon computation:
```ts
const catalog = identityCatalog();
const vocab = identityVocab(catalog);
const id = matchIdentity(ref, catalog, vocab);
if (id) return canon.get(id.slug) ?? id.slug;
const ok = (slug: string | null | undefined): slug is string =>
  typeof slug === 'string' && identityCompatible(ref, slug, catalog, vocab);
if (ok(llmModelMatches[ref])) return canon.get(llmModelMatches[ref]) ?? llmModelMatches[ref];
const cached = (cache as any)?.model_score_cache?.[ref];
if (ok(cached)) return canon.get(cached) ?? cached;
const matched = matchSlug(ref, slugKeys);
if (matched === null) return null;            // explicit exclusion (shouldExclude)
if (!ok(matched)) return undefined;           // vetoed → unscored
return canon.get(matched) ?? matched;
```
(Keep the existing return-type contract: `null` = excluded, `undefined` = unknown.)

**Step 4:** full suite. Existing expectations in `test/slug-resolution.test.ts`, `test/unified-slug-resolution.test.ts`, `test/model-map-live.test.ts`, `test/slug-matcher-latest-dates.test.ts`, `test/get-top-models-dedup.test.ts` may change. For each failure decide explicitly: (a) the old expectation encoded a variant leak → update the test with a comment naming D1; (b) a real regression → fix the rule. List every changed expectation in the commit body.

**Step 5:** commit `fix: identity veto for LLM/cached/fuzzy slug matches (mini ≠ full model)`.

### Task B4: model-map audit (D5)

**Files:** Create `test/model-map-identity-audit.test.ts`; Modify `model-map.yaml` (repo root; the build copies it to `dist/`).

**Step 1: failing test:** parse `model-map.yaml` (same parser as production `mapLookup`'s loader — import it, do not re-implement); for every non-null, non-wildcard entry assert `identityCompatible(key, value, catalog, vocab)` against the fixture catalog + vocabulary. Expected red: `openai/gpt-4o-mini → gpt-4o`, `Qwen/Qwen3-235B-A22B-Thinking-2507 → qwen3-235b-a22b-instruct-2507` (and whatever else it finds — list them all in the report).

**Step 2:** red, with the violation list as evidence. **Step 3:** fix each entry per OD7 (identity-correct slug if AA has one, else `~`). **Step 4:** green + suite. **Step 5:** commit `fix: model-map entries that mapped variants onto their base model`.

### Task B5: Coding Agent rows → catalog

**Files:** Modify `src/aa-catalog.ts` (or `src/quality-score.ts`), Test accordingly.

**Step 1: failing test:** `codingAgentIndexBySlug(rows, catalog, vocab)` maps `Opencode - GLM-5.3 …` to `glm-5-3` (name with parentheticals removed, creator from `modelCreator`) and returns the **max** index per slug (OD2) when several harness rows exist.
**Step 2–5:** implement via `matchIdentity(\`${row.modelCreator}/${row.modelName.replace(/\(.*?\)/g, '')}\`, …)`, green, commit `feat: map Coding Agent Index rows onto AA identities`.

**→ Open PR-1** (`fix: identity-exact AA matching + live AA records`), body: D1/D2/D3/D5/D6, red evidence per task, suite count, review endpoints.

---

## Phase C — Quality cascade (opt-in)

### Task C1: `PercentileIndex` + `qualityScore`

**Files:** Create `src/quality-score.ts`; Test `test/quality-score.test.ts`.

**Step 1: failing tests** (synthetic numbers — the rule, not the data):
```ts
import { describe, it, expect } from 'vitest';
import { PercentileIndex, qualityScore, type QualityProfile } from '../src/quality-score.js';

const idx = (vals: number[]) => new PercentileIndex(vals);
const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const ctx = { intelligence: idx(ten), gdpval: idx(ten), terminalBench: idx(ten), scicode: idx(ten), briefcase: idx(ten), codingAgent: idx(ten) };
const opts = { lift_cap: 15, estimated_factor: 0.9, missing_intelligence_factor: 0.85 };
const general: QualityProfile = { intelligence: 0.5, gdpval: 0.5 };

describe('qualityScore', () => {
  it('percentile rank is ≤-inclusive', () => expect(idx(ten).rank(5)).toBe(50));
  it('intelligence caps the lift of a single benchmark', () => {
    // pI = 50, pG = 100 → base 75, cap 50 + 15 = 65
    expect(qualityScore({ intelligence: 5, gdpval: 10 }, ctx, general, opts)).toBe(65);
  });
  it('a weak benchmark pulls down freely', () => {
    expect(qualityScore({ intelligence: 10, gdpval: 1 }, ctx, general, opts)).toBe(55);
  });
  it('missing intelligence → factor, no cap', () => {
    expect(qualityScore({ gdpval: 10 }, ctx, general, opts)).toBe(85);
  });
  it('estimated intelligence → factor', () => {
    expect(qualityScore({ intelligence: 10, gdpval: 10, estimated: true }, ctx, general, opts)).toBe(90);
  });
  it('absent signals renormalize; no signals → null', () => {
    expect(qualityScore({ intelligence: 8 }, ctx, { intelligence: 0.5, codingAgent: 0.5 }, opts)).toBe(80);
    expect(qualityScore({}, ctx, general, opts)).toBeNull();
  });
});
```

**Step 2:** red. **Step 3: implementation**
```ts
// src/quality-score.ts
/**
 * Cascaded quality score (ADR-0028). Every signal becomes a percentile
 * (0..100) against the live AA population, so Elo re-anchoring or index
 * re-versioning cannot shift gates. Intelligence is the ceiling: other
 * signals may lift a model at most `lift_cap` points above its
 * intelligence percentile but can pull it down freely.
 */
export type SignalKey = 'intelligence' | 'gdpval' | 'terminalBench' | 'scicode' | 'briefcase' | 'codingAgent';
export type QualityProfile = Partial<Record<SignalKey, number>>;
export type QualitySignals = Partial<Record<SignalKey, number | null>> & { estimated?: boolean };
export interface QualityOptions { lift_cap: number; estimated_factor: number; missing_intelligence_factor: number }
export type QualityContext = Record<SignalKey, PercentileIndex>;

export class PercentileIndex {
  private readonly sorted: number[];
  constructor(values: Iterable<number>) {
    this.sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  }
  get size(): number { return this.sorted.length; }
  /** 100 · |{v ≤ x}| / n; null on an empty population. */
  rank(x: number): number | null {
    const n = this.sorted.length;
    if (!n) return null;
    let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.sorted[mid] <= x) lo = mid + 1; else hi = mid; }
    return (100 * lo) / n;
  }
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export function qualityScore(sig: QualitySignals, ctx: QualityContext, profile: QualityProfile, o: QualityOptions): number | null {
  let wSum = 0, acc = 0, pI: number | null = null;
  for (const k of Object.keys(profile) as SignalKey[]) {
    const w = profile[k] ?? 0;
    const v = sig[k];
    if (!(w > 0) || v === null || v === undefined) continue;
    const p = ctx[k].rank(v);
    if (p === null) continue;
    if (k === 'intelligence') pI = p;
    wSum += w; acc += w * p;
  }
  if (pI === null && typeof sig.intelligence === 'number') pI = ctx.intelligence.rank(sig.intelligence);
  if (wSum === 0) return null;
  let q = acc / wSum;
  q = pI !== null ? Math.min(q, pI + o.lift_cap) : q * o.missing_intelligence_factor;
  if (sig.estimated) q *= o.estimated_factor;
  return round1(q);
}
```
(The cap also applies when a profile gives intelligence weight 0 but the record has an index — the ceiling is a model property, not a profile choice.)

**Step 4:** green. **Step 5:** commit `feat: cascaded quality score (percentiles, intelligence ceiling)`.

### Task C2: Context from cache + `lookupQuality`

**Files:** Modify `src/quality-score.ts` (`buildQualityContext(aaModels, codingAgentBySlug)`, `signalsOf(record, codingAgent)`), `src/metrics.ts` (`lookupQuality(ref, profileName): number | null`, memoized on cache/config versions); Test `test/lookup-quality.test.ts`.

**Step 1: failing test:** with `aa_models` from the A1 fixture and the shipped default profiles: ORDER (not values — the fixture population is small) `glm-5-3 > ling-3-1-flash > apodex-1-1 > gemma-4-31b > north-mini-code` for `general`; `lookupQuality('openrouter/apodex/apodex-1.1-mini:free', 'general')` → `null` (no identity); a ref resolving only to a `gdpval_builtin` slug gets a score `×0.85` (missing intelligence).
**Step 3:** population = non-deprecated records; the GDPval index also includes builtin Elo values only via lookup, not as population members. Unknown profile name → `null` plus a one-time `warnLog`.
**Step 5:** commit `feat: lookupQuality per profile`.

### Task C3: Config schema + validation

**Files:** Modify `src/types.ts` (`Group.score_by` adds `'quality'`; `Group.quality_profile?: string`, `Group.min_quality?: number`, `Group.max_quality?: number`; `Config.quality_profiles?: Record<string, QualityProfile>`, `Config.quality?: Partial<QualityOptions>`), `src/config-loader.ts` (validation: weights ≥ 0 and at least one > 0; `lift_cap ≥ 0`; factors in (0, 1]; `min/max_quality` in [0, 100]; `quality_profile` must name an existing profile), `router-config.json` (shipped `quality_profiles` per OD3 + `quality` options; **no group uses them yet**); Test `test/quality-config.test.ts` + update `test/consolidated-config-pins.test.ts`.

Red: validation tests for each rule. Commit `feat: quality profile config + validation (opt-in)`.

### Task C4: Gates + ranking

**Files:** Modify `src/routing.ts` (`GroupFilterLookups` gains `quality(ref: string, profile: string): number | null`; `liveGroupFilterLookups` wires `lookupQuality`; `applyGroupFilters` gets step 4c `min_quality` / `max_quality` with strict null-fails, profile `g.quality_profile ?? 'general'`, gate names `min_quality`/`max_quality` for the decision log; a helper `scoreColumn(g)` returning `quality:<profile>` for `score_by: 'quality'` used at the three `g.score_by ?? 'gdpval'` call sites (~L1117, ~L1163, ~L1291)), `src/metrics.ts` (`calculateScore`: `column?.startsWith('quality:')` → `lookupQuality(ref, profile) ?? -1`, so unscored models sort last); Test `test/quality-gates.test.ts`.

Red tests: gate admits/drops with injected lookups (pure); null fails a positive floor; `best` ranking with `score_by: 'quality'` orders by Q; `best_quality_window` still works on the 0–100 scale (document: `w` is relative, 0.05 = 5 % of the top score).

Commit `feat: min/max_quality gates and score_by quality`.

### Task C5: Quality report (calibration tool)

**Files:** Create `scripts/quality-report.ts`; Test `test/quality-report.test.ts` (pure formatting/selection function exported from the script, as in `scripts/laya-shadow-stats.ts`).

Reads `dist/.cache/scan-cache.json` + the layered config; for every available model prints: ref, resolved slug, match kind (model-map / identity exact / variant-base / LLM / fuzzy / none), II (+est), Elo, TB, SCI, CA, Q per profile, groups admitted by today's Elo gates, and groups admitted under candidate thresholds passed on the CLI (`--min standard=55 --min complex=75 --max tactical=95 …`). Summary: per group `+added −removed` vs. today. Read-only.

Commit `feat: quality report script for gate calibration`.

**→ Open PR-2** (`feat: quality cascade (opt-in)`).

---

## Phase D — Calibration & flip (owner)

### Task D1: Calibrate (OWNER DECISION)

Run `npx tsx scripts/quality-report.ts` on the live cache with candidate thresholds; owner picks floors/caps per group and the profile per group (proposal: `tactical` → `coding`, `planning` → `planning`, others → `general`).

### Task D2: Shipped config flip

**Files:** `router-config.json` (groups use `min_quality`/`max_quality` + `score_by: 'quality'` + `quality_profile`; `min_gdpval`/`max_gdpval` removed from those groups), `test/consolidated-config-pins.test.ts` (pin the new gates **first** → red against the old config), `docs/adr/0028-…` (Accepted; ADR-0023 gates marked superseded), `README.md` (groups section), `docs/routing-flow.md`, `CHANGELOG.md` (Unreleased), `TODO.md`.

Commit `feat: shipped groups gate on the quality cascade (ADR-0028)` → **PR-3**.

---

## Risks

- **AA payload drift (again):** sanity floor (≥ 100 records), loud `warnLog`, real-payload fixtures; the API adapter (OD5) is the structural fix.
- **Percentile drift** as AA adds models: scores are relative by design; re-run the report before each release proposal.
- **Builtin Elo scale** (`gdpval_builtin`, local models) predates the 2026-09-19 re-anchoring: unmatched builtins only get the GDPval signal × 0.85; auditing builtin values against AA is a follow-up.
- **AA terms of use** for page scraping: same exposure as today's GDPval scrape; the API path removes it.
- **esbuild double module instance** (see `resolveSlug` comment): identity catalog/vocabulary are derived from `cache` on every call (memoized by version), never from module-local state alone.

## Verification checklist (each PR)

- [ ] red evidence named per task in the PR body
- [ ] `npx tsc --noEmit`
- [ ] `npx vitest run` — count ≥ baseline + new tests, 0 failed
- [ ] `npm run test:coverage` — thresholds unchanged
- [ ] `npm run build`, then `dist/` sanity: `grep -c extractAaRecords dist/index.js`
- [ ] `test/no-hardcoded-models.test.ts` green (baseline stays 0)
- [ ] §8: reviews, inline comments, issue comments read and resolved before merge
