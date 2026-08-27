// test/refactor-golden-master.test.ts
// Golden-master tests: pin the BEHAVIOUR of GDPval/model-map lookup BEFORE
// the refactor that eliminates the duplicated lookupGdp/mapLookup/loadModelMap
// implementations between index.ts (closure) and metrics.ts (export).
//
// These tests treat the public API (metrics.ts exports + the Router class) as
// a black box. They must pass BEFORE and AFTER the refactor. Any behaviour
// change surfaces as a failing test.
//
// What's covered:
//   1. model-map lookup (exact, wildcard, null exclusion, provider-prefix strip)
//   2. GDPval lookup (map → token-set → self-heal from cache)
//   3. gdpval_builtin overrides vs scraped scores
//   4. Router.allDiscoveredRefs + getTopModels honour exclude rules
//   5. The GLM-5-2 regression end-to-end (the bug that motivated all this)

import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Router } from '../src/routing.js';
import * as metricsModule from '../src/metrics.js';
import { isExcluded } from '../src/exclude.js';
import type { Config, Cache } from '../src/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────

// model-map.yaml is identical at repo root and in dist/ (dist/ is just a
// build-output copy). Reading it from the repo root means these tests don't
// depend on `npm run build` having run first — CI runs tests before the
// build step, so pointing this at dist/ would ENOENT on a fresh checkout.
const EXT_DIR = path.resolve(__dirname, '..');

function resetMetrics() {
  metricsModule.setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: {} });
  metricsModule.setCache({});
  metricsModule.setGdpval({});
  metricsModule.setModelMap({}, []);
}

beforeEach(() => {
  resetMetrics();
});

// ── 1. Model-map lookup behaviour ────────────────────────────────────────

describe('golden master: model-map lookup', () => {
  it('exact match: zai-glm-5-2 maps to glm-5-2 slug', () => {
    metricsModule.setModelMap({ 'zai-glm-5-2': 'glm-5-2' }, []);
    metricsModule.setGdpval({ 'glm-5-2': 1506 });
    expect(metricsModule.lookupGdp('zai-glm-5-2')).not.toBeNull();
    expect(metricsModule.lookupGdp('zai-glm-5-2')).toBe(1506);
  });

  it('wildcard match: "claude-sonnet-4-5-*" → "claude-4-5-sonnet"', () => {
    metricsModule.setModelMap({}, [['claude-sonnet-4-5-', 'claude-4-5-sonnet']]);
    metricsModule.setGdpval({ 'claude-4-5-sonnet': 720 });
    expect(metricsModule.lookupGdp('claude-sonnet-4-5-20250929')).toBe(720);
  });

  it('explicit null exclusion: "turbo" → null → returns null', () => {
    metricsModule.setModelMap({ 'zai-org/GLM-5-Turbo': null }, []);
    metricsModule.setGdpval({ 'glm-5': 1418 });
    expect(metricsModule.lookupGdp('zai-org/GLM-5-Turbo')).toBeNull();
  });

  it('provider prefix stripped before lookup: "mistral/glm-5-2" → "glm-5-2"', () => {
    metricsModule.setModelMap({ 'glm-5-2': 'glm-5-2' }, []);
    metricsModule.setGdpval({ 'glm-5-2': 1506 });
    expect(metricsModule.lookupGdp('mistral/glm-5-2')).toBe(1506);
    expect(metricsModule.lookupGdp('mistral-zai/glm-5-2')).toBe(1506);
  });

  it('map entry beats token-set fallback (zai-glm-5-2 → glm-5-2 not glm-4)', () => {
    // zai-glm-5-2 tokens {zai,glm,5,2} would NOT match glm-5-2 {glm,5,2} via
    // token-set. The map entry must win.
    metricsModule.setModelMap({ 'zai-glm-5-2': 'glm-5-2' }, []);
    metricsModule.setGdpval({ 'glm-5-2': 1506, 'glm-4': 400 });
    expect(metricsModule.lookupGdp('zai-glm-5-2')).toBe(1506);
  });
});

// ── 2. GDPval lookup: tiers and self-healing ──────────────────────────────

describe('golden master: GDPval lookup tiers', () => {
  it('returns null when neither map nor token-set nor cache matches', () => {
    metricsModule.setModelMap({}, []);
    metricsModule.setGdpval({ 'glm-5-2': 1506 });
    expect(metricsModule.lookupGdp('completely-unknown-model')).toBeNull();
  });

  it('token-set fallback: "mistral/glm-5-2" → {glm,5,2} → 1506 (no map entry)', () => {
    metricsModule.setModelMap({}, []);
    metricsModule.setGdpval({ 'glm-5-2': 1506 });
    expect(metricsModule.lookupGdp('mistral/glm-5-2')).toBe(1506);
  });

  it('self-heals from cache.gdpval_scores when gdpval is empty', () => {
    // Simulate the race: gdpval emptied, cache still has scores.
    metricsModule.setModelMap({ 'zai-glm-5-2': 'glm-5-2' }, []);
    // Don't call setGdpval (leave empty), but set cache with scores.
    metricsModule.setCache({ gdpval_scores: { 'glm-5-2': 1506 } });
    // lookupGdp must self-heal from cache.
    expect(metricsModule.lookupGdp('zai-glm-5-2')).toBe(1506);
  });

  it('does not clobber populated gdpval with stale cache (idempotent)', () => {
    metricsModule.setModelMap({ 'glm-5-2': 'glm-5-2' }, []);
    metricsModule.setCache({ gdpval_scores: { 'glm-5-2': 999 } }); // stale
    metricsModule.setGdpval({ 'glm-5-2': 1506 }); // fresh (simulating scan)
    expect(metricsModule.lookupGdp('glm-5-2')).toBe(1506);
  });
});

// ── 3. gdpval_builtin overrides ───────────────────────────────────────────

describe('golden master: gdpval_builtin overrides', () => {
  it('builtin overrides scraped score (manual override wins)', () => {
    metricsModule.setConfig({
      model_groups: {},
      model_metrics: {},
      gdpval_builtin: { 'glm-4': 999 },
    });
    metricsModule.setCache({ gdpval_scores: { 'glm-4': 400 } });
    metricsModule.setModelMap({ 'glm-4': 'glm-4' }, []);
    expect(metricsModule.lookupGdp('glm-4')).toBe(999);
  });

  it('builtin does NOT shadow a model not in builtin (glm-5-2 survives)', () => {
    metricsModule.setConfig({
      model_groups: {},
      model_metrics: {},
      gdpval_builtin: { 'glm-4': 400 }, // no glm-5-2 entry
    });
    metricsModule.setCache({ gdpval_scores: { 'glm-5-2': 1506 } });
    metricsModule.setModelMap({ 'glm-5-2': 'glm-5-2' }, []);
    expect(metricsModule.lookupGdp('glm-5-2')).toBe(1506);
  });
});

// ── 4. Exclude rules (live table filtering) ───────────────────────────────

describe('golden master: exclude rules in allDiscoveredRefs', () => {
  const cache: Cache = {
    available_models: [
      { id: 'glm-5-2', provider: 'mistral', cost_per_m: 0 },
      { id: 'anthropic/claude-opus-5', provider: 'openrouter', cost_per_m: 5 },
      { id: 'anthropic/claude-fable-5', provider: 'openrouter', cost_per_m: 10 },
      { id: 'qwen3-4b:free', provider: 'openrouter', cost_per_m: 0 },
      { id: 'gemma4:latest', provider: 'ollama', cost_per_m: 0 },
    ],
  };
  const baseCfg: Config = {
    model_groups: { strategic: { method: 'best', min_gdpval: 0 }, scout: { method: 'tiered', min_gdpval: 0 } },
    model_metrics: {},
  };

  function makeRouter(exclude: Config['exclude']): Router {
    const cfg: Config = { ...baseCfg, exclude };
    metricsModule.setConfig(cfg);
    metricsModule.setCache(cache);
    metricsModule.loadModelMap(EXT_DIR);
    return new Router(cfg, cache, new Map());
  }

  it('no exclude → all refs returned', () => {
    const refs = makeRouter(undefined).allDiscoveredRefs();
    expect(refs).toContain('mistral/glm-5-2');
    expect(refs).toContain('openrouter/anthropic/claude-opus-5');
    expect(refs).toContain('openrouter/anthropic/claude-fable-5');
  });

  it('exclude.providers drops a whole provider', () => {
    const refs = makeRouter({ providers: ['openrouter'] }).allDiscoveredRefs();
    expect(refs.filter((r) => r.startsWith('openrouter/'))).toEqual([]);
    expect(refs).toContain('mistral/glm-5-2');
  });

  it('exclude.models glob drops matching models', () => {
    const refs = makeRouter({ models: ['*fable*'] }).allDiscoveredRefs();
    expect(refs).not.toContain('openrouter/anthropic/claude-fable-5');
    expect(refs).toContain('openrouter/anthropic/claude-opus-5');
  });

  it('paid_models_from keeps :free tier, drops paid', () => {
    const cfg: Config = {
      ...baseCfg,
      providers: {
        openrouter: {
          billing: 'pay_per_token',
          free_models: ['openrouter/qwen3-4b:free'],
        },
      },
      exclude: { paid_models_from: ['openrouter'] },
    };
    metricsModule.setConfig(cfg);
    metricsModule.setCache(cache);
    metricsModule.loadModelMap(EXT_DIR);
    const router = new Router(cfg, cache, new Map());
    const refs = router.allDiscoveredRefs();
    expect(refs).not.toContain('openrouter/anthropic/claude-opus-5');
    expect(refs).not.toContain('openrouter/anthropic/claude-fable-5');
    expect(refs).toContain('openrouter/qwen3-4b:free');
    expect(refs).toContain('mistral/glm-5-2');
  });
});

// ── 5. GLM-5-2 end-to-end regression ──────────────────────────────────────
// Self-contained fixture (cache/cfg built inline below) plus the real
// model-map.yaml — no external files or services needed, so this runs by
// default like every other describe block in this file.

describe('golden master: GLM-5-2 end-to-end regression', () => {
  // The bug: GLM-5-2 must appear in strategic (≥700) with ~1506, not vanish
  // or get mis-matched to glm-4 (400).
  const cache: Cache = {
    available_models: [
      { id: 'glm-5-2', provider: 'mistral', cost_per_m: 0 },
      { id: 'zai-glm-5-2', provider: 'mistral', cost_per_m: 0 },
      { id: 'glm-4.6:cloud', provider: 'ollama', cost_per_m: 0 },
    ],
    // model-map.yaml maps glm-5-2/zai-glm-5-2 to slug 'glm-5-2' (the model
    // IS GLM-5.2; AA benchmarks glm-5-2 and glm-5-3 separately — do NOT remap
    // onto the 5.3 slug, that would falsely assign the 5.3 score), so the
    // score must be keyed under the glm-5-2 slug.
    gdpval_scores: { 'glm-5-2': 1506, 'glm-4': 400 },
  };
  const cfg: Config = {
    providers: {
      mistral: { billing: 'pay_per_token' },
      ollama: { billing: 'subscription' },
    },
    model_groups: {
      strategic: { method: 'best', min_gdpval: 700 },
      tactical: { method: 'best', min_gdpval: 600 },
      operational: { method: 'tiered', min_gdpval: 300 },
      scout: { method: 'tiered', min_gdpval: 0 },
    },
    model_metrics: {},
    gdpval_builtin: { 'glm-4': 400 },
  };

  beforeEach(() => {
    // Load the REAL model-map.yaml (has zai-glm-5-2 → glm-5-2 entry).
    metricsModule.setConfig(cfg);
    metricsModule.setCache(cache);
    metricsModule.setGdpval(cache.gdpval_scores ?? {});
    metricsModule.loadModelMap(EXT_DIR);
  });

  it('lookupGdp(mistral/zai-glm-5-2) > 1000 (not 400 = glm-4)', () => {
    const score = metricsModule.lookupGdp('mistral/zai-glm-5-2');
    expect(score).toBeGreaterThan(1000);
    expect(score).not.toBe(400);
  });

  it('lookupGdp(mistral/glm-5-2) > 1000', () => {
    expect(metricsModule.lookupGdp('mistral/glm-5-2')).toBeGreaterThan(1000);
  });

  it('getTopModels(strategic) includes a GLM-5-2 model', () => {
    const router = new Router(cfg, cache, new Map());
    const top = router.getTopModels('strategic', 20);
    const refs = top.map((t) => t.ref);
    expect(refs.some((r) => r.toLowerCase().includes('glm-5-2'))).toBe(true);
  });

  it('getTopModels(strategic) does NOT include glm-4 (too low)', () => {
    const router = new Router(cfg, cache, new Map());
    const top = router.getTopModels('strategic', 20);
    const refs = top.map((t) => t.ref);
    // glm-4.6:cloud resolves to glm-4 (400) via token-set match, below
    // strategic's 700 threshold. If it appears here, the GDPval lookup for
    // Ollama's tagged model ids is broken.
    expect(refs).not.toContain('ollama/glm-4.6:cloud');
  });

  it('allDiscoveredRefs includes GLM models', () => {
    const router = new Router(cfg, cache, new Map());
    const refs = router.allDiscoveredRefs();
    expect(refs.some((r) => r.toLowerCase().includes('glm-5-2'))).toBe(true);
  });
});

// ── 6. Workflow: load → lookupGdp consistency ────────────────────────────

describe('golden master: load() → lookupGdp consistency', () => {
  // This is the core invariant: after setConfig + setCache + loadModelMap,
  // lookupGdp must return consistent results — the same as what
  // generateDynamicConfig would compute. No "two implementations drift".
  it('lookupGdp is consistent after full setup (no drift between calls)', () => {
    const cache: Cache = {
      available_models: [{ id: 'glm-5-2', provider: 'mistral', cost_per_m: 0 }],
      // GLM-5-2 maps to the glm-5-2 slug in model-map.yaml (the model IS
      // GLM-5.2; AA benchmarks 5.2 and 5.3 separately). The score is 1769
      // here (AA-scraped, used as a stable test fixture).
      gdpval_scores: { 'glm-5-2': 1769, 'mistral-medium-3-5': 924 },
    };
    const cfg: Config = {
      model_groups: {},
      model_metrics: {},
      gdpval_builtin: { 'mistral-medium-3-5': 933 }, // override
    };
    metricsModule.setConfig(cfg);
    metricsModule.setCache(cache);
    metricsModule.loadModelMap(EXT_DIR);

    // First call (may trigger self-heal / index rebuild).
    const s1 = metricsModule.lookupGdp('mistral/glm-5-2');
    // Second call (must be identical — no state drift).
    const s2 = metricsModule.lookupGdp('mistral/glm-5-2');
    expect(s1).toBe(s2);
    expect(s1).toBe(1769); // via glm-5-2 → glm-5-2 map → 1769
  });
});
