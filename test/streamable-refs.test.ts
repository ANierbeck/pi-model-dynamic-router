/**
 * Regression tests for the persist-path streamable filter (mistral-zai
 * ghost-model incident, 2026-09-20).
 *
 * generateDynamicConfig builds `allModelRefs` from static free_models ∪
 * scan-cache refs ∪ registry refs — so stale scan-cache entries flowed
 * straight into the generated group configs even though Pi's registry
 * could never serve them. A ghost ref (`mistral-zai/zai-glm-5-3`) with a
 * scan-placeholder cost of $0 and the pool's best GDPval then won every
 * cost-sorted group.
 *
 * The filter: a ref may only enter the generated config if it can actually
 * be streamed — i.e. resolvable in Pi's registry. Both the live paths and
 * this filter key on Pi's registry directly (since ADR-0021 the router
 * registers no scan-discovered models, so "in the registry" is the sole
 * authoritative streamability signal), or served by a local runtime
 * (ollama), or explicitly listed as a free model in the user's config
 * (explicit on-demand registration intent).
 */
import { describe, it, expect } from 'vitest';
import { isStreamableRef } from '../src/streamable-refs.ts';

const registry: Record<string, string[]> = {
  mistral: ['zai-glm-5-3', 'zai-glm-5-2', 'mistral-medium-3.5'],
  openrouter: ['z-ai/glm-5.2:free'],
};

const ctx = {
  hasRegistryModel: (provider: string, modelId: string) =>
    (registry[provider] ?? []).includes(modelId),
  isLocalProvider: (provider: string) => provider === 'ollama',
  freeModelRefs: new Set(['openrouter/qwen/qwen-2.5-7b-instruct:free']),
  // Baseline: every provider in these fixtures has a configured key, so
  // the existing assertions below are unaffected by the new gate.
  hasConfiguredAuth: () => true,
};

describe('isStreamableRef', () => {
  it('keeps refs that exist in Pi\u2019s registry', () => {
    expect(isStreamableRef('mistral/zai-glm-5-3', ctx)).toBe(true);
    expect(isStreamableRef('openrouter/z-ai/glm-5.2:free', ctx)).toBe(true);
  });

  it('drops ghost refs whose provider is not in the registry', () => {
    // The exact incident: mistral-zai/zai-glm-5-3 with fake $0 cost.
    expect(isStreamableRef('mistral-zai/zai-glm-5-3', ctx)).toBe(false);
  });

  it('drops refs of registry-known providers whose model is not registered', () => {
    // Catalog drift: a stale cache entry for a model pi no longer serves.
    expect(isStreamableRef('mistral/zai-glm-latest', ctx)).toBe(false);
  });

  it('keeps local-provider refs even when not in the registry', () => {
    // ollama models can appear at runtime without registry presence.
    expect(isStreamableRef('ollama/llama3:latest', ctx)).toBe(true);
  });

  it('keeps refs explicitly listed in a provider\u2019s free_models config', () => {
    // Explicit user intent — stream-time on-demand registration covers them.
    expect(isStreamableRef('openrouter/qwen/qwen-2.5-7b-instruct:free', ctx)).toBe(true);
  });

  it('drops malformed refs without a provider prefix', () => {
    expect(isStreamableRef('zai-glm-5-3', ctx)).toBe(false);
  });
});

// Bug report 2026-10-06: a user with no openrouter key still had
// openrouter/* free-model refs fill every cheap group and the classifier
// fallback chain, failing at stream time with "Provider is not configured:
// openrouter" on every single call. Root cause: the free-model branch
// above returned true on CONFIG PRESENCE alone, never asking whether the
// provider actually has credentials — the one check registryRefs/
// getAvailable() already gets right for every other ref.
describe('isStreamableRef — free-model refs require a configured provider', () => {
  const unconfigured = {
    ...ctx,
    freeModelRefs: new Set(['openrouter/qwen/qwen-2.5-7b-instruct:free']),
    hasConfiguredAuth: (provider: string) => provider !== 'openrouter',
  };

  it('drops a configured free-model ref when its provider has no key', () => {
    expect(isStreamableRef('openrouter/qwen/qwen-2.5-7b-instruct:free', unconfigured)).toBe(false);
  });

  it('keeps it once the provider has a key (regression guard)', () => {
    const configured = { ...unconfigured, hasConfiguredAuth: () => true };
    expect(isStreamableRef('openrouter/qwen/qwen-2.5-7b-instruct:free', configured)).toBe(true);
  });

  it('does not let an unconfigured free-model ref fall through to the registry check', () => {
    // Even if Pi's builtin catalog happens to know the model shape, an
    // explicitly free-listed ref for an unconfigured provider must stay
    // excluded — the free-model branch is a SHORTCUT, not a bypass.
    const knownButUnconfigured = {
      ...unconfigured,
      hasRegistryModel: () => true,
    };
    expect(isStreamableRef('openrouter/qwen/qwen-2.5-7b-instruct:free', knownButUnconfigured)).toBe(false);
  });
});
