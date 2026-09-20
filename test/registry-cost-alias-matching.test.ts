// test/registry-cost-alias-matching.test.ts
//
// Regression test for the "bulk_reader/code_writer always pick a paid Mistral
// model despite max_cost: 0" investigation (2026-09-20).
//
// Symptom: `/router` showed `mistral/glm-5-2` (a real, non-free model) at
// rank #1 in max_cost:0 groups, ahead of genuinely free models that also
// cleared the min_context_length gate.
//
// Root cause (verified against the live Mistral API and Pi's own model
// catalog):
//   1. Mistral's own /v1/models response reports the canonical id "glm-5-2"
//      (with "zai-glm-5-2" listed only as an `aliases` entry).
//   2. Pi's model catalog (refreshed by `pi update --models`,
//      ~/.pi/agent/models-store.json) indexes the SAME model under the id
//      "zai-glm-5-2" instead — the opposite canonicalization.
//   3. registryCost() did an exact `modelRegistry.find(provider, modelId)`
//      with only a `:free`-suffix retry — no alias awareness — so
//      `find('mistral', 'glm-5-2')` returned undefined even though the
//      registry has the real price under 'zai-glm-5-2'.
//   4. The router's own scan (index.ts) writes `cost_per_m: 0` as a
//      PLACEHOLDER for every "generic direct API provider" model (mistral,
//      mistral-zai, ...) since their /v1/models responses carry no pricing
//      (ADR-0006 "F3"). With registryCost() failing to find the real price,
//      getM()/effCost() fell through to treating the placeholder 0 as
//      "free", so a real $1.4/$4.4 model passed every max_cost: 0 gate.
//
// Fix: registryCost() now also retries under any model-map.yaml sibling id
// that maps to the same GDPval slug (aliasesFor()) — e.g. "glm-5-2" and
// "zai-glm-5-2" both map to slug "glm-5-2" in model-map.yaml, so a failed
// lookup for one retries the other.

import { describe, it, expect, beforeEach } from 'vitest';
import * as metricsModule from '../src/metrics.ts';
import type { Cache } from '../src/types.ts';

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

// Mirrors the real-world split: our scan/model-map treats "glm-5-2" as
// canonical, Pi's registry only knows the model under the alias "zai-glm-5-2".
const ALIAS_REGISTRY = makeRegistry([
  { provider: 'mistral', id: 'zai-glm-5-2', cost: { input: 1.4, output: 4.4 } },
]);

const BASE_CACHE: Cache = {
  available_models: [
    // The scan's placeholder — every generic-provider model gets cost_per_m: 0
    // regardless of real price (ADR-0006 F3).
    { id: 'glm-5-2', provider: 'mistral', cost_per_m: 0 },
  ],
  gdpval_scores: {},
  openrouter_pricing: {},
  usage_log: [],
  benchmarks: {},
  budget_cache: {},
  gdpval_scraped: true,
  lastScanTimestamp: Date.now(),
  models_cached: '',
} as any;

describe('registryCost alias matching (Mistral glm-5-2 / zai-glm-5-2 scenario)', () => {
  beforeEach(() => {
    metricsModule.setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: {}, providers: {} } as any);
    metricsModule.setCache(BASE_CACHE);
    metricsModule.setGdpval({});
    metricsModule.setModelRegistry(ALIAS_REGISTRY);
    metricsModule.setPiRegisteredProviders(ALIAS_REGISTRY.getRegisteredProviderIds());
  });

  it('direct find() for the canonical id fails (documents the registry mismatch)', () => {
    expect(ALIAS_REGISTRY.find('mistral', 'glm-5-2')).toBeUndefined();
    expect(ALIAS_REGISTRY.find('mistral', 'zai-glm-5-2')).toBeDefined();
  });

  it('lookupPrice resolves the real price via the model-map.yaml alias', () => {
    metricsModule.setModelMap({ 'glm-5-2': 'glm-5-2', 'zai-glm-5-2': 'glm-5-2' }, []);
    const price = metricsModule.lookupPrice('mistral/glm-5-2');
    expect(price).toEqual({ input: 1.4, output: 4.4 });
  });

  it('without the alias in model-map.yaml, the real price is NOT found (proves the fix is map-driven)', () => {
    metricsModule.setModelMap({}, []);
    const price = metricsModule.lookupPrice('mistral/glm-5-2');
    // No registry hit, no config metrics, no pricing cache, no provider
    // estimate — falls through to null, same as pre-fix behavior.
    expect(price).toBeNull();
  });

  it('effCost returns the real cost, not the scan placeholder 0 (the actual bug)', () => {
    metricsModule.setModelMap({ 'glm-5-2': 'glm-5-2', 'zai-glm-5-2': 'glm-5-2' }, []);
    const cost = metricsModule.effCost('mistral/glm-5-2');
    // Before the fix: 0 (scan placeholder mistaken for "free"), which let a
    // $1.4/$4.4 model pass every max_cost: 0 gate. After: the real price.
    expect(cost).not.toBe(0);
    expect(cost).toBe(1.4);
  });

  it('a genuinely free registry model (0/0 cost) is still treated as free via the alias', () => {
    const freeRegistry = makeRegistry([
      { provider: 'mistral', id: 'zai-free-twin', cost: { input: 0, output: 0 } },
    ]);
    metricsModule.setModelRegistry(freeRegistry);
    metricsModule.setPiRegisteredProviders(freeRegistry.getRegisteredProviderIds());
    metricsModule.setModelMap({ 'free-twin': 'free-twin', 'zai-free-twin': 'free-twin' }, []);
    // registryCost() finds the {0,0} entry via the alias, and per its own
    // "input===0 && output===0 → return null" rule, does NOT report it as a
    // priced model — the caller's free/placeholder detection still applies.
    const price = metricsModule.lookupPrice('mistral/free-twin');
    expect(price).toBeNull();
  });

  it('aliasesFor a model-map entry with no siblings does not break resolution', () => {
    metricsModule.setModelMap({ 'solo-model': 'solo-model' }, []);
    // No registry entry at all for this id, and no siblings to retry — must
    // resolve to null cleanly, not throw.
    expect(() => metricsModule.lookupPrice('mistral/solo-model')).not.toThrow();
    expect(metricsModule.lookupPrice('mistral/solo-model')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Regression: `mistral-zai` provider pricing alias (2026-09-20)
//
// Symptom: after the modelId-alias fix above, `code_writer` correctly
// dropped the paid `mistral/glm-5-2` for a free model — but `bulk_reader`
// still ranked `mistral-zai/glm-5-2` (paid) at #1. Different bug, same
// class: Pi's own model catalog (~/.pi/agent/models-store.json) has NO
// `mistral-zai` entry at all — only `mistral` and `openrouter` — because
// `mistral-zai` is a router-internal key (separate API key, same account)
// that Pi never independently registers. No amount of modelId-alias
// retrying can find data that was never fetched under that provider name.
//
// Fix: ProviderDef gained `pricingAlias` (set to 'mistral' on the
// 'mistral-zai' PROVIDER_MAP entry); registryCost() retries under the
// pricing-alias provider when the direct provider lookup (including its own
// modelId-alias retries) finds nothing.
// ─────────────────────────────────────────────────────────────────────────
describe('registryCost pricingAlias (mistral-zai -> mistral scenario)', () => {
  // Registry only knows the model under the PRIMARY provider key ('mistral')
  // — mirrors Pi's real catalog, which has no 'mistral-zai' entries at all.
  const primaryOnlyRegistry = makeRegistry([
    { provider: 'mistral', id: 'zai-glm-5-2', cost: { input: 1.4, output: 4.4 } },
  ]);

  beforeEach(() => {
    metricsModule.setModelRegistry(primaryOnlyRegistry);
    metricsModule.setPiRegisteredProviders(primaryOnlyRegistry.getRegisteredProviderIds());
    metricsModule.setModelMap({ 'glm-5-2': 'glm-5-2', 'zai-glm-5-2': 'glm-5-2' }, []);
  });

  it('direct find() under the alias provider name fails (documents the gap)', () => {
    expect(primaryOnlyRegistry.find('mistral-zai', 'glm-5-2')).toBeUndefined();
    expect(primaryOnlyRegistry.find('mistral-zai', 'zai-glm-5-2')).toBeUndefined();
  });

  it('lookupPrice for the mistral-zai ref resolves via the pricingAlias + modelId-alias retry', () => {
    const price = metricsModule.lookupPrice('mistral-zai/glm-5-2');
    expect(price).toEqual({ input: 1.4, output: 4.4 });
  });

  it('effCost for the mistral-zai ref returns the real cost, not the scan placeholder 0', () => {
    const cost = metricsModule.effCost('mistral-zai/glm-5-2');
    expect(cost).not.toBe(0);
    expect(cost).toBe(1.4);
  });

  it('a provider without a pricingAlias is unaffected (no cross-provider leakage)', () => {
    // 'mistral' itself has no pricingAlias — it must NOT retry under some
    // other provider and must resolve directly, same as before this fix.
    const price = metricsModule.lookupPrice('mistral/zai-glm-5-2');
    expect(price).toEqual({ input: 1.4, output: 4.4 });
  });
});
