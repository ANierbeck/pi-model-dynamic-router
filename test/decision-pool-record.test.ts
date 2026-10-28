// Route 2 of the pool replay (docs/research/2026-10-27-pool-replay.md,
// docs/research/2026-10-28-route-calibration.md): the decision-time candidate
// pool is recorded in the decision log itself, as a separate 'pool' record in
// the same jsonl. One record per group resolution that drives a stream — the
// glue resolve() is the only path the orchestrator streams through.
//
// Correlation with the decision record: same `proc`, ordered right after the
// decision (classification → resolve → stream), same group. No prompt text —
// refs, metrics and flags only.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Router } from '../src/routing.js';
import { createModelResolveGlue } from '../src/model-resolve-glue.js';
import * as metricsModule from '../src/metrics.js';
import {
  DECISION_LOG_VERSION,
  buildPoolRecord,
  writePoolRecord,
  decisionLogPath,
} from '../src/classifier-decision-log.js';
import { readDecisions } from '../scripts/turn-decision-join.ts';
import type { Config, Cache } from '../src/types.js';

const testConfig: Config = {
  model_groups: {
    bestish: { method: 'best', min_gdpval: 100 },
    emptygrp: { method: 'best', min_gdpval: 9999, fallback_groups: ['bestish'] },
  },
  model_metrics: {
    'provx/aaa': { gdpval: 300, throughput_tps: 10, avg_latency_ms: 100, cost_per_m: 2 },
    'provx/bbb': { gdpval: 200, throughput_tps: 20, avg_latency_ms: 200, cost_per_m: 1 },
  },
  providers: {},
  // detectGroup/group filters read gdp through the slug pipeline: direct builtin keys.
  gdpval_builtin: { aaa: 300, bbb: 200 },
} as any;

const cache: Cache = {
  available_models: [
    { id: 'aaa', provider: 'provx', cost_per_m: 2 },
    { id: 'bbb', provider: 'provx', cost_per_m: 1 },
  ],
} as any;

beforeAll(() => {
  metricsModule.setConfig(testConfig);
  metricsModule.setCache(cache);
  metricsModule.setModelRegistry({ find: () => undefined } as any);
});

describe('Router.resolve carries the decision-time pool', () => {
  it('ranks candidates with gdp, cost, score and the group it came from', () => {
    const router = new Router(testConfig, cache, new Map());
    const r = router.resolve('bestish');
    expect(r!.pool).toEqual({
      group: 'bestish',
      method: 'best',
      candidates: [
        { ref: 'provx/aaa', gdp: 300, cost: 2, score: expect.any(Number), flags: [] },
        { ref: 'provx/bbb', gdp: 200, cost: 1, score: expect.any(Number), flags: [] },
      ],
    });
  });

  it('flags unhealthy candidates', () => {
    const unhealthyCache = { ...cache, model_health: { 'provx/bbb': { fails: 2, last_fail: Date.now() } } } as any;
    metricsModule.setCache(unhealthyCache);
    try {
      const router = new Router(testConfig, unhealthyCache, new Map());
      // aaa stays first (healthy), bbb is demoted within the rank — pool flags both facts.
      const r = router.resolve('bestish');
      const bbb = r!.pool!.candidates.find((c) => c.ref === 'provx/bbb')!;
      expect(bbb.flags).toContain('unhealthy');
    } finally {
      metricsModule.setCache(cache);
    }
  });

  it('a fallback cascade reports the group the candidates actually came from', () => {
    const router = new Router(testConfig, cache, new Map());
    const r = router.resolve('emptygrp');
    expect(r!.pool!.group).toBe('bestish');
    expect(r!.pool!.candidates[0].ref).toBe('provx/aaa');
  });
});

describe('the pool record', () => {
  it('buildPoolRecord: version, stage pool, ts, proc tag, passthrough pool', () => {
    const rec = buildPoolRecord({ group: 'bestish', method: 'best', candidates: [{ ref: 'provx/aaa', gdp: 300, cost: 2, flags: [] }] });
    expect(rec.v).toBe(DECISION_LOG_VERSION);
    expect(rec.stage).toBe('pool');
    expect(rec.ts).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(rec.ts))).toBe(false);
    expect(rec.proc).toMatch(/^[^/]+\/\d+$/);
    expect(rec.group).toBe('bestish');
    expect(rec.method).toBe('best');
    expect(rec.candidates).toHaveLength(1);
    expect(rec.candidates[0].ref).toBe('provx/aaa');
  });

  it('writePoolRecord appends to the same jsonl as the decision records', () => {
    const home = mkdtempSync(join(tmpdir(), 'pool-rec-'));
    try {
      writePoolRecord(buildPoolRecord({ group: 'bestish', method: 'best', candidates: [] }), home, { maxBytes: 20 * 1024 * 1024, keep: 3 });
      const lines = readFileSync(decisionLogPath(home), 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).stage).toBe('pool');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('fail-open: an unwritable location never throws', () => {
    expect(() =>
      writePoolRecord(buildPoolRecord({ group: 'g', method: 'best', candidates: [] }), '/nonexistent/home', { maxBytes: 1, keep: 1 }),
    ).not.toThrow();
  });

  it('readDecisions skips pool records (no input.sha — nothing to join)', () => {
    const home = mkdtempSync(join(tmpdir(), 'pool-rec-'));
    try {
      writePoolRecord(buildPoolRecord({ group: 'bestish', method: 'best', candidates: [] }), home, { maxBytes: 20 * 1024 * 1024, keep: 3 });
      expect(readDecisions(decisionLogPath(home), {})).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('the glue resolve writes the pool record', () => {
  // deps minimal enough to construct the glue: only `router` is touched.
  const glueDeps = (router: unknown) => {
    const pools: unknown[] = [];
    const glue = createModelResolveGlue({
      cache: {} as any,
      costMux: () => 1,
      discoveryManager: {} as any,
      effCost: () => 1,
      getM: () => ({}) as any,
      isLimited: () => false,
      limitSecs: () => 0,
      router: router as any,
      logPool: (p: unknown) => pools.push(p),
    });
    return { glue, pools };
  };

  it('a resolution with a pool is handed to logPool', () => {
    const { glue, pools } = glueDeps({
      resolve: () => ({
        selected: 'provx/aaa',
        candidates: ['provx/aaa'],
        pool: { group: 'bestish', method: 'best', candidates: [{ ref: 'provx/aaa', gdp: 300, cost: 2, flags: [] }] },
      }),
    });
    expect(glue.resolve('bestish')).toMatchObject({ selected: 'provx/aaa' });
    expect(pools).toHaveLength(1);
    expect((pools[0] as { group: string }).group).toBe('bestish');
  });

  it('no resolution (null) and resolutions without a pool log nothing', () => {
    const { glue, pools } = glueDeps({ resolve: () => null });
    expect(glue.resolve('dyno')).toBeNull();
    expect(pools).toHaveLength(0);
    const { glue: g2, pools: p2 } = glueDeps({ resolve: () => ({ selected: 'x/y', candidates: ['x/y'] }) });
    g2.resolve('whatever');
    expect(p2).toHaveLength(0);
  });
});
