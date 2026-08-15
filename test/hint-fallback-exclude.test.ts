// test/hint-fallback-exclude.test.ts
// Regression guard: HINT fallback candidates must respect exclude rules.
//
// BACKGROUND: when a HINT names a model, the router appends extra fallback
// candidates taken straight from Pi's model registry, sorted by GDPval
// descending. That registry is NOT pre-filtered, so an excluded top-tier
// model landed in slot 1 of every HINT fallback — burning exactly the budget
// the exclude rule existed to protect.
//
// Note on why this went unnoticed: only models claude-bridge actually
// registers reach this path. Excluding a model that was never registered
// (e.g. *fable*) appeared to work, while excluding a registered one
// (*opus*) silently did nothing.

import { describe, it, expect } from 'vitest';
import { isExcluded, type ExcludeContext } from '../src/exclude.ts';
import type { Config, Cache } from '../src/types.ts';

const CFG: Config = {
  model_groups: {},
  providers: { openrouter: { billing: 'pay_per_token' } },
  exclude: {
    paid_models_from: ['openrouter'],
    models: ['*fable*', '*opus*'],
  },
} as any;

const CACHE: Cache = { available_models: [] } as any;

/**
 * Mirrors the filtering the HINT fallback pool applies to Pi's registry.
 */
function buildFallbackPool(registryRefs: string[], cfg: Config, cache: Cache): string[] {
  const exCtx: ExcludeContext | null = cfg.exclude ? { rules: cfg.exclude, cfg, cache } : null;
  return registryRefs.filter((ref) => !exCtx || !isExcluded(ref, exCtx));
}

describe('HINT fallback pool honours exclude rules', () => {
  // What claude-bridge actually registers: opus and sonnet, no fable.
  const registry = [
    'claude-bridge/claude-opus-5',
    'claude-bridge/claude-sonnet-5',
    'mistral/mistral-medium-2604',
    'mistral-zai/zai-glm-5-2',
  ];

  it('drops the excluded opus model', () => {
    expect(buildFallbackPool(registry, CFG, CACHE)).not.toContain('claude-bridge/claude-opus-5');
  });

  it('keeps non-excluded models', () => {
    const pool = buildFallbackPool(registry, CFG, CACHE);
    expect(pool).toContain('claude-bridge/claude-sonnet-5');
    expect(pool).toContain('mistral/mistral-medium-2604');
    expect(pool).toContain('mistral-zai/zai-glm-5-2');
  });

  it('would also drop fable if it were registered', () => {
    const withFable = [...registry, 'claude-bridge/claude-fable-5'];
    expect(buildFallbackPool(withFable, CFG, CACHE)).not.toContain('claude-bridge/claude-fable-5');
  });

  it('excluding the highest-GDPval model does not empty the pool', () => {
    // The pool is sorted by GDPval descending; removing the top entry must
    // still leave working fallbacks rather than falling through to nothing.
    expect(buildFallbackPool(registry, CFG, CACHE).length).toBeGreaterThan(0);
  });

  it('passes everything through when no exclude rules are configured', () => {
    const noExclude = { ...CFG, exclude: undefined } as Config;
    expect(buildFallbackPool(registry, noExclude, CACHE)).toEqual(registry);
  });
});
