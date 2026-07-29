// test/hint-resolution.test.ts
// Unit tests for HINT provider-usability ranking (src/hint-resolution.ts).
//
// Regression coverage for the bug this logic was introduced to fix: an
// unusable provider (e.g. `anthropic` without an API key) shadowing a
// working one (e.g. `claude-bridge`) when both offer the same model name.

import { describe, it, expect, vi } from 'vitest';
import { isRefUsable, rankHintCandidates, type ModelRegistryLike } from '../src/hint-resolution.js';
import type { Group } from '../src/types.js';

const noGroups: Record<string, Group> = {};

function fakeRegistry(overrides: Partial<ModelRegistryLike> = {}): ModelRegistryLike {
  return {
    find: vi.fn(() => ({ id: 'stub' })),
    getApiKeyForProvider: vi.fn(async () => 'stub-key'),
    runtime: { streamSimple: vi.fn() },
    ...overrides,
  };
}

describe('isRefUsable()', () => {
  it('returns false when the registry is missing', async () => {
    expect(await isRefUsable('anthropic/claude-sonnet-5', noGroups, null)).toBe(false);
    expect(await isRefUsable('anthropic/claude-sonnet-5', noGroups, undefined)).toBe(false);
  });

  it('returns false for a virtual group ref (would recurse)', async () => {
    const registry = fakeRegistry();
    const groups: Record<string, Group> = { strategic: { method: 'best' } };
    expect(await isRefUsable('strategic/whatever', groups, registry)).toBe(false);
    expect(registry.find).not.toHaveBeenCalled();
  });

  it('returns false when the model is not found in the registry', async () => {
    const registry = fakeRegistry({ find: vi.fn(() => undefined) });
    expect(await isRefUsable('anthropic/claude-sonnet-5', noGroups, registry)).toBe(false);
  });

  it('returns false when neither runtime.streamSimple nor getProvider(...).streamSimple exists', async () => {
    const registry = fakeRegistry({ runtime: undefined, getProvider: undefined });
    expect(await isRefUsable('anthropic/claude-sonnet-5', noGroups, registry)).toBe(false);
  });

  it('accepts a handler exposed via getProvider() when runtime.streamSimple is absent', async () => {
    const registry = fakeRegistry({
      runtime: undefined,
      getProvider: vi.fn(() => ({ streamSimple: vi.fn() })),
      getApiKeyForProvider: vi.fn(async () => 'key'),
    });
    expect(await isRefUsable('anthropic/claude-sonnet-5', noGroups, registry)).toBe(true);
  });

  it('treats a provider outside PROVIDER_MAP (e.g. claude-bridge) as usable without checking credentials', async () => {
    const registry = fakeRegistry();
    expect(await isRefUsable('claude-bridge/claude-sonnet-5', noGroups, registry)).toBe(true);
    expect(registry.getApiKeyForProvider).not.toHaveBeenCalled();
  });

  it('treats a local PROVIDER_MAP provider (ollama) as usable regardless of API key', async () => {
    const registry = fakeRegistry({ getApiKeyForProvider: vi.fn(async () => null) });
    expect(await isRefUsable('ollama/llama3.1', noGroups, registry)).toBe(true);
  });

  it('rejects a router-managed provider (anthropic) without an API key', async () => {
    const registry = fakeRegistry({ getApiKeyForProvider: vi.fn(async () => null) });
    expect(await isRefUsable('anthropic/claude-sonnet-5', noGroups, registry)).toBe(false);
  });

  it('accepts a router-managed provider (anthropic) with a valid API key', async () => {
    const registry = fakeRegistry({ getApiKeyForProvider: vi.fn(async () => 'sk-real-key') });
    expect(await isRefUsable('anthropic/claude-sonnet-5', noGroups, registry)).toBe(true);
  });

  it('rejects when getApiKeyForProvider throws', async () => {
    const registry = fakeRegistry({
      getApiKeyForProvider: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    expect(await isRefUsable('anthropic/claude-sonnet-5', noGroups, registry)).toBe(false);
  });
});

describe('rankHintCandidates()', () => {
  it('ranks a usable sibling ahead of an unusable one, regardless of gdpval', async () => {
    // Mirrors the real bug: anthropic/claude-sonnet-5 (no key) vs.
    // claude-bridge/claude-sonnet-5 (own auth, always usable).
    const registry = fakeRegistry({
      getApiKeyForProvider: vi.fn(async (provider: string) => (provider === 'anthropic' ? null : 'key')),
    });
    const ranked = await rankHintCandidates(
      ['anthropic/claude-sonnet-5', 'claude-bridge/claude-sonnet-5'],
      noGroups,
      registry,
      () => 1000 // equal gdpval — usability must be the deciding factor
    );
    expect(ranked[0]).toBe('claude-bridge/claude-sonnet-5');
    expect(ranked[1]).toBe('anthropic/claude-sonnet-5');
  });

  it('sorts usable and unusable tiers independently by gdpval', async () => {
    // Providers outside PROVIDER_MAP (like claude-bridge) skip the API-key check
    // entirely, so "unusable" here is gated on model lookup instead — mirrors a
    // ref that Pi's registry doesn't actually know about.
    const registry = fakeRegistry({
      find: vi.fn((provider: string) => (provider.startsWith('usable') ? { id: 'stub' } : undefined)),
    });
    const gdpval: Record<string, number> = {
      'usable-low/m': 100,
      'usable-high/m': 900,
      'unusable-low/m': 200,
      'unusable-high/m': 800,
    };
    const ranked = await rankHintCandidates(
      ['usable-low/m', 'unusable-high/m', 'usable-high/m', 'unusable-low/m'],
      noGroups,
      registry,
      (id) => gdpval[id] ?? 0
    );
    expect(ranked).toEqual(['usable-high/m', 'usable-low/m', 'unusable-high/m', 'unusable-low/m']);
  });

  it('never drops an unusable ref — keeps it as a last-resort candidate', async () => {
    const registry = fakeRegistry({ getApiKeyForProvider: vi.fn(async () => null) });
    const ranked = await rankHintCandidates(['anthropic/claude-sonnet-5'], noGroups, registry, () => 0);
    expect(ranked).toEqual(['anthropic/claude-sonnet-5']);
  });

  it('invokes onUnusable with exactly the unusable refs, sorted by gdpval', async () => {
    const registry = fakeRegistry({
      find: vi.fn((provider: string) => (provider === 'ok' ? { id: 'stub' } : undefined)),
    });
    const gdpval: Record<string, number> = { 'bad1/m': 50, 'bad2/m': 500, 'ok/m': 10 };
    const onUnusable = vi.fn();
    await rankHintCandidates(['bad1/m', 'ok/m', 'bad2/m'], noGroups, registry, (id) => gdpval[id] ?? 0, onUnusable);
    expect(onUnusable).toHaveBeenCalledWith(['bad2/m', 'bad1/m']);
  });

  it('does not call onUnusable when every ref is usable', async () => {
    const registry = fakeRegistry();
    const onUnusable = vi.fn();
    await rankHintCandidates(['claude-bridge/a', 'claude-bridge/b'], noGroups, registry, () => 0, onUnusable);
    expect(onUnusable).not.toHaveBeenCalled();
  });
});
