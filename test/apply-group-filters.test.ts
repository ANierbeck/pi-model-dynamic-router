// test/apply-group-filters.test.ts
// Tests for applyGroupFilters — the shared method-independent filter pipeline
// (A1 consolidation) used by resolveGroup (live) and getTopModels (display).
//
// What this locks down:
//   1. The four method-independent filters (exclude_providers, exclude_models,
//      min_gdpval, max_cost, max_cost_per_m) behave identically across paths.
//   2. Unknown-cost handling for max_cost is billing-aware: subscription/local
//      kept (sunk cost), pay_per_token dropped. This was the display-path bug
//      (/router showed models the live path would filter).
//   3. min_gdpval <= 0 means "no quality gate" — unscored models pass (matches
//      the historical filterByQualityMin guard). A STRICT positive threshold
//      drops unscored models (lookupGdp null) — the fix for the 13/148-style
//      collapse where unscored models leaked past the gate.
//   4. The helper does NOT mutate its input array.
//   5. dedup is opt-in (persist path uses its own token-signature dedup).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyGroupFilters } from '../src/routing.ts';
import * as metricsModule from '../src/metrics.ts';
import type { Config, Group } from '../src/types.ts';

const REFS = [
  'openrouter/qwen3-4b:free',     // payg, scored 400, cost 0
  'openrouter/paid-model',        // payg, scored 1000, cost 0.05
  'mistral/devstral-2512',        // subscription (billing), scored 585, unknown OpenRouter price
  'mistral/mistral-medium-2604',  // subscription, scored 933, unknown price
  'ollama/qwen3.5',               // local, scored 400, cost 0
  'unscored/unknown-model',       // payg, unscored (lookupGdp null)
];

const SCORES: Record<string, number> = {
  'qwen3-4b': 400,
  'paid-model': 1000,
  'devstral': 585,
  'mistral-medium-3-5': 933,
  'qwen3.5': 400,
};

const CFG: Config = {
  model_groups: {},
  model_metrics: {},
  providers: {
    openrouter: { billing: 'pay_per_token' },
    mistral: { billing: 'subscription' },
    ollama: { billing: 'local' },
    unscored: { billing: 'pay_per_token' },
  },
} as any;

beforeAll(() => {
  metricsModule.setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: {} });
  metricsModule.setCache({ available_models: [], gdpval_scores: SCORES, llm_matches: {} } as any);
  metricsModule.setGdpval(SCORES);
  metricsModule.setModelMap({}, []);
});

afterAll(() => {
  metricsModule.setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: {} });
  metricsModule.setGdpval({});
});

describe('applyGroupFilters — shared method-independent pipeline (A1)', () => {
  describe('exclude_providers', () => {
    it('drops all models from listed providers', () => {
      const g: Group = { method: 'best', exclude_providers: ['openrouter', 'mistral'] } as any;
      const out = applyGroupFilters(REFS, g, CFG);
      expect(out.every(r => !r.startsWith('openrouter/') && !r.startsWith('mistral/'))).toBe(true);
      expect(out).toContain('ollama/qwen3.5');
    });

    it('keeps models when exclude_providers is empty', () => {
      const g: Group = { method: 'best' } as any;
      const out = applyGroupFilters(REFS, g, CFG);
      expect(out.length).toBe(REFS.length);
    });
  });

  describe('exclude_models', () => {
    it('drops exact model refs', () => {
      const g: Group = { method: 'best', exclude_models: ['openrouter/paid-model', 'ollama/qwen3.5'] } as any;
      const out = applyGroupFilters(REFS, g, CFG);
      expect(out).not.toContain('openrouter/paid-model');
      expect(out).not.toContain('ollama/qwen3.5');
      expect(out).toContain('openrouter/qwen3-4b:free');
    });
  });

  describe('min_gdpval', () => {
    it('strict positive threshold drops unscored models (no fallback)', () => {
      // This is the 13/148-collapse fix: unscored models must NOT leak past
      // a positive threshold via a `return refs` fallback.
      const g: Group = { method: 'best', min_gdpval: 500 } as any;
      const out = applyGroupFilters(REFS, g, CFG);
      expect(out).not.toContain('unscored/unknown-model');
      expect(out).toContain('mistral/mistral-medium-2604'); // 933
      expect(out).toContain('openrouter/paid-model');        // 1000
    });

    it('min_gdpval <= 0 is "no gate" — unscored models pass', () => {
      // min_gdpval: 0 means "no quality gate" (matches the historical
      // filterByQualityMin `if (min <= 0) return refs` guard).
      const g: Group = { method: 'best', min_gdpval: 0 } as any;
      const out = applyGroupFilters(REFS, g, CFG);
      expect(out).toContain('unscored/unknown-model');
    });

    it('undefined min_gdpval does not filter', () => {
      const g: Group = { method: 'best' } as any;
      const out = applyGroupFilters(REFS, g, CFG);
      expect(out.length).toBe(REFS.length);
    });
  });

  describe('max_cost — billing-aware unknown handling (the A1 display-path fix)', () => {
    it('keeps unknown-cost subscription/local models (sunk cost)', () => {
      // mistral = subscription, no OpenRouter price → unknown cost. The OLD
      // display path dropped these; the live path kept them. The helper
      // follows live semantics so /router matches what the live path picks.
      const g: Group = { method: 'best', max_cost: 0 } as any;
      const out = applyGroupFilters(REFS, g, CFG);
      expect(out.some(r => r.startsWith('mistral/'))).toBe(true);
      expect(out.some(r => r.startsWith('ollama/'))).toBe(true);
    });

    it('drops unknown-cost pay_per_token models (genuinely unknown price)', () => {
      const g: Group = { method: 'best', max_cost: 0 } as any;
      const out = applyGroupFilters(REFS, g, CFG);
      // unscored/unknown-model is pay_per_token with unknown cost → dropped
      expect(out).not.toContain('unscored/unknown-model');
    });
  });

  describe('max_cost_per_m', () => {
    it('drops models with unknown prices (always, regardless of billing)', () => {
      const g: Group = { method: 'best', max_cost_per_m: 0.01 } as any;
      const out = applyGroupFilters(REFS, g, CFG);
      // mistral has unknown prices → dropped even though subscription
      expect(out.every(r => !r.startsWith('mistral/'))).toBe(true);
    });
  });

  describe('immutability & dedup option', () => {
    it('does not mutate the input array', () => {
      const input = [...REFS];
      const g: Group = { method: 'best', min_gdpval: 500 } as any;
      applyGroupFilters(input, g, CFG);
      expect(input).toEqual(REFS);
    });

    it('runs dedup when provided', () => {
      const g: Group = { method: 'best' } as any;
      const dedup = (refs: string[]) => refs.slice(0, 2); // pretend-dedup
      const out = applyGroupFilters(REFS, g, CFG, true, dedup);
      expect(out.length).toBe(2);
    });

    it('skips dedup when not requested (persist path uses its own)', () => {
      const g: Group = { method: 'best' } as any;
      const out = applyGroupFilters(REFS, g, CFG, false);
      expect(out.length).toBe(REFS.length);
    });
  });
});
