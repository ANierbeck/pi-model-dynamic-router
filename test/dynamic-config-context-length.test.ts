// test/dynamic-config-context-length.test.ts
//
// Regression test for the code-review finding (2026-09-20): the persist
// path (generateDynamicConfig → filterModelsForGroup in src/dynamic-config.ts)
// did NOT apply the new `min_context_length` filter — only the live path
// (applyGroupFilters) and the /router display path did. The plan claimed
// "identical semantics across all three callers" but the persist path was
// missed.
//
// This test closes that gap: it verifies that
//   1. buildModelsWithMetadata now enriches each model with its scanned
//      contextWindow (via lookupContextWindow, reading the same primed cache
//      the live path reads);
//   2. filterModelsForGroup applies min_context_length with the same strict
//      null-fails semantics as the live path (unknown context window fails
//      the gate; absent/0 means no-op).
//
// Together with test/routing-context-length.test.ts (live path) this gives
// the "all three callers apply the filter" guarantee the plan asserted.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildModelsWithMetadata, filterModelsForGroup } from '../src/dynamic-config.js';
import * as metricsModule from '../src/metrics.js';
import type { Cache, Group, Config } from '../src/types.js';

// Prime the metrics module's cache so lookupContextWindow(ref) resolves from
// cache.available_models[].capabilities.contextWindow — exactly the path
// buildModelsWithMetadata now exercises (via lookupContextWindow).
const CACHE: Cache = {
  available_models: [
    { id: 'small-ctx', provider: 'mistral', cost_per_m: 0, capabilities: { contextWindow: 8_000 } },
    { id: 'big-ctx', provider: 'mistral', cost_per_m: 0, capabilities: { contextWindow: 256_000 } },
    { id: 'no-ctx', provider: 'mistral', cost_per_m: 0 }, // unknown context window
  ],
};

const CFG: Config = { model_groups: {}, model_metrics: {}, providers: {} };

// buildModelsWithMetadata keeps only models with gdpval > 0 unless they're
// in staticModelRefs. The CACHE above has no gdpval entries, so we pass the
// refs as staticModelRefs to keep them through enrichment for the filter test.
const STATIC_REFS = new Set(['mistral/small-ctx', 'mistral/big-ctx', 'mistral/no-ctx']);

describe('persist path: buildModelsWithMetadata → filterModelsForGroup (min_context_length)', () => {
  beforeAll(() => {
    metricsModule.setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: {} });
    metricsModule.setCache(CACHE);
  });
  afterAll(() => {
    metricsModule.setCache({});
  });

  it('buildModelsWithMetadata enriches each model with its scanned contextWindow', () => {
    const enriched = buildModelsWithMetadata(
      ['mistral/small-ctx', 'mistral/big-ctx', 'mistral/no-ctx'],
      CFG,
      new Set(),
      STATIC_REFS,
    );
    const byRef = new Map(enriched.map((m) => [m.ref, m]));
    expect(byRef.get('mistral/small-ctx')?.contextWindow).toBe(8_000);
    expect(byRef.get('mistral/big-ctx')?.contextWindow).toBe(256_000);
    expect(byRef.get('mistral/no-ctx')?.contextWindow).toBeNull();
  });

  it('filterModelsForGroup is a no-op when min_context_length is absent (regression guard)', () => {
    const models = buildModelsWithMetadata(
      ['mistral/small-ctx', 'mistral/big-ctx', 'mistral/no-ctx'],
      CFG,
      new Set(),
      STATIC_REFS,
    );
    const g: Group = { method: 'best' };
    const filtered = filterModelsForGroup(models, g, CFG);
    expect(filtered.map((m) => m.ref).sort()).toEqual(
      ['mistral/big-ctx', 'mistral/no-ctx', 'mistral/small-ctx'],
    );
  });

  it('filterModelsForGroup is a no-op when min_context_length is 0', () => {
    const models = buildModelsWithMetadata(
      ['mistral/small-ctx', 'mistral/big-ctx', 'mistral/no-ctx'],
      CFG,
      new Set(),
      STATIC_REFS,
    );
    const g: Group = { method: 'best', min_context_length: 0 };
    const filtered = filterModelsForGroup(models, g, CFG);
    expect(filtered.map((m) => m.ref).sort()).toEqual(
      ['mistral/big-ctx', 'mistral/no-ctx', 'mistral/small-ctx'],
    );
  });

  it('filterModelsForGroup drops models below the threshold', () => {
    const models = buildModelsWithMetadata(
      ['mistral/small-ctx', 'mistral/big-ctx', 'mistral/no-ctx'],
      CFG,
      new Set(),
      STATIC_REFS,
    );
    const g: Group = { method: 'best', min_context_length: 100_000 };
    const filtered = filterModelsForGroup(models, g, CFG);
    expect(filtered.map((m) => m.ref)).toEqual(['mistral/big-ctx']);
  });

  it('filterModelsForGroup drops models with unknown context window (strict, like min_gdpval)', () => {
    const models = buildModelsWithMetadata(
      ['mistral/small-ctx', 'mistral/big-ctx', 'mistral/no-ctx'],
      CFG,
      new Set(),
      STATIC_REFS,
    );
    const g: Group = { method: 'best', min_context_length: 5_000 };
    // small-ctx (8k) passes; big-ctx (256k) passes; no-ctx (unknown) is dropped.
    const filtered = filterModelsForGroup(models, g, CFG);
    expect(filtered.map((m) => m.ref).sort()).toEqual([
      'mistral/big-ctx',
      'mistral/small-ctx',
    ]);
  });

  it('filterModelsForGroup drops everything when no model meets the threshold', () => {
    const models = buildModelsWithMetadata(
      ['mistral/small-ctx', 'mistral/big-ctx', 'mistral/no-ctx'],
      CFG,
      new Set(),
      STATIC_REFS,
    );
    const g: Group = { method: 'best', min_context_length: 1_000_000 };
    const filtered = filterModelsForGroup(models, g, CFG);
    expect(filtered).toEqual([]);
  });
});
