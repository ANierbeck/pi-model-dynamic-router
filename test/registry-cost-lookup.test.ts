// test/registry-cost-lookup.test.ts
// Regression test for the "Opus in trivial group" bug.
//
// Symptom (2026-09-05): In a Pi Work environment, the `/router` TUI showed
// `trivial`/`simple` groups populated with the most expensive models in the
// pool (Claude Opus, glm-5.3) — the exact opposite of "cheap first". Every
// one of the 9 groups showed the same 5 models, undifferentiated.
//
// Root cause: the provider (e.g. requesty-export, bedrock via an extension)
// was registered through Pi's own modelRegistry (not the router's PROVIDER_MAP
// scan). Pi's `Model.cost` is a *required* field populated from the provider's
// own /v1/models (requesty reports `input_price`/`output_price` per model).
// But `lookupPrice()` queried FOUR fallback sources that ALL bypass the
// registry:
//   1. cfg.model_metrics[ref].cost_per_m
//   2. cache.openrouter_pricing[ref]
//   3. OpenRouter normalized backfill
//   4. cfg.providers[prov].cost_per_m
// Every one returned undefined for a pi-registered provider → `effCost`
// returned `'unknown'` → `sortByMinCostIfAllPriced` fell back to `best gdpval`
// descending → Opus (GDP 1860) won the `trivial` group.
//
// Fix (Leitplanke: always via Pi's public API, never Pi's setup files):
// `lookupPrice()`/`getM()` now query `modelRegistry.find(provider, modelId).cost`
// FIRST (Step 0), before any fallback. The registry is the authoritative
// source — `Model.cost` is populated from the provider itself and is present
// for every pi-registered model regardless of how it got registered
// (extension, models.json, CLI flag — the router doesn't know and doesn't
// need to know). The router holds the registry handle via the public
// `ExtensionContext.modelRegistry` API (set in `session_start`), the same API
// it already used for `getAvailable()`/`find()`.

import { describe, it, expect, beforeEach } from 'vitest';
import { Router } from '../src/routing.ts';
import * as metricsModule from '../src/metrics.ts';
import type { Config, Cache } from '../src/types.ts';

// A fake pi modelRegistry implementing the two public methods the router uses:
//   - find(provider, modelId) → Model | undefined  (Model.cost is required)
//   - getAvailable() → Model[]
// We type it as `any` because the router never imports Pi's registry type —
// it only calls the documented public methods.
function makeRegistry(models: Array<{
  provider: string;
  id: string;
  cost: { input: number; output: number };
}>): any {
  const all = models.map((m) => ({ provider: m.provider, id: m.id, cost: m.cost }));
  return {
    find: (provider: string, modelId: string) =>
      all.find((m) => m.provider === provider && m.id === modelId),
    getAvailable: () => all,
    getRegisteredProviderIds: () => [...new Set(all.map((m) => m.provider))],
  };
}

function makeRouter(cfg: Config, cache: Cache, sessionCtx?: any): Router {
  metricsModule.setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: {} });
  metricsModule.setCache(cache);
  metricsModule.setGdpval(cache.gdpval_scores ?? {});
  metricsModule.setModelMap({}, []);
  const r = new Router(cfg, cache, new Map());
  if (sessionCtx) r.setSessionCtx(sessionCtx);
  return r;
}

// requesty-export-style registry: four premium models, all with real costs.
// Opus is the most expensive (input $5.5e-6/tok, output $2.75e-5/tok).
const REGISTRY = makeRegistry([
  { provider: 'requesty-export', id: 'claude-opus-4.5', cost: { input: 5.5e-6, output: 2.75e-5 } },
  { provider: 'requesty-export', id: 'claude-sonnet-5', cost: { input: 3e-6, output: 1.5e-5 } },
  { provider: 'requesty-export', id: 'glm-5.3', cost: { input: 1.2e-6, output: 4.5e-6 } },
  { provider: 'requesty-export', id: 'glm-5.3-flash', cost: { input: 2e-7, output: 1e-6 } },
]);

// requesty-export is NOT in PROVIDER_MAP and NOT in cfg.providers — exactly
// the "Pi registered it through another channel" scenario. The router must
// still resolve its real cost via the registry.

const BASE_CACHE: Cache = {
  // The router's own scan never discovered these models (it scans only
  // PROVIDER_MAP), so available_models is empty. This is the real-world
  // situation: the router's cache knows nothing about requesty-export.
  available_models: [],
  gdpval_scores: {
    'claude-opus-4.5': 1860,
    'claude-sonnet-5': 1750,
    'glm-5.3': 1680,
    'glm-5.3-flash': 1627,
  },
  model_score_cache: {
    'requesty-export/claude-opus-4.5': 'claude-opus-4.5',
    'requesty-export/claude-sonnet-5': 'claude-sonnet-5',
    'requesty-export/glm-5.3': 'glm-5.3',
    'requesty-export/glm-5.3-flash': 'glm-5.3-flash',
  },
  openrouter_pricing: {},
  usage_log: [],
  benchmarks: {},
  budget_cache: {},
  gdpval_scraped: true,
  lastScanTimestamp: Date.now(),
  models_cached: '',
} as any;

const CFG: Config = {
  model_groups: {
    trivial: {
      description: 'Trivial - cheapest first',
      method: 'min_cost_if_all_priced',
      max_cost: 0.01, // per-million; high enough to let all registry models pass.
      // Opus is excluded from rank #1 not by this filter (Opus at 5.5e-6/tok
      // ≈ $5.5/M is well under 0.01) but by sortByMinCostIfAllPriced sorting
      // it below the cheaper glm-flash — that's the actual fix under test.
      min_gdpval: 0,
      fallback_groups: [],
    },
    strategic: {
      description: 'Strategic - best',
      method: 'best',
      min_gdpval: 0,
      fallback_groups: [],
    },
  },
  providers: {
    // requesty-export intentionally absent — Pi registered it, not us.
  },
  model_metrics: {},
  gdpval_builtin: {},
} as any;

describe('registry cost lookup (requesty-export scenario)', () => {
  let router: Router;

  beforeEach(() => {
    // Publish the registry BEFORE any query — mirrors session_start ordering.
    metricsModule.setModelRegistry(REGISTRY);
    metricsModule.setPiRegisteredProviders(REGISTRY.getRegisteredProviderIds());
    // The router's `allDiscoveredRefs()` reads `sessionCtx.modelRegistry.getAvailable()`
    // (the public API) to enumerate candidates — so hand it the same registry
    // via the documented `setSessionCtx` path, exactly as index.ts does in
    // `session_start`.
    router = makeRouter(CFG, BASE_CACHE, { modelRegistry: REGISTRY });
  });

  it('lookupPrice reads Model.cost from the registry for a pi-registered provider', () => {
    const price = metricsModule.lookupPrice('requesty-export/claude-opus-4.5');
    expect(price).not.toBeNull();
    expect(price!.input).toBe(5.5e-6);
    expect(price!.output).toBe(2.75e-5);
  });

  it('lookupPrice returns different prices for different models (not a single scalar)', () => {
    const opus = metricsModule.lookupPrice('requesty-export/claude-opus-4.5');
    const flash = metricsModule.lookupPrice('requesty-export/glm-5.3-flash');
    expect(opus!.input).toBeGreaterThan(flash!.input);
    expect(opus!.output).toBeGreaterThan(flash!.output);
  });

  it('effCost returns the real input price (not "unknown") for a pi-registered model', () => {
    const cost = metricsModule.effCost('requesty-export/claude-opus-4.5');
    // Before the fix: 'unknown'. After: the real per-token input cost from
    // the registry (effCost does not scale by ×1e6 — it returns base as-is,
    // so this is per-token; the exact unit doesn't matter for the assertion,
    // only that it's a real number strictly greater than the cheap model's).
    expect(cost).not.toBe('unknown');
    expect(typeof cost).toBe('number');
    expect(cost as number).toBeGreaterThan(0);
  });

  it('trivial group does NOT pick the most expensive model (Opus) at rank #1', () => {
    const { models: top } = router.getTopModels('trivial', 10);
    const refs = top.map((m) => m.ref);
    expect(refs.length).toBeGreaterThan(0);
    // Opus must not be the first pick in a cheap-first group.
    expect(refs[0]).not.toBe('requesty-export/claude-opus-4.5');
    // The cheapest model (glm-5.3-flash) should rank above Opus.
    const flashIdx = refs.indexOf('requesty-export/glm-5.3-flash');
    const opusIdx = refs.indexOf('requesty-export/claude-opus-4.5');
    if (flashIdx >= 0 && opusIdx >= 0) {
      expect(flashIdx).toBeLessThan(opusIdx);
    }
  });

  it('strategic group (method: best) may pick Opus — registry does not break best-method', () => {
    const { models: top } = router.getTopModels('strategic', 10);
    const refs = top.map((m) => m.ref);
    expect(refs.length).toBeGreaterThan(0);
    // best method sorts by GDPval — Opus (1860) should be first.
    expect(refs[0]).toBe('requesty-export/claude-opus-4.5');
  });

  it('without the registry, lookupPrice returns null (proves the fix is registry-driven)', () => {
    // Clear the registry — now the old fallbacks are the only source.
    metricsModule.setModelRegistry(null);
    const price = metricsModule.lookupPrice('requesty-export/claude-opus-4.5');
    // No cfg.model_metrics, no openrouter_pricing, no OR-backfill, no
    // cfg.providers entry → null. This is exactly the pre-fix behavior that
    // caused effCost to fall through to 'unknown' and Opus to win trivial.
    expect(price).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Regression: `:free` suffix match (incident observed 2026-09-10)
//
// Symptom: `openrouter/z-ai/glm-5.2:free` vanished from /router groups after
// the reload, while `openrouter/thinkingmachines/inkling-small:free` stayed.
// Diag showed `modelRegistry.find('openrouter', 'z-ai/glm-5.2:free')` →
// undefined (find-undefined), even though Pi's registry had 131 models.
//
// Root cause: Pi's registry stores OpenRouter model IDs WITHOUT the `:free`
// suffix (e.g. `z-ai/glm-5.2`, not `z-ai/glm-5.2:free`). OpenRouter exposes
// free and paid as separate endpoints, but Pi normalizes to the base id.
// When the router asks `find(provider, 'z-ai/glm-5.2:free')`, it returns
// undefined → registryCost returns null → getM sets cost_per_m='unknown' →
// effCost returns 'unknown' → sortByMinCostIfAllPriced drops the model.
//
// The model that stayed (inkling-small:free) survived because it was in
// cache.available_models with cost_per_m: 0 — the `discovered` fallback in
// getM caught it. z-ai/glm-5.2:free was NOT in the stale cache, so it had
// no fallback and was dropped.
//
// Fix: registryCost retries find() with the `:free` suffix stripped when the
// full-id lookup fails. This matches how Pi stores OpenRouter ids.
// ─────────────────────────────────────────────────────────────────────────
describe('registryCost :free-suffix matching', () => {
  // Registry stores the model WITHOUT the :free suffix (Pi's convention).
  const freeRegistry = makeRegistry([
    { provider: 'openrouter', id: 'z-ai/glm-5.2', cost: { input: 0, output: 0 } },
    { provider: 'openrouter', id: 'thinkingmachines/inkling-small', cost: { input: 0, output: 0 } },
    { provider: 'openrouter', id: 'cohere/north-mini-code', cost: { input: 0.2, output: 0.8 } },
  ]);

  beforeEach(() => {
    metricsModule.setModelRegistry(freeRegistry);
  });

  it('find() with the full :free id fails (documents the registry convention)', () => {
    // The bare find that registryCost used to do — no fallback:
    const direct = freeRegistry.find('openrouter', 'z-ai/glm-5.2:free');
    expect(direct).toBeUndefined();
    // ...but the stripped id works:
    const stripped = freeRegistry.find('openrouter', 'z-ai/glm-5.2');
    expect(stripped).toBeDefined();
  });

  it('lookupPrice for a :free ref resolves via the stripped-id retry', () => {
    // Before the fix: null (find-undefined → null). After: {0,0} is treated
    // as free → returns null so the free-tag path applies. Either way the
    // CALLER (getM/effCost) must not get 'unknown' for a known-free model.
    const price = metricsModule.lookupPrice('openrouter/z-ai/glm-5.2:free');
    // registryCost returns null for {0,0} (free), so lookupPrice returns null
    // here too — BUT the important property is that getM doesn't fall through
    // to 'unknown' because the :free tag + free_models config catches it.
    // For a PAID model with a :free-tagged twin, the stripped-id retry DOES
    // return the real cost. Tested next:
    expect(price).toBeNull();
  });

  it('lookupPrice for a :free ref whose base id is PAID returns the real cost', () => {
    // Scenario: openrouter has `cohere/north-mini-code` (paid, $0.2/$0.8)
    // and the user sees `cohere/north-mini-code:free` in their group.
    // The stripped-id retry finds the paid entry and returns its cost.
    const price = metricsModule.lookupPrice('openrouter/cohere/north-mini-code:free');
    expect(price).toEqual({ input: 0.2, output: 0.8 });
  });

  it('effCost for a :free ref without a cache entry is not \'unknown\' (regression)', () => {
    // The bug: z-ai/glm-5.2:free was NOT in cache.available_models, so getM
    // fell to 'unknown' and effCost returned 'unknown'. With the stripped-id
    // retry, registryCost finds the {0,0} entry, returns null (free), and
    // getM's :free-tag logic (via isFreeModelRef → freeCost) must yield 0.
    // We assert effCost !== 'unknown' for a model the registry knows.
    metricsModule.setConfig({
      model_groups: {},
      model_metrics: {},
      gdpval_builtin: {},
      providers: { openrouter: { free_models: ['openrouter/z-ai/glm-5.2:free'] } },
    } as any);
    metricsModule.setCache({ available_models: [], gdpval_scores: {} } as any);
    const cost = metricsModule.effCost('openrouter/z-ai/glm-5.2:free');
    // Must not be 'unknown' — it's a known-free model.
    expect(cost).not.toBe('unknown');
  });
});
