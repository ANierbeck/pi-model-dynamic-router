/**
 * Regression tests for docs/plan-route-unknown-registered-models.md
 *
 * Verifies that models from providers not present in PROVIDER_MAP become
 * routable once their provider is stub-registered into cfg.providers (the
 * fix applied to generateDynamicConfig in index.ts), and that the
 * stripProvider fix in src/metrics.ts (reading the module's own `cfg`
 * instead of a never-assigned `(global as any).cfg`) is what makes the
 * stub effective.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as metricsModule from '../src/metrics.js';
import { Router } from '../src/routing.js';
import type { Config, Cache } from '../src/types.js';

describe('metrics.lookupGdp provider stub (stripProvider fix)', () => {
  beforeEach(() => {
    metricsModule.setModelMap({}, []);
  });

  it('fails to resolve an explicit model-map override for an unstubbed unknown provider', () => {
    metricsModule.setConfig({ model_groups: {}, model_metrics: {}, providers: {} });
    metricsModule.setGdpval({ 'some-slug': 900 });
    // Explicit override keyed on the provider-stripped id, as model-map.yaml would contain
    metricsModule.setModelMap({ 'qwen/qwen3-4b:free': 'some-slug' }, []);

    expect(metricsModule.lookupGdp('claude-bridge/qwen/qwen3-4b:free')).toBeNull();
  });

  it('resolves the same explicit override once the provider is stub-registered', () => {
    metricsModule.setGdpval({ 'some-slug': 900 });
    metricsModule.setModelMap({ 'qwen/qwen3-4b:free': 'some-slug' }, []);
    metricsModule.setConfig({
      model_groups: {},
      model_metrics: {},
      providers: { 'claude-bridge': { billing: 'subscription' } },
    });

    expect(metricsModule.lookupGdp('claude-bridge/qwen/qwen3-4b:free')).toBe(900);
  });

  it('junk models with no derivable score stay null regardless of stub registration', () => {
    metricsModule.setGdpval({ 'claude-sonnet-5': 750 });
    metricsModule.setConfig({
      model_groups: {},
      model_metrics: {},
      providers: { 'claude-bridge': { billing: 'subscription' } },
    });

    expect(metricsModule.lookupGdp('claude-bridge/totally-unknown-xyz-999')).toBeNull();
  });
});

describe('Router.resolve picks up stub-registered unknown-provider models', () => {
  it('selects a registry-sourced model whose provider is stub-registered', () => {
    const cfg: Config = {
      model_groups: {
        tactical: {
          description: 'test group',
          method: 'best',
          models: ['claude-bridge/claude-sonnet-5', 'anthropic/claude-3-haiku'],
        },
      },
      model_metrics: {},
      providers: {
        anthropic: { billing: 'subscription' },
        // Stub added by generateDynamicConfig for a registry provider not in PROVIDER_MAP
        'claude-bridge': { billing: 'subscription' },
      },
      gdpval_builtin: {
        'claude-sonnet-5': 900,
        'claude-3-haiku': 350,
      },
    };
    const cache: Cache = {
      available_models: [
        { id: 'claude-sonnet-5', provider: 'claude-bridge', cost_per_m: 0 },
        { id: 'claude-3-haiku', provider: 'anthropic', cost_per_m: 0.3 },
      ],
    };

    metricsModule.setModelMap({}, []);
    metricsModule.setConfig(cfg);
    metricsModule.setCache(cache);

    const router = new Router(cfg, cache, new Map());
    const resolution = router.resolve('tactical');

    expect(resolution).not.toBeNull();
    expect(resolution!.candidates).toContain('claude-bridge/claude-sonnet-5');
    expect(resolution!.selected).toBe('claude-bridge/claude-sonnet-5');
  });

  it('never routes to a model absent from every group.models list, even if discovered', () => {
    const cfg: Config = {
      model_groups: {
        tactical: {
          description: 'test group',
          method: 'best',
          models: ['anthropic/claude-3-haiku'],
        },
      },
      model_metrics: {},
      providers: {
        anthropic: { billing: 'subscription' },
        'claude-bridge': { billing: 'subscription' },
      },
      gdpval_builtin: {
        'claude-sonnet-5': 900,
        'claude-3-haiku': 350,
      },
    };
    const cache: Cache = {
      available_models: [
        // Discovered but never added to any group's models (e.g. dropped by the
        // safety-gate filter for having no derivable GDPval, or simply not unioned in)
        { id: 'claude-sonnet-5', provider: 'claude-bridge', cost_per_m: 0 },
        { id: 'claude-3-haiku', provider: 'anthropic', cost_per_m: 0.3 },
      ],
    };

    metricsModule.setModelMap({}, []);
    metricsModule.setConfig(cfg);
    metricsModule.setCache(cache);

    const router = new Router(cfg, cache, new Map());
    const resolution = router.resolve('tactical');

    expect(resolution).not.toBeNull();
    expect(resolution!.candidates).not.toContain('claude-bridge/claude-sonnet-5');
  });
});
