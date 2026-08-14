// test/glm-live-debug.test.ts
// Diagnostic test: reproduces the live /router table computation with the
// REAL cache + config to find why GLM-5-2 is missing from strategic.
//
// RUN ONLY LOCALLY: TEST_INTEGRATION=true npm test test/glm-live-debug.test.ts
// (needs local dist/.cache/scan-cache.json, dist/router-config.json, ~/.pi/agent/router-config.user.json)

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Router } from '../src/routing.js';
import * as metricsModule from '../src/metrics.js';
import type { Config, Cache } from '../src/types.js';

describe.skipIf(!process.env.TEST_INTEGRATION)('glm-live-debug (Integration)', () => {
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

  it('Router loads GLM-5-2 in strategic group', () => {
    const router = new Router(cfg, cache, new Map());
    const strategic = router.getTopModels('strategic', 20);
    const refs = strategic.map((t) => t.ref);
    expect(refs.some((r) => r.toLowerCase().includes('glm-5-2'))).toBe(true);
  });

  it('Router loads GLM-5-2 in complex group', () => {
    const router = new Router(cfg, cache, new Map());
    const complex = router.getTopModels('complex', 20);
    const refs = complex.map((t) => t.ref);
    expect(refs.some((r) => r.toLowerCase().includes('glm-5-2'))).toBe(true);
  });

  it('Router loads GLM-5-2 in operational group', () => {
    const router = new Router(cfg, cache, new Map());
    const operational = router.getTopModels('operational', 20);
    const refs = operational.map((t) => t.ref);
    expect(refs.some((r) => r.toLowerCase().includes('glm-5-2'))).toBe(true);
  });

  it('allDiscoveredRefs includes mistral/glm-5-2 and mistral/zai-glm-5-2', () => {
    const router = new Router(cfg, cache, new Map());
    const refs = router.allDiscoveredRefs();
    expect(refs.some((r) => r.toLowerCase().includes('glm-5-2'))).toBe(true);
  });

  it('mistral/zai-glm-5-2 resolves to GDPval > 1000 (not 400 = glm-4)', () => {
    const score = metricsModule.lookupGdp('mistral/zai-glm-5-2');
    expect(score).toBeGreaterThan(1000);
    expect(score).not.toBe(400);
  });
});