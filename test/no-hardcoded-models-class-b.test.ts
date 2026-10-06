/**
 * ADR-0025 class-B invariant: annotation data can never ADMIT a model.
 *
 * `gdpval_builtin` (and the gdpval/score caches it feeds) is a name-keyed
 * annotation table — it may only score a model Pi's registry or the scan
 * cache already supplied. A model that exists ONLY as a score entry must
 * never become a candidate anywhere. Three admission paths are pinned:
 *   1. Router.allDiscoveredRefs() — the live candidate pool,
 *   2. selectClassifierCandidates() — the classifier cloud fallback,
 *   3. the persisted model_groups lists of router-config.dynamic.json.
 *
 * Every pin also asserts a real model IS admitted, so an empty pool can
 * never pass vacuously.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router } from '../src/routing.ts';
import { selectClassifierCandidates } from '../src/classifier-fallback-probe.ts';
import * as metricsModule from '../src/metrics.ts';
import type { Config, Cache } from '../src/types.ts';

/** Score-only phantom: a gdpval slug with no registry or cache entry. */
const PHANTOM_SLUG = 'phantom-score-only-model';
const isPhantom = (ref: string) => ref.includes(PHANTOM_SLUG);

function makeRegistry(models: Array<{ provider: string; id: string }>) {
  const all = models.map((m) => ({
    provider: m.provider,
    id: m.id,
    cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 },
  }));
  return {
    find: (provider: string, modelId: string) => all.find((m) => m.provider === provider && m.id === modelId),
    getAvailable: () => all,
    getRegisteredProviderIds: () => [...new Set(all.map((m) => m.provider))],
    hasConfiguredAuth: () => true,
    runtime: { hasConfiguredAuth: () => true },
  };
}

describe('class B pin 1: allDiscoveredRefs() never admits a score-only model', () => {
  const cfg: Config = {
    model_groups: {
      standard: { description: 'Standard', method: 'best', fallback_groups: [] },
    },
    providers: {},
    model_metrics: {},
    gdpval_builtin: { [PHANTOM_SLUG]: 950, 'model-a': 800 },
  } as any;

  const cache: Cache = {
    available_models: [{ provider: 'healthy-provider', id: 'model-a', cost_per_m: 0.1 }],
    gdpval_scores: { [PHANTOM_SLUG]: 950, 'model-a': 800 },
    model_score_cache: {},
    openrouter_pricing: {},
    usage_log: [],
    benchmarks: {},
    budget_cache: {},
    gdpval_scraped: true,
    lastScanTimestamp: Date.now(),
    models_cached: '',
  } as any;

  beforeEach(() => {
    metricsModule.setConfig(cfg);
    metricsModule.setCache(cache);
    metricsModule.setModelMap({}, []);
  });

  it('registry path: the real model is admitted, the gdpval_builtin phantom is not', () => {
    const router = new Router(cfg, cache, new Map());
    router.setSessionCtx({ modelRegistry: makeRegistry([{ provider: 'healthy-provider', id: 'model-a' }]) } as any);

    const refs = router.allDiscoveredRefs();

    expect(refs).toContain('healthy-provider/model-a');
    expect(refs.filter(isPhantom)).toEqual([]);
  });

  it('cache path (no session yet): the real model is admitted, the phantom is not', () => {
    const router = new Router(cfg, cache, new Map());

    const refs = router.allDiscoveredRefs();

    expect(refs).toContain('healthy-provider/model-a');
    expect(refs.filter(isPhantom)).toEqual([]);
  });
});

describe('class B pin 2: selectClassifierCandidates() never admits a score-only model', () => {
  const cfg: Config = {
    providers: {},
    model_groups: {},
    model_metrics: {},
    gdpval_builtin: { [PHANTOM_SLUG]: 100 },
  } as any;

  afterEach(() => {
    metricsModule.setConfig({ model_groups: {}, model_metrics: {}, providers: {} } as any);
    metricsModule.setCache({} as any);
  });

  it('a phantom with a low gdpval, a score mapping and a cheap price is still not a candidate', () => {
    const phantomRef = `openrouter/${PHANTOM_SLUG}`;
    const cache: Cache = {
      // Only the real model is in the scan inventory.
      available_models: [{ provider: 'openrouter', id: 'cheap-real', cost_per_m: 0 }],
      // The phantom carries every signal that would put it in Tier A —
      // except being in available_models.
      openrouter_pricing: {
        'openrouter/cheap-real': { input: 0, output: 0.05 },
        [phantomRef]: { input: 0, output: 0.01 },
      },
      model_score_cache: { [phantomRef]: PHANTOM_SLUG },
      gdpval_scores: { [PHANTOM_SLUG]: 100 },
    } as any;
    metricsModule.setConfig(cfg);
    metricsModule.setCache(cache);

    const result = selectClassifierCandidates(cfg, cache);

    expect(result).toContain('openrouter/cheap-real');
    expect(result.filter(isPhantom)).toEqual([]);
  });
});

// ── Pin 3: end-to-end through session_start + generateDynamicConfig ─────────

async function waitFor(check: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

/**
 * Starts the router (index.ts) against a valid scan cache and no persisted
 * dynamic config, so session_start regenerates router-config.dynamic.json.
 * Same pattern as test/dynamic-config-missing-regen.test.ts.
 */
async function startRouterWithPhantomBuiltin() {
  const stateDir = process.env.PI_ROUTER_STATE_DIR!;
  const dynamicPath = path.join(stateDir, 'router-config.dynamic.json');
  const cachePath = path.join(stateDir, '.cache', 'scan-cache.json');
  fs.rmSync(dynamicPath, { force: true });
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      lastScanTimestamp: Date.now(),
      gdpval_scraped: true,
      models_cached: new Date().toISOString(),
      available_models: [{ id: 'model-a', provider: 'healthy-provider', cost_per_m: 0.1 }],
      gdpval_scores: { 'model-a': 800, [PHANTOM_SLUG]: 950 },
    })
  );
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-class-b-'));
  // The project config adds the phantom to the annotation table only.
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, '.pi', 'router-config.json'),
    JSON.stringify({ gdpval_builtin: { [PHANTOM_SLUG]: 950 } })
  );
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error('network disabled in test'))) as typeof fetch;
  const cleanup = () => {
    cwdSpy.mockRestore();
    globalThis.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(dynamicPath, { force: true });
  };
  try {
    vi.resetModules();
    const mod = await import('../index.ts');
    const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
    (mod.default as any)({
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerProvider: vi.fn(),
      setModel: vi.fn(async () => true),
      on: vi.fn((event: string, handler: any) => {
        onHandlers[event] = handler;
      }),
    });
    const model = { provider: 'healthy-provider', id: 'model-a', api: 'openai-completions', contextWindow: 128_000,
      cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 } };
    const modelRegistry = {
      getAvailable: () => [model],
      find: (p: string, id: string) => (p === model.provider && id === model.id ? model : null),
      getApiKeyForProvider: async () => 'k',
      runtime: { streamSimple: vi.fn() },
    };
    await onHandlers['session_start']?.({}, { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } });
    return { dynamicPath, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

describe('class B pin 3: persisted dynamic group lists never contain a score-only model', () => {
  it('a gdpval_builtin-only phantom is in no model_groups.*.models list after regeneration', async () => {
    const { dynamicPath, cleanup } = await startRouterWithPhantomBuiltin();
    try {
      expect(await waitFor(() => fs.existsSync(dynamicPath))).toBe(true);
      const dynamic = JSON.parse(fs.readFileSync(dynamicPath, 'utf-8'));
      const persisted: string[] = Object.values(dynamic.model_groups ?? {}).flatMap(
        (g: any) => (Array.isArray(g?.models) ? g.models : [])
      );

      expect(persisted).toContain('healthy-provider/model-a');
      expect(persisted.filter(isPhantom)).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
