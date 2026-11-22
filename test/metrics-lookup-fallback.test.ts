// N12 survivor round for src/metrics.ts. Pins the 21 mutants the nightly
// (run 45041910456, perTest attribution gap) left undetected in the
// free/placeholder decision:
//   L878 — :free terminal tag (Sourcery PR #74 — includes must NOT match)
//   L880-886 — free_models config match: full ref AND bare id slice
//   L901 — placeholder gate: discovered cost 0 without registry = free
//   L1107-1113 — OR-fallback short-circuit + discovery gate
//   L1218 — registryFailed init: registry answers a price → NOT free
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as m from '../src/metrics.ts';

vi.mock('../src/logger.ts', async (orig) => ({ ...(await orig()), errorLog: vi.fn() }));

describe('N12 mutation pins — isFreeModelRef gates', () => {
  beforeEach(() => {
    m.setConfig({ model_groups: {}, model_metrics: {}, providers: {} } as any);
    m.setModelRegistry(null);
  });
  it('pinned: :free tag is free without any lookup', () => {
    expect(m.isFreeModelRef('prov/m:free' as any, {}, [])).toBe(true);
  });
  it('pinned: :free-v2 tag is NOT free (terminal tag only)', () => {
    expect(m.isFreeModelRef('prov/m:free-v2' as any, {}, [])).toBe(false);
  });
  it('pinned: free_models bare-id slice matches full ref', () => {
    m.setConfig({
      model_groups: {},
      model_metrics: {},
      providers: { prov: { free_models: ['m'] } },
    } as any);
    expect(m.isFreeModelRef('prov/m' as any, { prov: { free_models: ['m'] } } as any, [])).toBe(
      true
    );
  });
  it('pinned: registry price beats placeholder-0 discovery', () => {
    m.setCache({ available_models: [{ provider: 'prov', id: 'm', cost_per_m: 0 }] } as any);
    m.setModelRegistry({ find: () => ({ cost: { input: 2, output: 8 } }) });
    expect(
      m.isFreeModelRef('prov/m' as any, {}, [{ provider: 'prov', id: 'm', cost_per_m: 0 }] as any)
    ).toBe(false);
  });
});

describe('N12 kill pins — L901 placeholder gate', () => {
  it('kills L901 mutants: slash===0 ref + registry price ⇒ placeholder stands (true)', () => {
    m.setConfig({ model_groups: {}, model_metrics: {}, providers: {} } as any);
    // Leading-slash ref ⇒ indexOf('/') === 0 ⇒ `slash <= 0` is true and the
    // gate returns true WITHOUT consulting the registry. All three surviving
    // L901 mutants (ConditionalExpression→false, ||→&&, <=→<) fall through
    // to the registry branch and would answer false instead.
    m.setModelRegistry({ find: () => ({ cost: { input: 3, output: 9 } }) } as any);
    expect(
      m.isFreeModelRef(
        '/scanprov-mistral-large',
        {} as any,
        [{ provider: '', id: 'scanprov-mistral-large', cost_per_m: 0 }] as any
      )
    ).toBe(true);
  });
});

const disc = (provider: string, id: string) => ({ provider, id, cost_per_m: 0 });
const ZERO = { input: 0, output: 0 };
const UNKNOWN = { input: 'unknown', output: 'unknown' };

describe('N12 kill pins — L1107-1113 fallback gates + L1218 flag', () => {
  beforeEach(() => {
    m.setConfig({ model_groups: {}, model_metrics: {}, providers: {} } as any);
    m.setCache({ available_models: [] } as any);
    m.setModelRegistry(null);
  });

  it('S1: registry fine but unpriced, OR-zero, discovered 0 → {0,0} passes (L1107 short-circuit)', () => {
    m.setCache({
      available_models: [disc('prov', 'm')],
      openrouter_pricing: { 'prov/m': ZERO },
    } as any);
    m.setModelRegistry({ find: () => undefined } as any);
    expect(m.lookupPrice('prov/m')).toEqual(ZERO);
  });

  it('S1b: registry fine, orFallbackPrice null → null (fallback?.input optional chaining)', () => {
    m.setModelRegistry({ find: () => undefined } as any);
    expect(m.lookupPrice('prov/m')).toBeNull();
  });

  it('S2: registry THROWS, OR-zero, discovered 0, NOT free → unknown (L1108/1109 gate)', () => {
    m.setCache({
      available_models: [disc('prov', 'm')],
      openrouter_pricing: { 'prov/m': ZERO },
    } as any);
    m.setModelRegistry({
      find: () => {
        throw new Error('registry down');
      },
    } as any);
    expect(m.lookupPrice('prov/m')).toEqual(UNKNOWN);
  });

  it('S3: registry THROWS, OR-zero blessed by free_models → {0,0} (L1109 ||→&& + CE)', () => {
    m.setConfig({
      model_groups: {},
      model_metrics: {},
      providers: { prov: { free_models: ['prov/m'] } },
    } as any);
    m.setCache({
      available_models: [disc('prov', 'm')],
      openrouter_pricing: { 'prov/m': ZERO },
    } as any);
    m.setModelRegistry({
      find: () => {
        throw new Error('registry down');
      },
    } as any);
    expect(m.lookupPrice('prov/m')).toEqual(ZERO);
  });

  it('S4: same as S1 via lookupListPrice → {0,0} (L1218 registryFailed init)', () => {
    m.setCache({
      available_models: [disc('prov', 'm')],
      openrouter_pricing: { 'prov/m': ZERO },
    } as any);
    m.setModelRegistry({ find: () => undefined } as any);
    expect(m.lookupListPrice('prov/m')).toEqual(ZERO);
  });
});

describe('N12 kill pins — L1107 operand mutants (deep paths)', () => {
  beforeEach(() => {
    m.setConfig({ model_groups: {}, model_metrics: {}, providers: {} } as any);
    m.setCache({ available_models: [] } as any);
    m.setModelRegistry(null);
  });

  it('S5: registry THROWS + fallback null → L1107 first operand must short-circuit (585)', () => {
    m.setModelRegistry({
      find: () => {
        throw new Error('registry down');
      },
    } as any);
    expect(m.lookupPrice('prov/m')).toBeNull();
  });

  it('S6: find-callback must not return first entry blindly (591) → {position matters}', () => {
    m.setCache({
      available_models: [{ provider: 'other', id: 'x', cost_per_m: 5 }, disc('prov', 'm')],
      openrouter_pricing: { 'prov/m': ZERO },
    } as any);
    m.setModelRegistry({
      find: () => {
        throw new Error('registry down');
      },
    } as any);
    expect(m.lookupPrice('prov/m')).toEqual(UNKNOWN);
  });

  it('S7: cfg.providers undefined + reached L1112 → unknown, no crash (605)', () => {
    m.setConfig({ model_groups: {}, model_metrics: {} } as any);
    m.setCache({
      available_models: [disc('prov', 'm')],
      openrouter_pricing: { 'prov/m': ZERO },
    } as any);
    m.setModelRegistry({
      find: () => {
        throw new Error('registry down');
      },
    } as any);
    expect(m.lookupPrice('prov/m')).toEqual(UNKNOWN);
  });
});

describe('N12 kill pins — cluster 3: OR-zero evidence and isFreeByDefinition', () => {
  beforeEach(() => {
    m.setConfig({ model_groups: {}, model_metrics: {}, providers: {} } as any);
    m.setCache({ available_models: [] } as any);
    m.setModelRegistry({
      find: () => {
        throw new Error('registry down');
      },
    } as any);
  });

  it('an OR price with a non-zero output is a price, not a placeholder (586)', () => {
    m.setCache({
      available_models: [disc('prov', 'm')],
      openrouter_pricing: { 'prov/m': { input: 0, output: 5 } },
    } as any);
    expect(m.lookupPrice('prov/m')).toEqual({ input: 0, output: 5 });
  });

  it('a :free ref is free by its own definition, so its zero stands (616, 618)', () => {
    m.setCache({
      available_models: [disc('prov', 'm:free')],
      openrouter_pricing: { 'prov/m:free': ZERO },
    } as any);
    expect(m.lookupPrice('prov/m:free')).toEqual(ZERO);
  });

  it('a local provider ref is free by its own definition (614)', () => {
    m.setCache({
      available_models: [disc('ollama', 'm')],
      openrouter_pricing: { 'ollama/m': ZERO },
    } as any);
    expect(m.lookupPrice('ollama/m')).toEqual(ZERO);
  });

  it('a bare free_models id frees the ref it belongs to (626, 627, 628)', () => {
    m.setConfig({
      model_groups: {},
      model_metrics: {},
      providers: { prov: { free_models: ['m'] } },
    } as any);
    m.setCache({
      available_models: [disc('prov', 'm')],
      openrouter_pricing: { 'prov/m': ZERO },
    } as any);
    expect(m.lookupPrice('prov/m')).toEqual(ZERO);
  });
});
