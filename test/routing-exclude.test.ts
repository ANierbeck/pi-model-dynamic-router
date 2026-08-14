// test/routing-exclude.test.ts
// Regression guard for the "live /router table ignores exclude rules" bug.
//
// BACKGROUND: the /router TUI table is computed live by routing.ts's
// allDiscoveredRefs() + getTopModels(). generateDynamicConfig() (which
// writes the dynamic config file) applied exclude rules, but allDiscoveredRefs()
// did NOT — so the TUI showed paid OpenRouter models and Fable even though
// the dynamic config had correctly filtered them out.
//
// These tests pin allDiscoveredRefs() to honour cfg.exclude.

import { describe, it, expect, beforeEach } from 'vitest';
import { Router } from '../src/routing.js';
import * as metricsModule from '../src/metrics.js';
import type { Config, Cache } from '../src/types.js';

function makeRouter(cfg: Config, cache: Cache): Router {
  // Reset metrics module state for isolation.
  metricsModule.setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: {} });
  metricsModule.setCache({});
  metricsModule.setGdpval({});
  metricsModule.setModelMap({}, []);
  return new Router(cfg, cache, new Map());
}

const BASE_CACHE: Cache = {
  available_models: [
    { id: 'glm-5-2', provider: 'mistral', cost_per_m: 0 },
    { id: 'zai-glm-5-2', provider: 'mistral', cost_per_m: 0 },
    { id: 'anthropic/claude-opus-5', provider: 'openrouter', cost_per_m: 5 },
    { id: 'anthropic/claude-fable-5', provider: 'openrouter', cost_per_m: 10 },
    { id: 'qwen3-4b:free', provider: 'openrouter', cost_per_m: 0 },
    { id: 'gpt-4o-mini:free', provider: 'openrouter', cost_per_m: 0 },
    { id: 'gemma4:latest', provider: 'ollama', cost_per_m: 0 },
  ],
};

const BASE_CFG: Config = {
  model_groups: {
    strategic: { method: 'best', min_gdpval: 0 },
    scout: { method: 'tiered', min_gdpval: 0 },
  },
  model_metrics: {},
};

describe('Router.allDiscoveredRefs — exclude rules', () => {
  it('returns all refs when no exclude rules configured', () => {
    const router = makeRouter(BASE_CFG, BASE_CACHE);
    const refs = router.allDiscoveredRefs();
    expect(refs).toContain('mistral/glm-5-2');
    expect(refs).toContain('openrouter/anthropic/claude-opus-5');
    expect(refs).toContain('openrouter/anthropic/claude-fable-5');
    expect(refs).toContain('openrouter/qwen3-4b:free');
  });

  it('excludes all models from a listed provider (exclude.providers)', () => {
    const cfg: Config = {
      ...BASE_CFG,
      exclude: { providers: ['openrouter'] },
    };
    const router = makeRouter(cfg, BASE_CACHE);
    const refs = router.allDiscoveredRefs();
    // No openrouter/* refs remain.
    expect(refs.filter((r) => r.startsWith('openrouter/'))).toEqual([]);
    // But mistral and ollama survive.
    expect(refs).toContain('mistral/glm-5-2');
    expect(refs).toContain('ollama/gemma4:latest');
  });

  it('excludes models matching a glob pattern (exclude.models)', () => {
    const cfg: Config = {
      ...BASE_CFG,
      exclude: { models: ['*fable*'] },
    };
    const router = makeRouter(cfg, BASE_CACHE);
    const refs = router.allDiscoveredRefs();
    expect(refs).not.toContain('openrouter/anthropic/claude-fable-5');
    expect(refs).toContain('openrouter/anthropic/claude-opus-5');
    expect(refs).toContain('mistral/glm-5-2');
  });

  it('excludes paid OpenRouter models but keeps :free tier (paid_models_from)', () => {
    const cfg: Config = {
      ...BASE_CFG,
      providers: {
        openrouter: {
          billing: 'pay_per_token',
          free_models: ['openrouter/qwen3-4b:free', 'openrouter/gpt-4o-mini:free'],
        },
      },
      exclude: { paid_models_from: ['openrouter'] },
    };
    const router = makeRouter(cfg, BASE_CACHE);
    const refs = router.allDiscoveredRefs();
    // Paid OR models gone.
    expect(refs).not.toContain('openrouter/anthropic/claude-opus-5');
    expect(refs).not.toContain('openrouter/anthropic/claude-fable-5');
    // Free OR models kept.
    expect(refs).toContain('openrouter/qwen3-4b:free');
    expect(refs).toContain('openrouter/gpt-4o-mini:free');
    // Unrelated provider kept.
    expect(refs).toContain('mistral/glm-5-2');
  });

  it('combined rules: providers + models + paid_models_from together', () => {
    const cfg: Config = {
      ...BASE_CFG,
      providers: {
        openrouter: {
          billing: 'pay_per_token',
          free_models: ['openrouter/qwen3-4b:free'],
        },
      },
      exclude: {
        providers: [],
        models: ['*fable*'],
        paid_models_from: ['openrouter'],
      },
    };
    const router = makeRouter(cfg, BASE_CACHE);
    const refs = router.allDiscoveredRefs();
    expect(refs).not.toContain('openrouter/anthropic/claude-opus-5');
    expect(refs).not.toContain('openrouter/anthropic/claude-fable-5');
    expect(refs).toContain('openrouter/qwen3-4b:free');
    expect(refs).toContain('mistral/glm-5-2');
  });

  it('free_models from config are still discovered even with paid_models_from', () => {
    // free_models in router-config.json must remain available.
    const cfg: Config = {
      ...BASE_CFG,
      providers: {
        openrouter: {
          billing: 'pay_per_token',
          free_models: ['openrouter/meta-llama/llama-3.3-70b-instruct:free'],
        },
      },
      exclude: { paid_models_from: ['openrouter'] },
    };
    const router = makeRouter(cfg, BASE_CACHE);
    const refs = router.allDiscoveredRefs();
    expect(refs).toContain('openrouter/meta-llama/llama-3.3-70b-instruct:free');
  });
});
