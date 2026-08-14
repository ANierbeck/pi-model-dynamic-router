// test/glm-live-debug.test.ts
// Diagnostic test: reproduces the live /router table computation with the
// REAL cache + config to find why GLM-5-2 is missing from strategic.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Router } from '../src/routing.js';
import * as metricsModule from '../src/metrics.js';
import type { Config, Cache } from '../src/types.js';

// Load the REAL files Pi uses.
const cache: Cache = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'dist', '.cache', 'scan-cache.json'), 'utf-8')
);
const baseCfg: Config = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'dist', 'router-config.json'), 'utf-8')
);
const userOverride: Partial<Config> = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), '.pi', 'agent', 'router-config.user.json'), 'utf-8')
);

// Deep-merge (simplified — same as config-loader does).
const cfg: Config = {
  ...baseCfg,
  ...userOverride,
  exclude: { ...baseCfg.exclude, ...userOverride.exclude },
} as Config;

describe('GLM live diagnostic (real cache + config)', () => {
  it('cache has GLM models discovered', () => {
    const glm = (cache.available_models ?? []).filter((m) => m.id.toLowerCase().includes('glm'));
    expect(glm.length).toBeGreaterThan(0);
  });

  it('gdpval_scores has glm-5-2', () => {
    expect(cache.gdpval_scores?.['glm-5-2']).toBeGreaterThan(1000);
  });

  it('model-map.yaml has zai-glm-5-2 → glm-5-2', () => {
    // Load model-map.yaml the same way loadModelMap does.
    const yaml = fs.readFileSync(
      path.resolve(__dirname, '..', 'dist', 'model-map.yaml'),
      'utf-8'
    );
    expect(yaml).toContain('zai-glm-5-2:');
    expect(yaml).toContain('glm-5-2:');
  });

  it('allDiscoveredRefs includes GLM models', () => {
    // Set up metrics module like load() does.
    metricsModule.setConfig(cfg);
    metricsModule.setCache(cache);
    metricsModule.loadModelMap(path.resolve(__dirname, '..', 'dist'));

    const router = new Router(cfg, cache, new Map());
    const refs = router.allDiscoveredRefs();
    const glmRefs = refs.filter((r) => r.toLowerCase().includes('glm'));
    expect(glmRefs.length).toBeGreaterThan(0);
  });

  it('getTopModels("strategic") includes GLM-5-2', () => {
    metricsModule.setConfig(cfg);
    metricsModule.setCache(cache);
    metricsModule.loadModelMap(path.resolve(__dirname, '..', 'dist'));

    const router = new Router(cfg, cache, new Map());
    const top = router.getTopModels('strategic', 20);
    const refs = top.map((t) => t.ref);
    const glmRefs = refs.filter((r) => r.toLowerCase().includes('glm'));
    expect(glmRefs.length).toBeGreaterThan(0);
  });

  it('lookupGdp returns a high score for mistral/zai-glm-5-2', () => {
    metricsModule.setConfig(cfg);
    metricsModule.setCache(cache);
    metricsModule.loadModelMap(path.resolve(__dirname, '..', 'dist'));
    const score = metricsModule.lookupGdp('mistral/zai-glm-5-2');
    expect(score).toBeGreaterThan(1000); // GLM-5-2 is a top-tier model
  });
});
