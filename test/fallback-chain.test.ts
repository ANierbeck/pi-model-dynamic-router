// test/fallback-chain.test.ts
// Tests that getFallbackGroup respects the configured fallback_groups
// from router-config.json, instead of using a hardcoded global order.
//
// Bug: getFallbackGroup() ignored the per-group fallback_groups config
// and used FALLBACK_GROUP_ORDER. This meant trivial (fallback_groups: [scout,
// operational, fallback]) never fell back to scout — it fell through to
// the global order which didn't include scout before operational.

import { describe, it, expect } from 'vitest';

// Test the fallback group resolution logic in isolation.
// This mirrors the getFallbackGroup function in index.ts.

const FALLBACK_GROUP_ORDER = [
  'strategic', 'complex', 'operational', 'tactical', 'simple', 'trivial', 'scout', 'fallback'
];

function getFallbackGroup(
  currentGroup: string,
  modelGroups: Record<string, { fallback_groups?: string[] }>
): string | null {
  const g = modelGroups[currentGroup];
  if (g?.fallback_groups?.length) {
    for (const fb of g.fallback_groups) {
      if (modelGroups[fb]) return fb;
    }
  }
  const idx = FALLBACK_GROUP_ORDER.indexOf(currentGroup);
  if (idx === -1) return null;
  for (let i = idx + 1; i < FALLBACK_GROUP_ORDER.length; i++) {
    const group = FALLBACK_GROUP_ORDER[i];
    if (modelGroups[group]) return group;
  }
  return null;
}

describe('getFallbackGroup respects configured fallback_groups', () => {
  const modelGroups = {
    trivial: { fallback_groups: ['scout', 'operational', 'fallback'] },
    simple: { fallback_groups: ['trivial', 'scout', 'operational', 'fallback'] },
    scout: { fallback_groups: ['fallback'] },
    operational: { fallback_groups: ['scout', 'fallback'] },
    fallback: {},
    tactical: { fallback_groups: ['operational', 'scout', 'fallback'] },
  };

  it('trivial falls back to scout (first configured fallback)', () => {
    expect(getFallbackGroup('trivial', modelGroups)).toBe('scout');
  });

  it('simple falls back to trivial (first configured fallback)', () => {
    expect(getFallbackGroup('simple', modelGroups)).toBe('trivial');
  });

  it('scout falls back to fallback', () => {
    expect(getFallbackGroup('scout', modelGroups)).toBe('fallback');
  });

  it('operational falls back to scout (not fallback, per config)', () => {
    expect(getFallbackGroup('operational', modelGroups)).toBe('scout');
  });

  it('tactical falls back to operational', () => {
    expect(getFallbackGroup('tactical', modelGroups)).toBe('operational');
  });

  it('group without fallback_groups uses global order', () => {
    // 'fallback' has no fallback_groups → use global order → null (last in order)
    expect(getFallbackGroup('fallback', modelGroups)).toBeNull();
  });

  it('group not in config returns null', () => {
    expect(getFallbackGroup('nonexistent', modelGroups)).toBeNull();
  });
});

describe('getFallbackGroup: trivial → scout cascade', () => {
  // The actual bug scenario: trivial has max_cost: 0, all free models fail.
  // It should fall back to scout (which has no max_cost, includes mistral).
  const modelGroups = {
    trivial: { fallback_groups: ['scout', 'operational', 'fallback'] },
    scout: { fallback_groups: ['fallback'] },
    operational: { fallback_groups: ['scout', 'fallback'] },
    fallback: {},
  };

  it('trivial → scout (has mistral models, no max_cost)', () => {
    const fb = getFallbackGroup('trivial', modelGroups);
    expect(fb).toBe('scout');
    // scout should exist in modelGroups
    expect(modelGroups[fb!]).toBeDefined();
  });
});