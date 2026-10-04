// Cost display vs. routing cost for subscription models (owner request
// 2026-10-04): the /router group table showed claude-bridge/claude-sonnet-5-5
// with real PAYG list prices ($2/$10 via the OpenRouter backfill) while
// claude-bridge/claude-opus-5-5 showed "$0.0/$0.0" — its model_metrics
// sentinel (cost_per_m 1.5e-06, set 2026-09-27 so opus-5-5 is not silently
// excluded from max_cost groups as unknown-cost) shadows the backfill in
// lookupPrice.
//
// The fix splits the two concerns:
// - ROUTING cost (effCost / lookupPrice / classifier-fallback probe) keeps
//   the subscription sunk-cost sentinel — bridge models must stay
//   near-free for sorting and max_cost admission (owner decision).
// - DISPLAY cost prefers the PAYG would-cost list price (same philosophy
//   as the /router cost report's Marginal column) and falls back to the
//   effective price when no list price exists.
//
// Pinned here red-first: lookupListPrice did not exist; the display column
// came straight from lookupPrice.

import { afterEach, describe, expect, it } from 'vitest';
import { setConfig, setCache, lookupPrice, lookupListPrice } from '../src/metrics.ts';
import { costColumnFor } from '../src/commands.ts';
import type { Config, Cache } from '../src/types.ts';

const SENTINEL = 0.0000015;

const config: Config = {
  model_groups: {},
  model_metrics: {
    // Exactly the shipped router-config.json situation: opus-5-5 has the
    // subscription sentinel, sonnet-5-5 has NO entry (so lookupPrice falls
    // through to the OR backfill and shows real prices today).
    'claude-bridge/claude-opus-5-5': { cost_per_m: SENTINEL },
  },
};

const cache: Partial<Cache> = {
  openrouter_pricing: {
    // Same shape the real scan cache has (dot-notation Anthropic slugs;
    // norm() makes "claude-opus-5-5" and "claude-opus-5.5" equal).
    'anthropic/claude-opus-5.5': { input: 4, output: 20 },
    'anthropic/claude-sonnet-5.5': { input: 2, output: 10 },
  },
};

function resetMetrics() {
  setConfig(config);
  setCache(cache as Cache);
}

afterEach(() => {
  setConfig({ model_groups: {}, model_metrics: {} });
  setCache({} as Cache);
});

describe('list price (display) vs effective cost (routing)', () => {
  it('lookupListPrice finds the OR backfill price the sentinel shadows', () => {
    resetMetrics();
    expect(lookupListPrice('claude-bridge/claude-opus-5-5')).toEqual({ input: 4, output: 20 });
  });

  it('lookupListPrice works for models without a sentinel too (sonnet-5-5)', () => {
    resetMetrics();
    expect(lookupListPrice('claude-bridge/claude-sonnet-5-5')).toEqual({ input: 2, output: 10 });
  });

  it('lookupListPrice returns null when nothing prices the model', () => {
    resetMetrics();
    expect(lookupListPrice('claude-bridge/claude-fable-unknown')).toBeNull();
  });

  it('lookupPrice (routing) KEEPS the sentinel despite the OR backfill', () => {
    resetMetrics();
    // The subscription sunk-cost semantics must not change: the sentinel is
    // what keeps opus-5-5 admitted to max_cost groups and sorts it as
    // near-free (owner decision 2026-09-27).
    expect(lookupPrice('claude-bridge/claude-opus-5-5')).toEqual({ input: SENTINEL, output: SENTINEL });
  });

  it('the status table cost column shows the list price for the sentinel model', () => {
    resetMetrics();
    const tools = {
      lookupListPrice: (ref: string) => lookupListPrice(ref),
      lookupPrice: (ref: string) => lookupPrice(ref),
      effCost: (ref: string) => (lookupPrice(ref) ? SENTINEL : 'unknown'),
    };
    // Before the fix this rendered "$0.0/$0.0" — the sentinel rounded away.
    expect(costColumnFor('claude-bridge/claude-opus-5-5', tools)).toBe('$4.0/$20.0');
    expect(costColumnFor('claude-bridge/claude-sonnet-5-5', tools)).toBe('$2.0/$10.0');
  });

  it('the cost column falls back to the effective price when no list price exists', () => {
    resetMetrics();
    const tools = {
      lookupListPrice: () => null,
      lookupPrice: (ref: string) => lookupPrice(ref),
      effCost: () => SENTINEL,
    };
    // A subscription model WITHOUT a list price keeps the old display: the
    // sentinel itself, rendered as the $0.0/$0.0 pair (exactly what the
    // owner saw in the table before this fix).
    expect(costColumnFor('claude-bridge/claude-opus-5-5', tools)).toBe('$0.0/$0.0');
  });
});
