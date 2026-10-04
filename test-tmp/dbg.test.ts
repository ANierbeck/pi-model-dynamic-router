import { describe, it, expect } from 'vitest';
import { Router, applyGroupFilters } from '../src/routing.js';
import * as m from '../src/metrics.js';
import type { Config } from '../src/types.js';

const cfg = {
  model_groups: { planning: { method: 'best', min_gdpval: 1700, score_by: 'briefcase', fallback_groups: [] } },
  model_metrics: { 'claude-bridge/claude-opus-5-5': { cost_per_m: 1.5e-6, throughput_tps: 100, avg_latency_ms: 1000 } },
  providers: {},
  gdpval_builtin: { 'claude-opus-5-5': 1900, 'zai-glm-5-3': 1644 },
} as any;

describe('dbg', () => {
  it('lookupGdp resolves', () => {
    m.setConfig(cfg);
    m.setCache({ available_models: [], capability_profiles: { 'zai-glm-5-3': { briefcase: 2100 } } } as any);
    m.setModelRegistry({ find: () => undefined } as any);
    console.log('lookupGdp glm:', m.lookupGdp('mistral/zai-glm-5-3'));
    console.log('lookupGdp opus:', m.lookupGdp('claude-bridge/claude-opus-5-5'));
    const f = applyGroupFilters(['mistral/zai-glm-5-3', 'claude-bridge/claude-opus-5-5'], cfg.model_groups.planning, cfg);
    console.log('filtered:', f);
    expect(true).toBe(true);
  });
});
