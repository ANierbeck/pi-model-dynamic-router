// test/dynamic-config-prune.test.ts
// Auto-prune of dynamic merge keys (ADR-0025 Phase B review follow-up I1).
//
// The merge keys (providers, model_metrics, gdpval_builtin) are merged per
// entry so scan-added entries survive regeneration — which also meant an
// entry a static layer (shipped / user / project) REMOVED later lingered in
// router-config.dynamic.json forever: after ADR-0025 B1/B2 the old
// model_metrics sentinels and providers.openrouter.free_models kept steering
// every upgraded install.
//
// Mechanism under test: every resync records what the static layers
// contributed under `_dynamic.static_contributions` (merge key → entry →
// field names, or null for a scalar entry). The next resync prunes what is
// REMEMBERED but no longer in the current static set; what was never in the
// remembered set (scan-added / learned) stays; a missing or corrupt
// remembered set prunes nothing (unknown provenance → keep). The one
// exception is providers.*.free_models, a pure-config field the scan never
// writes: it is taken from the static layers authoritatively, so even a
// dynamic file that predates the remembered set heals.

import { describe, it, expect } from 'vitest';
import { resyncDynamicFromStatic } from '../src/dynamic-config.ts';
import type { Config } from '../src/types.ts';

const cfgOf = (o: unknown) => o as Config;
const contributions = (dyn: Config) =>
  (dyn as unknown as { _dynamic: { static_contributions?: unknown } })._dynamic.static_contributions;

const SENTINEL = 'claude-bridge/claude-sonnet-5-5';
const LEARNED = 'claude-bridge/claude-opus-5-5';

describe('resyncDynamicFromStatic prunes entries the static layers dropped', () => {
  it('(a) removes a remembered model_metrics sentinel and free_models list the current static layers no longer declare', () => {
    const dyn = cfgOf({
      _dynamic: {
        static_contributions: {
          providers: { openrouter: ['billing', 'free_models'] },
          model_metrics: { [SENTINEL]: ['cost_per_m'] },
        },
      },
      model_groups: {},
      providers: { openrouter: { billing: 'pay_per_token', free_models: ['openrouter/old:free'] } },
      model_metrics: { [SENTINEL]: { cost_per_m: 5e-7 } },
    });
    const staticCfg = cfgOf({
      model_groups: {},
      providers: { openrouter: { billing: 'pay_per_token' } },
      model_metrics: {},
    });
    resyncDynamicFromStatic(dyn, staticCfg);
    expect(dyn.providers!.openrouter).toEqual({ billing: 'pay_per_token' });
    expect(dyn.model_metrics).toEqual({});
  });

  it('(b) keeps a scan-added / learned model_metrics entry that was never in a static layer', () => {
    const dyn = cfgOf({
      _dynamic: { static_contributions: { model_metrics: { [SENTINEL]: ['cost_per_m'] } } },
      model_groups: {},
      providers: { 'claude-bridge': { billing: 'subscription' } },
      model_metrics: {
        [SENTINEL]: { cost_per_m: 5e-7 },
        [LEARNED]: { throughput_tps: 42 },
      },
    });
    const staticCfg = cfgOf({ model_groups: {}, providers: {}, model_metrics: {} });
    resyncDynamicFromStatic(dyn, staticCfg);
    expect(dyn.model_metrics).toEqual({ [LEARNED]: { throughput_tps: 42 } });
    // Scan-registered provider stub: never in the remembered set → stays.
    expect(dyn.providers!['claude-bridge']).toEqual({ billing: 'subscription' });
  });

  it('(c) self-heals a user-layer removal across two regenerations', () => {
    const withUser = cfgOf({
      model_groups: {},
      providers: { openrouter: { billing: 'pay_per_token', free_models: ['openrouter/mine:free'] } },
      model_metrics: { 'user/pinned': { cost_per_m: 0 } },
      gdpval_builtin: { 'user-slug': 1000 },
    });
    const withoutUser = cfgOf({
      model_groups: {},
      providers: { openrouter: { billing: 'pay_per_token' } },
      model_metrics: {},
      gdpval_builtin: {},
    });
    const dyn = cfgOf({
      _dynamic: { generated_at: 'x' },
      model_groups: {},
      providers: { 'scan-stub': { billing: 'subscription' } },
      model_metrics: { [LEARNED]: { throughput_tps: 7 } },
    });

    // 1st generation: the user layer declares the entries → they land and are remembered.
    resyncDynamicFromStatic(dyn, withUser);
    expect(dyn.model_metrics['user/pinned']).toEqual({ cost_per_m: 0 });
    expect(dyn.providers!.openrouter.free_models).toEqual(['openrouter/mine:free']);
    expect(dyn.gdpval_builtin).toEqual({ 'user-slug': 1000 });

    // The user removes them; the next generation drops exactly those.
    resyncDynamicFromStatic(dyn, withoutUser);
    expect(dyn.model_metrics).toEqual({ [LEARNED]: { throughput_tps: 7 } });
    expect(dyn.providers!.openrouter).toEqual({ billing: 'pay_per_token' });
    expect(dyn.providers!['scan-stub']).toEqual({ billing: 'subscription' });
    expect(dyn.gdpval_builtin).toEqual({});
  });

  it('prunes field-wise: a removed static field leaves a scan-added field of the same entry alone', () => {
    const dyn = cfgOf({
      _dynamic: { static_contributions: { providers: { 'claude-bridge': ['cost_per_m'] } } },
      model_groups: {},
      providers: { 'claude-bridge': { billing: 'subscription', cost_per_m: 0.000001 } },
      model_metrics: {},
    });
    resyncDynamicFromStatic(dyn, cfgOf({ model_groups: {}, providers: {}, model_metrics: {} }));
    expect(dyn.providers!['claude-bridge']).toEqual({ billing: 'subscription' });
  });

  it('records the current static contribution for the next generation', () => {
    const dyn = cfgOf({ _dynamic: { generated_at: 'x' }, model_groups: {}, providers: {}, model_metrics: {} });
    resyncDynamicFromStatic(
      dyn,
      cfgOf({
        model_groups: {},
        providers: { openrouter: { billing: 'pay_per_token' } },
        model_metrics: { 'a/b': { cost_per_m: 1 } },
        gdpval_builtin: { slug: 900 },
      }),
    );
    expect(contributions(dyn)).toEqual({
      providers: { openrouter: ['billing'] },
      model_metrics: { 'a/b': ['cost_per_m'] },
      gdpval_builtin: { slug: null },
    });
  });
});

describe('resyncDynamicFromStatic prune is fail-open', () => {
  const staticCfg = cfgOf({ model_groups: {}, providers: {}, model_metrics: {} });
  const legacyDynamic = (extra: Record<string, unknown> = {}) =>
    cfgOf({
      _dynamic: { generated_at: 'x', ...extra },
      model_groups: {},
      providers: { openrouter: { billing: 'pay_per_token', free_models: ['openrouter/old:free'] } },
      model_metrics: { [SENTINEL]: { cost_per_m: 5e-7 } },
    });

  it('a dynamic file without a remembered set prunes no model_metrics entry (unknown provenance)', () => {
    const dyn = legacyDynamic();
    resyncDynamicFromStatic(dyn, staticCfg);
    expect(dyn.model_metrics[SENTINEL]).toEqual({ cost_per_m: 5e-7 });
    expect(dyn.providers!.openrouter.billing).toBe('pay_per_token');
  });

  it('providers.*.free_models is authoritative from the static layers even without a remembered set', () => {
    const dyn = legacyDynamic();
    resyncDynamicFromStatic(dyn, staticCfg);
    expect(dyn.providers!.openrouter.free_models).toBeUndefined();
  });

  it.each([
    ['a non-object', 'garbage'],
    ['an array', ['model_metrics']],
    ['a section of the wrong shape', { model_metrics: ['x'] }],
    ['an entry with a non-array field list', { model_metrics: { [SENTINEL]: 'cost_per_m' } }],
  ])('a corrupt remembered set (%s) prunes nothing and is replaced by the current one', (_label, corrupt) => {
    const dyn = legacyDynamic({ static_contributions: corrupt });
    resyncDynamicFromStatic(dyn, staticCfg);
    expect(dyn.model_metrics[SENTINEL]).toEqual({ cost_per_m: 5e-7 });
    expect(contributions(dyn)).toEqual({ providers: {}, model_metrics: {}, gdpval_builtin: {} });
  });
});
