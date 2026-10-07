// test/metrics-decision-core-r1.test.ts — nightly R1 triage (2026-10-07),
// metrics.ts. Pins the cost/free/billing/pricing behavior the first nightly
// found unasserted (docs/mutation-triage.md "Nightly R1"). Grouped by the
// incident class each block protects:
//
//   free / billing tier   — a model wrongly free or wrongly billed is routed
//                           into $0 groups (the Mistral/OpenRouter incidents)
//   cost placeholder heal — getM's 'unknown' / 0 healing vs real prices
//   registry price lookup — findRegistryModel retries, registryCost guards
//   OpenRouter fallback   — zero-price semantics, paid-index staleness
//   subscription rule     — ADR-0025 B2 eps x list price and its fallbacks
//   usage windows         — day-window boundaries of the usage log
//   small state contracts — setConfig visibility, accessors, model-map reload
//
// Fresh-module blocks (vi.resetModules) exist because gdpvalVersion starts at
// 0 and lastIndexVersion at -1: the token-set index is only built when they
// differ, so a version bump of the WRONG sign on the very first bump is
// invisible in a long-lived module and visible in a fresh one.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../src/logger.ts', async (orig) => {
  const actual = await orig<typeof import('../src/logger.ts')>();
  return { ...actual, errorLog: vi.fn() };
});

import * as loggerModule from '../src/logger.ts';
import * as m from '../src/metrics.ts';
import type { Config, Cache } from '../src/types.ts';

type Registry = { find: (provider: string, id: string) => unknown };

function world(opts: { cfg?: Partial<Config>; cache?: Partial<Cache>; registry?: Registry | null; modelMap?: Record<string, string | null> } = {}) {
  const cfg = { model_groups: {}, model_metrics: {}, providers: {}, ...opts.cfg } as any as Config;
  const cache = { available_models: [], ...opts.cache } as any as Cache;
  m.setConfig(cfg);
  m.setCache(cache);
  m.setGdpval({});
  m.setMetrics({});
  m.setModelMap(opts.modelMap ?? {}, []);
  m.setModelRegistry(opts.registry === undefined ? { find: () => undefined } : (opts.registry as any));
  return { cfg, cache };
}

const priced = (input: number, output: number) => ({ cost: { input, output } });

// ── free / billing tier ───────────────────────────────────────────────────

describe('isFreeModelRef / billingTier — free_models and discovery', () => {
  const providers = (list: string[]) => ({ fp: { billing: 'pay_per_token', free_models: list } }) as any;

  it('a listed FULL ref is free (and tier 0); an unlisted sibling is not (tier 3)', () => {
    world({ cfg: { providers: providers(['fp/a']) } });
    expect(m.isFreeModelRef('fp/a', providers(['fp/a']), [])).toBe(true);
    expect(m.isFreeModelRef('fp/b', providers(['fp/a']), [])).toBe(false);
    expect(m.billingTier('fp/a')).toBe(0);
    expect(m.billingTier('fp/b')).toBe(3);
  });

  it('a listed BARE id frees only the ref it belongs to', () => {
    world({ cfg: { providers: providers(['bare-id']) } });
    expect(m.isFreeModelRef('fp/bare-id', providers(['bare-id']), [])).toBe(true);
    expect(m.isFreeModelRef('fp/other', providers(['bare-id']), [])).toBe(false);
    expect(m.billingTier('fp/bare-id')).toBe(0);
    expect(m.billingTier('fp/other')).toBe(3);
  });

  it('the bare id of a multi-segment ref keeps its inner slashes', () => {
    world({ cfg: { providers: providers(['z-ai/glm-x']) } });
    expect(m.isFreeModelRef('fp/z-ai/glm-x', providers(['z-ai/glm-x']), [])).toBe(true);
    expect(m.billingTier('fp/z-ai/glm-x')).toBe(0);
    expect(m.isFreeModelRef('fp/z-aiglm-x', providers(['z-ai/glm-x']), [])).toBe(false);
  });

  it('discovered with cost_per_m 0 is free; an undefined discovery list is not a crash', () => {
    const discovered = [{ provider: 'fp', id: 'zero', cost_per_m: 0 }] as any;
    world({ cfg: { providers: providers([]) }, cache: { available_models: discovered } });
    expect(m.isFreeModelRef('fp/zero', providers([]), discovered)).toBe(true);
    expect(m.isFreeModelRef('fp/zero', providers([]), undefined)).toBe(false);
    expect(m.billingTier('fp/zero')).toBe(0);
  });
});

// ── cost placeholder healing (getM / resolveCostPerM) ─────────────────────

describe('getM — cost_per_m resolution and healing', () => {
  it('a local provider ref that was never discovered still costs 0', () => {
    world({});
    expect(m.getM('ollama/never-listed').cost_per_m).toBe(0);
  });

  it('a payg ref discovered with cost 0 resolves to 0; the same ref undiscovered is unknown', () => {
    world({ cache: { available_models: [{ provider: 'zz', id: 'scan-zero', cost_per_m: 0 }] as any } });
    expect(m.getM('zz/scan-zero').cost_per_m).toBe(0);
    expect(m.getM('zz/undiscovered').cost_per_m).toBe('unknown');
  });

  it('a :free tag resolves to 0', () => {
    world({});
    expect(m.getM('zz/anything:free').cost_per_m).toBe(0);
  });

  it('a stale "unknown" heals once the registry publishes a price; a real price never does', () => {
    const registry = { map: new Map<string, unknown>(), find(p: string, id: string) { return this.map.get(`${p}/${id}`); } };
    world({ cfg: { model_metrics: { 'zz/real': { cost_per_m: 7 } } as any }, registry });
    expect(m.getM('zz/late').cost_per_m).toBe('unknown');
    registry.map.set('zz/late', priced(3, 9));
    registry.map.set('zz/real', priced(1, 1));
    expect(m.getM('zz/late').cost_per_m).toBe(3);
    expect(m.getM('zz/real').cost_per_m).toBe(7); // user-configured price is never overwritten
  });

  it('a 0 placeholder heals too once a registry price appears', () => {
    const registry = { map: new Map<string, unknown>(), find(p: string, id: string) { return this.map.get(`${p}/${id}`); } };
    world({ cache: { available_models: [{ provider: 'zz', id: 'zero-first', cost_per_m: 0 }] as any }, registry });
    expect(m.getM('zz/zero-first').cost_per_m).toBe(0);
    registry.map.set('zz/zero-first', priced(4, 8));
    expect(m.getM('zz/zero-first').cost_per_m).toBe(4);
  });

  it('configured throughput and latency are honored, defaults are 100 tps / 1000 ms', () => {
    world({ cfg: { model_metrics: { 'zz/tuned': { cost_per_m: 1, throughput_tps: 55, avg_latency_ms: 321 } } as any } });
    expect(m.getM('zz/tuned').throughput_tps).toBe(55);
    expect(m.getM('zz/tuned').avg_latency_ms).toBe(321);
    expect(m.getM('zz/plain').throughput_tps).toBe(100);
    expect(m.getM('zz/plain').avg_latency_ms).toBe(1000);
  });
});

describe('updateMetrics — guards', () => {
  it('a call without tokens leaves throughput alone and persists no benchmark', () => {
    const { cache } = world({ cfg: { model_metrics: { 'zz/u': { cost_per_m: 1, throughput_tps: 80 } } as any } });
    m.updateMetrics('zz/u', 500, 0, 1000);
    expect(m.getM('zz/u').throughput_tps).toBe(80);
    expect(cache.benchmarks).toBeUndefined();
  });

  it('a zero-duration call is skipped, not turned into Infinity throughput', () => {
    const { cache } = world({ cfg: { model_metrics: { 'zz/u': { cost_per_m: 1, throughput_tps: 80 } } as any } });
    m.updateMetrics('zz/u', 500, 100, 0);
    expect(m.getM('zz/u').throughput_tps).toBe(80);
    expect(cache.benchmarks).toBeUndefined();
  });

  it('a throughput update keeps benchmarks of OTHER refs', () => {
    const { cache } = world({
      cfg: { model_metrics: { 'zz/u': { cost_per_m: 1, throughput_tps: 80 } } as any },
      cache: { benchmarks: { 'zz/other': 42 } },
    });
    m.updateMetrics('zz/u', 500, 100, 1000);
    expect(cache.benchmarks!['zz/other']).toBe(42);
    expect(cache.benchmarks!['zz/u']).toBeCloseTo(80 * 0.7 + 100 * 0.3, 6);
  });
});

// ── registry price lookup ─────────────────────────────────────────────────

describe('registry price lookup — findRegistryModel / registryCost', () => {
  function registryOf(entries: Record<string, unknown>): Registry {
    return { find: (p, id) => entries[`${p}/${id}`] };
  }

  it('a registry price is returned as-is', () => {
    world({ registry: registryOf({ 'zz/priced': priced(3, 9) }) });
    expect(m.lookupPrice('zz/priced')).toEqual({ input: 3, output: 9 });
  });

  it('a half-zero registry price is a real price (only {0,0} means free)', () => {
    world({ registry: registryOf({ 'zz/in0': priced(0, 5), 'zz/out0': priced(5, 0) }) });
    expect(m.lookupPrice('zz/in0')).toEqual({ input: 0, output: 5 });
    expect(m.lookupPrice('zz/out0')).toEqual({ input: 5, output: 0 });
  });

  it('a half-string registry cost is not a price (either half)', () => {
    world({ registry: registryOf({ 'zz/in-str': priced('x' as any, 1), 'zz/out-str': priced(1, 'x' as any) }) });
    expect(m.lookupPrice('zz/in-str')).toBeNull();
    expect(m.lookupPrice('zz/out-str')).toBeNull();
  });

  it('the :free retry only happens for :free ids, and never overwrites a hit', () => {
    // 'abcdefghij' minus its last 5 chars is 'abcde' — a non-:free miss must NOT retry that.
    world({ registry: registryOf({ 'zz/abcde': priced(1, 1), 'zz/x:free': priced(2, 2), 'zz/x': priced(9, 9) }) });
    expect(m.lookupPrice('zz/abcdefghij')).toBeNull();
    expect(m.lookupPrice('zz/x:free')).toEqual({ input: 2, output: 2 }); // found directly, not replaced by 'zz/x'
    world({ registry: registryOf({ 'zz/y': priced(5, 5) }) });
    expect(m.lookupPrice('zz/y:free')).toEqual({ input: 5, output: 5 }); // stripped retry
  });

  it('alias retry tries EVERY sibling id and finds the one the registry knows', () => {
    const modelMap = { 'm-a': 'slug', 'm-b': 'slug', 'm-c': 'slug' };
    world({ modelMap, registry: registryOf({ 'zz/m-c': priced(6, 6) }) });
    expect(m.lookupPrice('zz/m-a')).toEqual({ input: 6, output: 6 }); // m-b misses, m-c hits
  });

  it('alias groups include their FIRST member: asking for the 2nd id finds the 1st', () => {
    const modelMap = { 'first-id': 'slug', 'second-id': 'slug' };
    world({ modelMap, registry: registryOf({ 'zz/first-id': priced(8, 8) }) });
    expect(m.lookupPrice('zz/second-id')).toEqual({ input: 8, output: 8 });
  });

  it('provider-prefixed model-map keys and unmapped ids never act as aliases', () => {
    const modelMap = { 'zz/prefixed': 'slug', 'plain-id': 'slug' };
    world({ modelMap, registry: registryOf({ 'zz/zz/prefixed': priced(1, 1) }) });
    expect(m.lookupPrice('zz/plain-id')).toBeNull();
  });
});

// ── OpenRouter fallback chain ─────────────────────────────────────────────

describe('orFallbackPrice — pricing-cache semantics', () => {
  it('a priced exact entry is returned unchanged', () => {
    world({ cache: { openrouter_pricing: { 'zz/p': { input: 2, output: 3 } } } });
    expect(m.lookupPrice('zz/p')).toEqual({ input: 2, output: 3 });
  });

  it('a half-zero entry is a real price, not "free" and not "unknown"', () => {
    world({ cache: { openrouter_pricing: { 'zz/in0': { input: 0, output: 5 }, 'zz/out0': { input: 5, output: 0 } } } });
    expect(m.lookupPrice('zz/in0')).toEqual({ input: 0, output: 5 });
    expect(m.lookupPrice('zz/out0')).toEqual({ input: 5, output: 0 });
  });

  it('a {0,0} entry is unknown unless the model is discovered free or listed in free_models', () => {
    world({ cache: { openrouter_pricing: { 'zz/z': { input: 0, output: 0 } } } });
    expect(m.lookupPrice('zz/z')).toEqual({ input: 'unknown', output: 'unknown' });
    world({
      cfg: { providers: { zz: { free_models: ['zz/z'] } } as any },
      cache: { openrouter_pricing: { 'zz/z': { input: 0, output: 0 } } },
    });
    expect(m.lookupPrice('zz/z')).toEqual({ input: 0, output: 0 });
    world({
      cache: { openrouter_pricing: { 'zz/z': { input: 0, output: 0 } }, available_models: [{ provider: 'zz', id: 'z', cost_per_m: 0 }] as any },
    });
    expect(m.lookupPrice('zz/z')).toEqual({ input: 0, output: 0 });
  });

  it('a {0,0} entry on a config without a providers block does not crash', () => {
    const { cfg } = world({ cache: { openrouter_pricing: { 'zz/z': { input: 0, output: 0 } } } });
    delete (cfg as any).providers;
    expect(m.lookupPrice('zz/z')).toEqual({ input: 'unknown', output: 'unknown' });
  });

  it('backfill: a paid entry under another provider prefix prices the same model', () => {
    world({ cache: { openrouter_pricing: { 'openrouter/glm-x': { input: 2, output: 4 } } } });
    expect(m.lookupPrice('chutes/glm-x')).toEqual({ input: 2, output: 4 });
  });

  it('backfill skips free-tier entries and keeps the FIRST paid one', () => {
    world({
      cache: {
        openrouter_pricing: {
          'openrouter/glm-y:free': { input: 0, output: 0 },
          'a/glm-y': { input: 3, output: 3 },
          'b/glm-y': { input: 9, output: 9 },
        },
      },
    });
    expect(m.lookupPrice('chutes/glm-y')).toEqual({ input: 3, output: 3 });
  });

  it('the paid index follows in-place additions and a replaced pricing table', () => {
    const { cache } = world({ cache: { openrouter_pricing: { 'x/old-model': { input: 1, output: 1 } } } });
    expect(m.lookupPrice('chutes/old-model')).toEqual({ input: 1, output: 1 });
    expect(m.lookupPrice('chutes/new-model')).toBeNull();
    cache.openrouter_pricing!['x/new-model'] = { input: 2, output: 2 }; // scan-runner mutates in place
    expect(m.lookupPrice('chutes/new-model')).toEqual({ input: 2, output: 2 });
    // a NEW table object with the SAME key count (2): identity alone must trigger the rebuild
    m.setCache({ ...cache, openrouter_pricing: { 'y/old-model': { input: 5, output: 5 }, 'y/filler': { input: 6, output: 6 } } } as any);
    expect(m.lookupPrice('chutes/old-model')).toEqual({ input: 5, output: 5 });
    expect(m.lookupPrice('chutes/new-model')).toBeNull();
  });

  it('config provider estimate is the last resort and only for declared providers', () => {
    world({ cfg: { providers: { zz: { cost_per_m: 4 } } as any } });
    expect(m.lookupPrice('zz/anything')).toEqual({ input: 4, output: 4 });
    expect(m.lookupPrice('other/anything')).toBeNull();
  });

  it('lookupListPrice prefers the registry over the pricing cache', () => {
    world({
      registry: { find: (p, id) => (p === 'zz' && id === 'both' ? priced(4, 8) : undefined) },
      cache: { openrouter_pricing: { 'zz/both': { input: 1, output: 1 } } },
    });
    expect(m.lookupListPrice('zz/both')).toEqual({ input: 4, output: 8 });
  });
});

// ── subscription rule (ADR-0025 B2) ───────────────────────────────────────

describe('effCost — subscription rule cost', () => {
  const EPS = 1e-6;
  const FALLBACK = 1.5e-6;
  const sub = { providers: { sp: { billing: 'subscription' } } as any };

  it('eps x list input price when the list price is positive', () => {
    world({ cfg: sub, cache: { openrouter_pricing: { 'sp/m': { input: 10, output: 30 } } } });
    expect(m.effCost('sp/m')).toBeCloseTo(EPS * 10, 12);
  });

  it('the rule cost is multiplied by the provider cost multiplier, not divided', () => {
    world({ cfg: sub, cache: { openrouter_pricing: { 'sp/m': { input: 10, output: 30 } }, cost_mux: { sp: 4 } } });
    expect(m.effCost('sp/m')).toBeCloseTo(EPS * 10 * 4, 12);
  });

  it('no list price, a zero list price, or an unknown list price → the constant fallback', () => {
    world({ cfg: sub, cache: { openrouter_pricing: { 'sp/zero-in': { input: 0, output: 7 }, 'sp/unk': { input: 0, output: 0 } } } });
    expect(m.effCost('sp/none')).toBe(FALLBACK);
    expect(m.effCost('sp/zero-in')).toBe(FALLBACK);
    expect(m.effCost('sp/unk')).toBe(FALLBACK); // {0,0} undiscovered → 'unknown' list price
  });

  it('a non-subscription zero-cost ref stays exactly 0', () => {
    world({ cache: { available_models: [{ provider: 'zz', id: 'free', cost_per_m: 0 }] as any } });
    expect(m.effCost('zz/free')).toBe(0);
  });
});

// ── usage windows ─────────────────────────────────────────────────────────

describe('usage log windows', () => {
  const NOW = 1_800_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const entry = (ref: string, ts: number, tokens: number, extra: Record<string, number> = {}) => ({ ref, ts, tokens, ...extra }) as any;

  it('getUsage / getUsageAll: the window is `days` x 24h, and the cutoff instant itself is OUTSIDE', () => {
    world({
      cache: {
        usage_log: [
          entry('zz/a', NOW - 2 * DAY + 1, 10), // inside 2 days
          entry('zz/a', NOW - 2 * DAY, 100), // exactly at the cutoff → outside
          entry('zz/a', NOW - 3 * DAY, 1000),
          entry('zz/b', NOW - DAY / 2, 5),
        ],
      },
    });
    expect(m.getUsage('zz/a', 2)).toBe(10);
    expect(m.getUsageAll(2)).toEqual({ 'zz/a': 10, 'zz/b': 5 });
    // 1 day: a 23h-old entry is in, a 25h-old one is out (kills 60/24-style window arithmetic)
    world({ cache: { usage_log: [entry('zz/a', NOW - 23 * 3600_000, 1), entry('zz/a', NOW - 25 * 3600_000, 2)] } });
    expect(m.getUsage('zz/a', 1)).toBe(1);
    expect(m.getUsageAll(1)).toEqual({ 'zz/a': 1 });
    expect(m.getCacheUsageAll(1)).toEqual({});
    // cache window: a 23h-old entry with cache tokens is inside 1 day, a 25h-old one is not
    world({
      cache: {
        usage_log: [entry('zz/in', NOW - 23 * 3600_000, 1, { cacheRead: 3 }), entry('zz/out', NOW - 25 * 3600_000, 1, { cacheRead: 4 })],
      },
    });
    expect(m.getCacheUsageAll(1)).toEqual({ 'zz/in': { cacheRead: 3, cacheWrite: 0 } });
  });

  it('getCacheUsageAll: only entries with cache tokens inside the window count; either side alone is enough', () => {
    world({
      cache: {
        usage_log: [
          entry('zz/r', NOW - 1000, 1, { cacheRead: 5 }),
          entry('zz/w', NOW - 1000, 1, { cacheWrite: 7 }),
          entry('zz/none', NOW - 1000, 1),
          entry('zz/old', NOW - 2 * DAY, 1, { cacheRead: 99 }),
          entry('zz/edge', NOW - DAY, 1, { cacheRead: 99 }), // exactly at the 1-day cutoff → outside
          entry('zz/r', NOW - 500, 1, { cacheRead: 1, cacheWrite: 2 }),
        ],
      },
    });
    expect(m.getCacheUsageAll(1)).toEqual({
      'zz/r': { cacheRead: 6, cacheWrite: 2 },
      'zz/w': { cacheRead: 0, cacheWrite: 7 },
    });
  });
});

// ── lookupContextWindow ───────────────────────────────────────────────────

describe('lookupContextWindow — registry value must be a positive number', () => {
  it('a registry model without a window falls through to the scan capabilities', () => {
    world({
      registry: { find: () => ({ id: 'cw' }) },
      cache: { available_models: [{ provider: 'zz', id: 'cw', cost_per_m: 1, capabilities: { contextWindow: 8000 } }] as any },
    });
    expect(m.lookupContextWindow('zz/cw')).toBe(8000);
  });

  it('a registry window of 0 is not authoritative either', () => {
    world({
      registry: { find: () => ({ id: 'cw', contextWindow: 0 }) },
      cache: { available_models: [{ provider: 'zz', id: 'cw', cost_per_m: 1, capabilities: { contextWindow: 9000 } }] as any },
    });
    expect(m.lookupContextWindow('zz/cw')).toBe(9000);
  });

  it('a positive registry window wins over the scan value', () => {
    world({
      registry: { find: () => ({ id: 'cw', contextWindow: 123456 }) },
      cache: { available_models: [{ provider: 'zz', id: 'cw', cost_per_m: 1, capabilities: { contextWindow: 9000 } }] as any },
    });
    expect(m.lookupContextWindow('zz/cw')).toBe(123456);
  });
});

// ── small state contracts ─────────────────────────────────────────────────

describe('state contracts', () => {
  it('setConfig makes gdpval_builtin visible through getGdpval immediately', () => {
    world({});
    m.setConfig({ model_groups: {}, model_metrics: {}, providers: {}, gdpval_builtin: { 'builtin-slug': 777 } } as any);
    expect(m.getGdpval()['builtin-slug']).toBe(777);
  });

  it('getModelRegistry returns what setModelRegistry stored', () => {
    const registry = { find: () => undefined };
    m.setModelRegistry(registry);
    expect(m.getModelRegistry()).toBe(registry);
  });

  it('getCapabilityProfiles exposes the profiles merged by setCache', () => {
    world({ cache: { capability_profiles: { 'cap-slug': { briefcase: 5 } } as any } });
    expect(m.getCapabilityProfiles()['cap-slug']).toEqual({ briefcase: 5 });
  });

  it('lookupGdp: an exact slug score wins over a token-equivalent key with a higher score', () => {
    world({ modelMap: { 'x-model': 'alpha-beta' } });
    m.setGdpval({ 'alpha-beta': 100, 'beta-alpha': 200 });
    expect(m.lookupGdp('x-model')).toBe(100);
  });
});

describe('loadModelMap — exact vs wildcard, reload, loud failure', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelmap-r1-'));
    vi.mocked(loggerModule.errorLog).mockClear();
  });

  it('an exact key is not a prefix; a wildcard is', () => {
    fs.writeFileSync(path.join(dir, 'model-map.yaml'), 'abcd: exact-slug\nwild-*: wild-slug\n');
    m.loadModelMap(dir);
    expect(m.mapLookup('abcd')).toBe('exact-slug');
    expect(m.mapLookup('abcde')).toBeUndefined();
    expect(m.mapLookup('abc')).toBeUndefined();
    expect(m.mapLookup('wild-anything')).toBe('wild-slug');
  });

  it('reloading drops the previous map and wildcards; nothing synthetic is left behind', () => {
    fs.writeFileSync(path.join(dir, 'model-map.yaml'), 'wild-*: wild-slug\n');
    m.loadModelMap(dir);
    fs.writeFileSync(path.join(dir, 'model-map.yaml'), 'only: only-slug\n');
    m.loadModelMap(dir);
    expect(m.mapLookup('wild-anything')).toBeUndefined();
    expect(m.mapLookup('Sonnet-5')).toBeUndefined();
    expect(m.mapLookup('only')).toBe('only-slug');
  });

  it('a broken file clears everything, leaves no synthetic wildcard, and logs the parse failure', () => {
    fs.writeFileSync(path.join(dir, 'model-map.yaml'), 'a-*: a-slug\n');
    m.loadModelMap(dir);
    fs.writeFileSync(path.join(dir, 'model-map.yaml'), '{ unparseable');
    m.loadModelMap(dir);
    expect(m.mapLookup('a-x')).toBeUndefined();
    expect(m.mapLookup('Sonnet-5')).toBeUndefined();
    const msg = String(vi.mocked(loggerModule.errorLog).mock.calls[0]?.[0] ?? '');
    expect(msg).toContain('model-map.yaml failed to parse');
    expect(msg).toContain('model-map overrides are DISABLED');
  });
});

// ── fresh-module contracts ────────────────────────────────────────────────

describe('fresh module — first version bump must build the token-set index', () => {
  async function fresh() {
    vi.resetModules();
    return await import('../src/metrics.ts');
  }
  // 'x-model' maps to a slug whose score is stored under a token-equivalent key.
  const MAP = { 'x-model': 'alpha-beta-1' };
  const SCORES = { 'beta-alpha-1': 700 };

  it('setGdpval', async () => {
    const f = await fresh();
    f.setModelMap(MAP, []);
    f.setGdpval(SCORES);
    expect(f.lookupGdp('x-model')).toBe(700);
  });

  it('setConfig gdpval_builtin', async () => {
    const f = await fresh();
    f.setModelMap(MAP, []);
    f.setConfig({ model_groups: {}, model_metrics: {}, providers: {}, gdpval_builtin: SCORES } as any);
    expect(f.lookupGdp('x-model')).toBe(700);
  });

  it('setCache gdpval_scores', async () => {
    const f = await fresh();
    f.setModelMap(MAP, []);
    f.setCache({ gdpval_scores: SCORES } as any);
    expect(f.lookupGdp('x-model')).toBe(700);
  });

  it('getM works before any setConfig (default config has a model_metrics block)', async () => {
    const f = await fresh();
    expect(() => f.getM('zz/never-configured')).not.toThrow();
    expect(f.getM('zz/never-configured').gdpval).toBe(50);
  });
});
