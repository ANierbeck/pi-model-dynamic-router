// test/config-sonnet-before-opus.test.ts
// Phase 1 of docs/plans/2026-10-05-task-type-balancing.md: with the SHIPPED
// router-config.json, claude-bridge/claude-sonnet-5-5 must rank before
// claude-bridge/claude-opus-5-5 in the best-method quality-window groups
// (strategic, planning).
//
// Defect: every claude-bridge model carries a subscription sunk-cost
// sentinel in model_metrics (818621a / 3b9fd4a) — except sonnet-5-5. Its
// effCost was 'unknown', which sorts LAST, so the window (ADR-0023) picked
// opus-5-5 first. The live dynamic config only hid this because the scan
// writes cost_per_m 0 for it. The sentinel keeps the quota-burn ORDER
// (sonnet cheaper than opus) so the window's cheapest-first sort prefers it.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Router } from '../src/routing.js';
import * as metricsModule from '../src/metrics.js';
import type { Config, Cache } from '../src/types.js';

const shipped = JSON.parse(readFileSync(resolve(__dirname, '../router-config.json'), 'utf8')) as Config;

const REFS = ['claude-bridge/claude-opus-5-5', 'claude-bridge/claude-sonnet-5-5', 'claude-bridge/claude-sonnet-5'];

let cache: Cache;
let cfg: Config;

beforeEach(() => {
  cfg = structuredClone(shipped);
  // gdpval for sonnet-5-5 normally arrives from model-map.yaml / the scan,
  // not from the shipped builtin table; inject the observed live value.
  cfg.gdpval_builtin = { ...cfg.gdpval_builtin, 'claude-sonnet-5-5': 1839 };
  cache = {
    available_models: REFS.map((r) => ({ provider: r.split('/')[0], id: r.slice(r.indexOf('/') + 1) })),
  } as any;
  metricsModule.setConfig(cfg);
  metricsModule.setCache(cache);
  metricsModule.setModelRegistry({ find: () => undefined } as any);
});

describe('shipped config: sonnet-5-5 before opus-5-5 (Phase 1)', () => {
  it('prices sonnet-5-5 (defined) and below opus-5-5', () => {
    const sonnet = metricsModule.effCost('claude-bridge/claude-sonnet-5-5');
    const opus = metricsModule.effCost('claude-bridge/claude-opus-5-5');
    expect(typeof sonnet).toBe('number');
    expect(typeof opus).toBe('number');
    expect(sonnet as number).toBeLessThan(opus as number);
  });

  for (const group of ['strategic', 'planning']) {
    it(`${group} selects sonnet-5-5 first`, () => {
      const router = new Router(cfg, cache, new Map());
      const res = router.resolve(group);
      expect(res?.selected).toBe('claude-bridge/claude-sonnet-5-5');
    });
  }

  it('every routable claude-bridge model has a numeric sentinel in model_metrics', () => {
    for (const ref of REFS) {
      expect(typeof shipped.model_metrics?.[ref]?.cost_per_m, ref).toBe('number');
    }
  });

  it('declares claude-bridge as a subscription provider (no dependency on the scan stub)', () => {
    expect(shipped.providers?.['claude-bridge']?.billing).toBe('subscription');
  });
});
