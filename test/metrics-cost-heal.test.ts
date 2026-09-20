// test/metrics-cost-heal.test.ts
//
// Regression + feature tests for the cost_per_m resolution chain
// (registry-before-subscription) and placeholder healing in getM().
//
// Symptom (2026-09-20):
//   1. Mistral subscription models (Le Chat) with a real registry price
//      ($1.4) were read as "free": getM()'s old chain zeroed ALL
//      subscription providers BEFORE consulting the registry, so effCost()
//      returned 0 and $1.4 models passed every max_cost: 0 gate.
//   2. Entries written into the in-memory metrics map while the registry
//      was not yet published (session_start ordering) stayed 'unknown'
//      FOREVER — getM()'s early-return path only re-healed gdpval, never
//      cost_per_m (see setModelRegistry: it resets metrics = {} exactly
//      because stale entries were otherwise unfixable).
//
// Fix:
//   - resolveCostPerM(ref): authoritative chain, registry FIRST (via the
//     real registryCost() — pricingAlias + same-slug sibling aware):
//       1. registryCost  → real per-model price
//       2. local provider → 0
//       3. subscription provider without registry price → 0
//       4. cache-discovered 0 → 0
//       5. :free tag / free_models → 0
//       6. else → 'unknown'
//   - getM() early-return path: heals cost_per_m PLACEHOLDERS only
//     (0 and 'unknown'). A resolved non-zero value (user-configured or
//     registry-priced) is real and must never be overwritten — otherwise
//     an explicit model_metrics cost (e.g. zai-glm-5-3: 1.4) would be
//     clobbered back to the chain's subscription-zero, defeating
//     dedup-before-cost-gates (slug-canon-dedup "capped group" guard below).
//
// effCost interplay: a subscription-billed model priced 1.4 by the registry
// gets SUB_DISCOUNT (0.5) in effCost → 0.7: affordable in tiered groups,
// excluded from max_cost: 0 (genuine token-based free only).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getM,
  setConfig,
  setCache,
  setGdpval,
  setModelMap,
  setModelRegistry,
  effCost,
  lookupPrice,
} from '../src/metrics.ts';
import type { Config, Cache } from '../src/types.ts';

// A fake pi modelRegistry implementing the public methods the router uses.
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

beforeEach(() => {
  // setModelRegistry(null) resets BOTH the registry handle and the in-memory
  // metrics map ({}), giving every test a pristine getM() state.
  setModelRegistry(null);
  setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: {} } as any);
  setCache({} as any);
  setGdpval({});
  setModelMap({}, []);
});

describe('resolveCostPerM — registry price wins over blanket-zero', () => {
  it('subscription-billed model with registry price is NOT read as "free"', () => {
    setModelRegistry(makeRegistry([
      { provider: 'mistral', id: 'zai-glm-5-3', cost: { input: 1.4, output: 4.4 } },
    ]));
    // Real-world case: mistral is a subscription provider (Le Chat), but the
    // model has a real registry price. Old chain: subscription branch zeroed
    // it BEFORE the registry was asked → cost_per_m 0 → "free".
    setConfig({
      model_groups: {}, model_metrics: {}, gdpval_builtin: {},
      providers: { mistral: { billing: 'subscription' } },
    } as any);

    const ref = 'mistral/zai-glm-5-3';
    expect(getM(ref).cost_per_m).toBe(1.4);
  });

  it('effCost applies SUB_DISCOUNT (0.5) to a registry-priced subscription model → 0.7, not 0', () => {
    setModelRegistry(makeRegistry([
      { provider: 'mistral', id: 'zai-glm-5-3', cost: { input: 1.4, output: 4.4 } },
    ]));
    setConfig({
      model_groups: {}, model_metrics: {}, gdpval_builtin: {},
      providers: { mistral: { billing: 'subscription' } },
    } as any);

    // 1.4 × SUB_DISCOUNT(0.5) = 0.7 → excluded from max_cost: 0 groups,
    // mid-field in tiered groups — no longer "free".
    expect(effCost('mistral/zai-glm-5-3')).toBe(0.7);
  });

  it('subscription model WITHOUT registry price stays free', () => {
    // No registry at all: the subscription branch is the intended free path.
    setConfig({
      model_groups: {}, model_metrics: {}, gdpval_builtin: {},
      providers: { mistral: { billing: 'subscription' } },
    } as any);

    const ref = 'mistral/not-in-registry';
    expect(getM(ref).cost_per_m).toBe(0);
    expect(effCost(ref)).toBe(0);
  });

  it('local provider (ollama) stays free', () => {
    const ref = 'ollama/llama-3.2';
    expect(getM(ref).cost_per_m).toBe(0);
    expect(effCost(ref)).toBe(0);
  });

  it('registry {0,0} cost alone does NOT mark a payg model free (registryCost null-for-{0,0} contract)', () => {
    // registryCost() deliberately returns null for {0,0} registry costs —
    // "free" is ambiguous downstream, so the chain defers to the free/local/
    // subscription detection. A payg provider without any free-signal
    // therefore resolves 'unknown', exactly as before this change.
    setModelRegistry(makeRegistry([
      { provider: 'openrouter', id: 'some-model', cost: { input: 0, output: 0 } },
    ]));

    const ref = 'openrouter/some-model';
    expect(getM(ref).cost_per_m).toBe('unknown');
  });

  it('free model via cache-discovered 0 / :free tag stays free', () => {
    setCache({
      available_models: [
        { provider: 'openrouter', id: 'glm-5-2:free', cost_per_m: 0 },
      ],
    } as any);

    const ref = 'openrouter/glm-5-2:free';
    expect(getM(ref).cost_per_m).toBe(0);
    expect(effCost(ref)).toBe(0);
  });

  it('no signal at all → "unknown"', () => {
    const ref = 'unknown-provider/model';
    expect(getM(ref).cost_per_m).toBe('unknown');
    expect(effCost(ref)).toBe('unknown');
  });
});

describe('getM — placeholder healing on the early-return path', () => {
  it('stale "unknown" heals to the registry price once the registry is published', () => {
    // Phase 1: registry NOT yet published (early session ordering) → getM
    // writes 'unknown' into the in-memory metrics map.
    const ref = 'pi-claude/claude-sonnet-5';
    expect(getM(ref).cost_per_m).toBe('unknown');

    // Phase 2: registry becomes available (session_start) → the SAME cached
    // entry must heal to the real price on the next getM call.
    setModelRegistry(makeRegistry([
      { provider: 'pi-claude', id: 'claude-sonnet-5', cost: { input: 2, output: 10 } },
    ]));
    expect(getM(ref).cost_per_m).toBe(2);
    // pi-claude is not subscription-billed here → no SUB_DISCOUNT.
    expect(effCost(ref)).toBe(2);
  });

  it('stale scan placeholder 0 heals to the registry price', () => {
    setConfig({
      model_groups: {}, model_metrics: {}, gdpval_builtin: {},
      providers: { mistral: { billing: 'subscription' } },
    } as any);

    // Phase 1: no registry → subscription branch stores a 0 placeholder.
    const ref = 'mistral/placeholder-heal-x';
    expect(getM(ref).cost_per_m).toBe(0);

    // Phase 2: registry published with the real price → placeholder heals.
    setModelRegistry(makeRegistry([
      { provider: 'mistral', id: 'placeholder-heal-x', cost: { input: 1.4, output: 4.4 } },
    ]));
    expect(getM(ref).cost_per_m).toBe(1.4);
    expect(effCost(ref)).toBe(0.7); // 1.4 × SUB_DISCOUNT
  });

  it('resolved non-zero values are NEVER overwritten by healing (slug-canon "capped group" guard)', () => {
    // Regression guard for the healing-overwrite bug: an EXPLICIT
    // model_metrics price (here: the canonical cluster representative at
    // $1.4, subscription billing, no registry) must survive repeated getM
    // calls. The broken healing compared against the chain result and
    // clobbered 1.4 → 0, letting the model sneak through max_cost: 0.
    setConfig({
      model_groups: {}, gdpval_builtin: {},
      model_metrics: { 'mistral/zai-glm-5-3': { cost_per_m: 1.4 } },
      providers: { mistral: { billing: 'subscription' } },
    } as any);

    const ref = 'mistral/zai-glm-5-3';
    expect(getM(ref).cost_per_m).toBe(1.4);
    // Second call takes the early-return path — the value must stay 1.4.
    expect(getM(ref).cost_per_m).toBe(1.4);
    expect(effCost(ref)).toBe(0.7); // 1.4 × SUB_DISCOUNT
  });

  it('user config cost_per_m override (non-zero) is preserved across calls', () => {
    setConfig({
      model_groups: {}, gdpval_builtin: {},
      model_metrics: { 'custom/model': { cost_per_m: 0.5 } },
      providers: {},
    } as any);

    const ref = 'custom/model';
    expect(getM(ref).cost_per_m).toBe(0.5);
    expect(getM(ref).cost_per_m).toBe(0.5); // early-return path
    expect(effCost(ref)).toBe(0.5);
  });

  it('user config cost_per_m = 0 does not pin "free" — registry wins (0 means "unpriced")', () => {
    setModelRegistry(makeRegistry([
      { provider: 'custom', id: 'model', cost: { input: 1.2, output: 3.0 } },
    ]));
    setConfig({
      model_groups: {}, gdpval_builtin: {},
      model_metrics: { 'custom/model': { cost_per_m: 0 } },
      providers: {},
    } as any);

    // Matches the pre-existing config-default semantics: explicit 0 goes
    // through the chain, and the registry price wins. The :free tag /
    // free_models list remains the "force free" escape hatch.
    expect(getM('custom/model').cost_per_m).toBe(1.2);
    expect(effCost('custom/model')).toBe(1.2);
  });
});

describe('lookupPrice — registry-first (regression guard)', () => {
  it('uses registry cost when available', () => {
    setModelRegistry(makeRegistry([
      { provider: 'mistral', id: 'zai-glm-5-3', cost: { input: 1.4, output: 4.4 } },
    ]));
    expect(lookupPrice('mistral/zai-glm-5-3')).toEqual({ input: 1.4, output: 4.4 });
  });
});
