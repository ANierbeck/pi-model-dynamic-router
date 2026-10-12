// test/gdpval-identity-defects.test.ts
//
// Regression guards for the identity defects found by the Task-0 score-data
// audit (2026-10-12, /tmp/catplan/task0-identity-report.md) in the gdpval
// sourcing pipeline:
//
//   (a) A paren-stripped labelKey OVERWRITES the bare slug of a different
//       (usually higher-Elo) row — the leaderboard is processed in
//       descending Elo, so the LOWEST variant's score ended up on the
//       family key (`gpt-6-astra` = low variant, `mistral-large-4` =
//       Preview lower bound). Dotted names ("GLM-5.2" → labelKey `glm-52`)
//       never collide with their bare slugs, which is why the defect only
//       hit dot-less families.
//   (b) The scraper discards AA's `creator` field, so identity audits
//       cannot verify the vendor of a score row offline.
//   (c) The slug-matcher fuzzy stage ignores EXTRA variant tokens in the
//       ref: `apodex-1.1-mini` inherited the FULL `apodex-1-1` score
//       (1190.82) because the slug's letter tokens are a subset of the
//       ref's — the discriminating `mini` was invisible to the overlap
//       score.
//   (d) The curated builtin `qwen3-8-27b: 580` (2026-08-24, pre-ADR-0025)
//       sits ~500-800 below every AA row for the model (1071-1381) and
//       mis-scores BOTH the local MLX twin and the OpenRouter API twin.
//       Removed: the algorithmic matcher resolves both refs to the AA
//       rows; the Ollama estimator must not re-shadow a model that
//       already resolves to a scraped score.
//
// All assertions were observed RED against the unfixed implementation
// before the fixes landed (AGENTS.md §4).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractGdpvalScores, extractGdpvalProvenance } from '../src/scan-runner.js';
import { matchSlug } from '../src/slug-matcher.js';
import { estimateOllamaModelsGdpvalAsSlugs } from '../src/ollama-gdpval.js';
import { setConfig, setGdpval, setModelMap, lookupGdp, loadModelMap, setCache, lookupProvenance, resolveSlug } from '../src/metrics.js';

// ── (a) labelKey overwrite ───────────────────────────────────────────────

// Real-world shape (AA leaderboard, descending Elo): the family base row
// carries the bare slug; variants carry their own slugs AND a labelKey that
// — for dot-less names — equals the base slug.
const ALEXANDER_HTML = [
  '\\"models\\":[{',
  '\\"id\\":\\"a\\",\\"displayName\\":\\"GPT-6 Astra (xhigh)\\",\\"creator\\":{\\"name\\":\\"OpenAI\\"},\\"elo\\":1554.47,\\"confidenceInterval\\":\\"-1 / +1\\"',
  '},{',
  '\\"id\\":\\"b\\",\\"displayName\\":\\"GPT-6 Astra\\",\\"creator\\":{\\"name\\":\\"OpenAI\\"},\\"elo\\":1400,\\"confidenceInterval\\":\\"-1 / +1\\"',
  '},{',
  '\\"id\\":\\"c\\",\\"displayName\\":\\"GPT-6 Astra (low)\\",\\"creator\\":{\\"name\\":\\"OpenAI\\"},\\"elo\\":1388.98,\\"confidenceInterval\\":\\"-1 / +1\\"',
  '}]',
  '{\\"slug\\":\\"gpt-6-astra\\",\\"name\\":\\"GPT-6 Astra\\"}',
  '{\\"slug\\":\\"gpt-6-astra-xhigh\\",\\"name\\":\\"GPT-6 Astra (xhigh)\\"}',
  '{\\"slug\\":\\"gpt-6-astra-low\\",\\"name\\":\\"GPT-6 Astra (low)\\"}',
].join('');

describe('gdpval identity defects: labelKey overwrite', () => {
  it('a variant labelKey never overwrites the family base slug (gpt-6-astra)', () => {
    const scores = extractGdpvalScores(ALEXANDER_HTML);
    // The bare slug belongs to the base row (1400). Before the fix the
    // "(low)" variant's labelKey (1388.98) overwrote it — live cache
    // carried gpt-6-astra = 1388.98.
    expect(scores['gpt-6-astra']).toBe(1400);
    // Variant slugs keep their own rows.
    expect(scores['gpt-6-astra-xhigh']).toBe(1554.47);
    expect(scores['gpt-6-astra-low']).toBe(1388.98);
  });

  it('a slug write wins over a labelKey that filled the same key first', () => {
    // Descending order: the xhigh variant (1554.47) is processed BEFORE the
    // base row (1400). The variant's labelKey may fill gpt-6-astra first,
    // but the base row's SLUG write must win (the slug IS the base model).
    const scores = extractGdpvalScores(ALEXANDER_HTML);
    expect(scores['gpt-6-astra']).toBe(1400);
  });

  it('dot-less label twins carry the HIGHEST variant, not the lowest (claude-opus-55)', () => {
    // "Claude Opus 5.5 (high)" → labelKey claude-opus-55 (dot stripped) —
    // no bare claude-opus-5-5 slug row exists in this payload, so the
    // labelKey is the only spelling. Descending Elo means the first write
    // is the highest variant; before the fix the LAST (lowest) won:
    // live cache carried claude-opus-55 = 1233.7, the low variant.
    const html = [
      '\\"models\\":[{',
      '\\"id\\":\\"a\\",\\"displayName\\":\\"Claude Opus 5.5 (high)\\",\\"creator\\":{\\"name\\":\\"Anthropic\\"},\\"elo\\":1251.2,\\"confidenceInterval\\":\\"-1 / +1\\"',
      '},{',
      '\\"id\\":\\"b\\",\\"displayName\\":\\"Claude Opus 5.5 (low)\\",\\"creator\\":{\\"name\\":\\"Anthropic\\"},\\"elo\\":1233.7,\\"confidenceInterval\\":\\"-1 / +1\\"',
      '}]',
      '{\\"slug\\":\\"claude-opus-5-5-high\\",\\"name\\":\\"Claude Opus 5.5 (high)\\"}',
      '{\\"slug\\":\\"claude-opus-5-5-low\\",\\"name\\":\\"Claude Opus 5.5 (low)\\"}',
    ].join('');
    const scores = extractGdpvalScores(html);
    expect(scores['claude-opus-55']).toBe(1251.2);
  });
});

// ── (b) provenance (creator + displayName per slug) ───────────────────────

describe('gdpval identity defects: provenance', () => {
  it('persists creator and displayName per slug from the AA leaderboard', () => {
    const provenance = extractGdpvalProvenance(ALEXANDER_HTML);
    expect(provenance['gpt-6-astra']).toEqual({
      creator: 'OpenAI',
      displayName: 'GPT-6 Astra',
    });
    expect(provenance['gpt-6-astra-xhigh']).toEqual({
      creator: 'OpenAI',
      displayName: 'GPT-6 Astra (xhigh)',
    });
  });

  it('returns empty for payloads without leaderboard rows (fail-closed)', () => {
    expect(extractGdpvalProvenance('<html>nothing</html>')).toEqual({});
    expect(extractGdpvalProvenance('')).toEqual({});
  });

  it('provenance is readable through the lookup pipeline (metrics mirror)', () => {
    setConfig({ model_groups: {}, model_metrics: {} });
    setModelMap({}, []);
    setGdpval({ 'apodex-1-1': 1190.82 });
    setCache({ gdpval_provenance: { 'apodex-1-1': { creator: 'Apodex', displayName: 'Apodex 1.1' } } });
    expect(lookupProvenance('openrouter/apodex/apodex-1.1:free')).toEqual({
      creator: 'Apodex',
      displayName: 'Apodex 1.1',
    });
  });
});

// ── (c) fuzzy match: discriminating variant tokens ─────────────────────────

describe('gdpval identity defects: fuzzy variant tokens', () => {
  it('apodex-1.1-mini must NOT inherit the full apodex-1-1 score', () => {
    // The live cache scored the Mini at 1190.82 (the FULL model's row).
    // Task 0 behavioural hint: 7 consecutive 2-char toolUse turns with
    // stopReason "length, 0 chars" — not what a 1190-level model does.
    const matched = matchSlug('openrouter/apodex/apodex-1.1-mini:free', ['apodex-1-1']);
    expect(matched).toBeUndefined();
  });

  it('a full-model ref still matches its own slug (positive control)', () => {
    expect(matchSlug('openrouter/apodex/apodex-1.1:free', ['apodex-1-1'])).toBe('apodex-1-1');
  });

  it('confirmed same-model noise tokens stay matched (gemma -it)', () => {
    // CONFIRMED by Task 0: `-it` is instruct-tuning, not a model boundary.
    expect(
      matchSlug('openrouter/google/gemma-4-26b-a4b-it:free', ['gemma-4-26b-a4b', 'gemma-4-31b'])
    ).toBe('gemma-4-26b-a4b');
  });

  it('ling-3.1-flash still matches its exact slug (positive control)', () => {
    expect(matchSlug('openrouter/inclusionai/ling-3.1-flash', ['ling-3-1-flash'])).toBe('ling-3-1-flash');
  });

  it('the variant veto is scoped: version-less family slugs keep the 2026-09-20 approximation', () => {
    // devstral-small-2505 → devstral is a deliberate design decision
    // (docs/plans/2026-09-20-latest-alias-slug-matching-design.md): when AA
    // has no variant row, a dated size-variant ref approximates to the
    // version-less family slug. The veto must not break this — it fires
    // only when the slug names the EXACT same version as the ref
    // (apodex-1-1 [1,1] vs apodex-1.1-mini [1,1]).
    expect(matchSlug('mistral/devstral-small-2505', ['devstral', 'mistral-small-3-1'])).toBe('devstral');
  });
});

// ── (d) qwen3-8-27b: stale builtin + estimator shadowing ───────────────────

// The real AA payload (live scan cache 2026-10-12) has NO bare dotted
// qwen3-8-27b slug — only variant slugs plus the dot-less labelKey twin:
const QWEN_AA_ROWS: Record<string, number> = {
  'qwen3-8-27b-medium': 1381.48,
  'qwen3-8-27b-low': 1362.15,
  'qwen3-8-27b-non-reasoning': 1071.84,
  'qwen38-27b': 1381.48, // dot-less labelKey of the medium variant
};

const SHIPPED_CONFIG = JSON.parse(readFileSync('router-config.json', 'utf-8'));

describe('gdpval identity defects: qwen3-8-27b builtin', () => {
  it('the shipped gdpval_builtin no longer carries the stale qwen3-8-27b estimate', () => {
    expect(SHIPPED_CONFIG.gdpval_builtin['qwen3-8-27b']).toBeUndefined();
  });

  it('the shipped model-map no longer pins the MLX ref to the dead dotted key', () => {
    setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: SHIPPED_CONFIG.gdpval_builtin ?? {} });
    setGdpval({ ...QWEN_AA_ROWS });
    loadModelMap('.'); // the SHIPPED map state
    // Before the fix, Stage 0 pinned the ref to the (builtin-only) dotted
    // key qwen3-8-27b; with the entry removed the algorithmic matcher's
    // exact-normalized stage resolves the dot-less AA twin instead.
    expect(resolveSlug('ollama/qwen3.8:27b-mlx')).toBe('qwen38-27b');
  });

  it('the OpenRouter API twin resolves to the AA row, not the 580 builtin', () => {
    setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: SHIPPED_CONFIG.gdpval_builtin ?? {} });
    setModelMap({}, []); // algorithmic path only
    setGdpval({ ...QWEN_AA_ROWS });
    expect(lookupGdp('openrouter/qwen/qwen3.8-27b:free')).toBe(1381.48);
  });

  it('the local MLX twin resolves to the same AA row (dedup-consistent)', () => {
    setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: SHIPPED_CONFIG.gdpval_builtin ?? {} });
    setModelMap({}, []);
    setGdpval({ ...QWEN_AA_ROWS });
    expect(lookupGdp('ollama/qwen3.8:27b-mlx')).toBe(1381.48);
  });

  it('the Ollama estimator does not re-shadow a model that already scores', () => {
    // With a scored-resolution callback (lookupGdp resolves the ref), the
    // estimator must skip the model entirely instead of filling the dead
    // dotted key `qwen3-8-27b: 812` — which would shadow the AA rows via
    // the exact-normalized match.
    const estimates = estimateOllamaModelsGdpvalAsSlugs(
      ['qwen3.8:27b-mlx'],
      () => true // every model already resolves to a score
    );
    expect(estimates).toEqual({});
  });

  it('the estimator still fills genuinely unscored models (fallback intact)', () => {
    const estimates = estimateOllamaModelsGdpvalAsSlugs(
      ['qwen3.8:27b-mlx'],
      () => false // nothing resolvable → estimate as before
    );
    expect(estimates['qwen3-8-27b']).toBe(812);
  });
});
