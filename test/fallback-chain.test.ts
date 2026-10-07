// test/fallback-chain.test.ts
// Unit tests for getFallbackGroup() (src/routing.ts) — the cascade the
// router walks when every candidate in a group fails.
//
// Bug this guards against: getFallbackGroup() ignored a group's configured
// fallback_groups and always used the hardcoded global FALLBACK_GROUP_ORDER.
// This meant a group configured to skip ahead in the cascade (e.g. trivial
// → fallback, bypassing scout) would silently fall through to whatever the
// global order put next instead.
//
// getFallbackGroup() used to be a closure-private function inside index.ts's
// activate(), which forced tests to either spin up the full extension harness
// (fragile here — dynamic config generation pools candidates across groups by
// design, defeating any attempt to isolate one group's candidate list) or
// hand-copy the function into the test file (the previous version of this
// file, which asserted the copy against itself and would never notice a real
// regression). Extracting it as a pure exported function makes it directly
// and reliably testable.

import { describe, it, expect } from 'vitest';
import { getFallbackGroup, FALLBACK_GROUP_ORDER } from '../src/routing.ts';
import type { Group } from '../src/types.ts';

describe('getFallbackGroup', () => {
  it('prefers a configured fallback_groups entry over the global order', () => {
    // Global order has 'scout' immediately after 'trivial'. A configured
    // fallback_groups pointing straight to 'fallback' must win instead.
    const modelGroups: Record<string, Group> = {
      trivial: { method: 'best', fallback_groups: ['fallback'] },
      scout: { method: 'best' },
      fallback: { method: 'best' },
    };
    expect(getFallbackGroup('trivial', modelGroups, new Set())).toBe('fallback');
  });

  it('skips configured fallback_groups entries that do not exist in config', () => {
    const modelGroups: Record<string, Group> = {
      trivial: { method: 'best', fallback_groups: ['nonexistent', 'fallback'] },
      fallback: { method: 'best' },
    };
    expect(getFallbackGroup('trivial', modelGroups, new Set())).toBe('fallback');
  });

  it('skips already-visited groups from the configured list', () => {
    const modelGroups: Record<string, Group> = {
      trivial: { method: 'best', fallback_groups: ['scout', 'fallback'] },
      scout: { method: 'best' },
      fallback: { method: 'best' },
    };
    expect(getFallbackGroup('trivial', modelGroups, new Set(['scout']))).toBe('fallback');
  });

  it('falls through to the global order when fallback_groups is unset', () => {
    const modelGroups: Record<string, Group> = {
      trivial: { method: 'best' },
      scout: { method: 'best' },
      fallback: { method: 'best' },
    };
    expect(getFallbackGroup('trivial', modelGroups, new Set())).toBe('scout');
  });

  it('falls through to the global order when fallback_groups is empty', () => {
    const modelGroups: Record<string, Group> = {
      trivial: { method: 'best', fallback_groups: [] },
      scout: { method: 'best' },
    };
    expect(getFallbackGroup('trivial', modelGroups, new Set())).toBe('scout');
  });

  it('falls through to the global order when every configured entry is unusable', () => {
    const modelGroups: Record<string, Group> = {
      trivial: { method: 'best', fallback_groups: ['nonexistent'] },
      scout: { method: 'best' },
    };
    expect(getFallbackGroup('trivial', modelGroups, new Set())).toBe('scout');
  });

  it('skips already-visited groups in the global order too', () => {
    const modelGroups: Record<string, Group> = {
      trivial: { method: 'best' },
      scout: { method: 'best' },
      fallback: { method: 'best' },
    };
    expect(getFallbackGroup('trivial', modelGroups, new Set(['scout']))).toBe('fallback');
  });

  it('returns null when the current group is not in the global order and has no config', () => {
    const modelGroups: Record<string, Group> = { custom: { method: 'best' } };
    expect(getFallbackGroup('custom', modelGroups, new Set())).toBeNull();
  });

  it('returns null when every remaining group in the global order is visited or undefined', () => {
    const modelGroups: Record<string, Group> = { fallback: { method: 'best' } };
    expect(getFallbackGroup('fallback', modelGroups, new Set())).toBeNull();
  });

  it('FALLBACK_GROUP_ORDER ends with fallback (last resort)', () => {
    expect(FALLBACK_GROUP_ORDER[FALLBACK_GROUP_ORDER.length - 1]).toBe('fallback');
  });

  // Nightly R1 (2026-10-07): the tests above import FALLBACK_GROUP_ORDER, so
  // its contents were never pinned — an emptied or renamed list passed.
  it('FALLBACK_GROUP_ORDER is the coarse-to-cheap cascade, spelled out', () => {
    expect([...FALLBACK_GROUP_ORDER]).toEqual([
      'strategic', 'complex', 'operational', 'tactical', 'simple', 'trivial', 'scout', 'fallback',
    ]);
  });

  it('walks the whole global order one hop at a time when no group configures fallbacks', () => {
    const modelGroups: Record<string, Group> = {};
    for (const name of FALLBACK_GROUP_ORDER) modelGroups[name] = { method: 'best' };
    const visited = new Set<string>();
    const walk: string[] = [];
    let cur: string | null = 'strategic';
    while (cur !== null) {
      walk.push(cur);
      visited.add(cur);
      cur = getFallbackGroup(cur, modelGroups, visited);
    }
    expect(walk).toEqual([
      'strategic', 'complex', 'operational', 'tactical', 'simple', 'trivial', 'scout', 'fallback',
    ]);
  });

  it('a current group that is absent from config still cascades through the global order', () => {
    // g is undefined here: the configured-fallbacks lookup must not crash.
    const modelGroups: Record<string, Group> = { complex: { method: 'best' } };
    expect(getFallbackGroup('strategic', modelGroups, new Set())).toBe('complex');
  });
});
