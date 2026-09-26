// test/group-filter-parity.test.ts
// ADR-0010: the persist path (filterModelsForGroup, fed with precomputed
// per-model values) and the live path (applyGroupFilters, reading the
// metrics module) must admit the same models for the same data.

import { describe, it, expect, beforeEach } from 'vitest';
import { applyGroupFilters } from '../src/routing.ts';
import { buildModelsWithMetadata, buildStaticFreeModelsLookup, filterModelsForGroup } from '../src/dynamic-config.ts';
import { setConfig, setCache, setGdpval, setModelMap, setMetrics } from '../src/metrics.ts';
import type { Config, Group } from '../src/types.ts';

const cfg: Config = {
  model_groups: {},
  model_metrics: {},
  providers: {
    payg: { billing: 'pay_per_token', free_models: ['payg/listed-free'] },
    sub: { billing: 'subscription' },
  },
};

const REFS = [
  'payg/cheap',
  'payg/expensive',
  'payg/listed-free',
  'payg/tagged:free',
  'payg/mystery',
  'sub/unpriced',
  'ollama/local-model',
];

beforeEach(() => {
  setConfig(cfg);
  setModelMap({}, []);
  setMetrics({});
  setGdpval({
    cheap: 400, expensive: 900, 'listed-free': 500, 'tagged': 450, 'tagged:free': 450,
    mystery: 600, unpriced: 800, 'local-model': 300,
  });
  setCache({
    available_models: [
      { id: 'cheap', provider: 'payg', cost_per_m: 1 },
      { id: 'expensive', provider: 'payg', cost_per_m: 20 },
      { id: 'listed-free', provider: 'payg', cost_per_m: 0 },
      { id: 'tagged:free', provider: 'payg', cost_per_m: 0 },
      { id: 'mystery', provider: 'payg' },
      { id: 'unpriced', provider: 'sub' },
      { id: 'local-model', provider: 'ollama', cost_per_m: 0 },
    ],
  } as any);
});

const GROUPS: Array<[string, Group]> = [
  ['max_cost 0', { method: 'best', max_cost: 0 }],
  ['max_cost 2', { method: 'best', max_cost: 2 }],
  ['max_cost_per_m 5', { method: 'best', max_cost_per_m: 5 }],
  ['min_gdpval 500', { method: 'best', min_gdpval: 500 }],
  ['exclude_providers', { method: 'best', exclude_providers: ['sub'] }],
];

describe('persist and live group filters agree (ADR-0010)', () => {
  it.each(GROUPS)('%s', (_name, g) => {
    const { staticFreeModelsLookup } = buildStaticFreeModelsLookup(cfg);
    const meta = buildModelsWithMetadata(REFS, cfg, staticFreeModelsLookup, new Set());
    const persist = filterModelsForGroup(meta, g, cfg).map((m) => m.ref).sort();
    const live = applyGroupFilters(meta.map((m) => m.ref), g, cfg).sort();
    expect(persist).toEqual(live);
  });

  it('keeps the unpriced cloud subscription model out of $0 and per-million-capped groups', () => {
    for (const g of [GROUPS[0][1], GROUPS[2][1]]) {
      expect(applyGroupFilters(REFS, g, cfg)).not.toContain('sub/unpriced');
      expect(applyGroupFilters(REFS, g, cfg)).toContain('ollama/local-model');
    }
  });
});
