// test/probe-cache-signature.test.ts
// Sourcery PR #70 review, finding "Cached models return obsolete categories":
// the persisted classifier-fallback probe cache (cache.classifier_fallback_models)
// survives taxonomy/prompt migrations. A model that passed the OLD probe may
// no longer be acceptable under the NEW prompt (and vice versa), and the router
// would keep using the stale list. The cache therefore records a probe
// signature (derived from the probe cases + the valid category set) and is
// treated as "not probed" when the signature does not match — the next scan
// re-probes against the current prompt surface.
// Red-first: both pins were observed failing against the pre-fix code
// (hasProbedFallback returned true / getCachedFallbackModels returned the
// stale list for a signature-less cache).

import { describe, it, expect } from 'vitest';
import { getCachedFallbackModels, hasProbedFallback, PROBE_SIGNATURE } from '../src/classifier-fallback-probe.ts';

const STALE_CACHE: any = {
  // Written by a probe of the OLD taxonomy: a model list but no signature.
  classifier_fallback_models: ['openrouter/some-old-model:free'],
};
const FRESH_CACHE: any = {
  classifier_fallback_models: ['openrouter/some-model:free'],
  classifier_fallback_probe_sig: PROBE_SIGNATURE,
};
const MIGRATED_CACHE: any = {
  // Same list, but recorded under the previous (now changed) prompt surface.
  classifier_fallback_models: ['openrouter/some-old-model:free'],
  classifier_fallback_probe_sig: 'old-signature',
};

describe('classifier-fallback probe cache signature', () => {
  it('a signature-less cache (pre-migration layout) is treated as not probed', () => {
    expect(hasProbedFallback(STALE_CACHE)).toBe(false);
    expect(getCachedFallbackModels(STALE_CACHE)).toEqual([]);
  });

  it('a cache recorded under a different prompt surface is treated as not probed', () => {
    expect(hasProbedFallback(MIGRATED_CACHE)).toBe(false);
    expect(getCachedFallbackModels(MIGRATED_CACHE)).toEqual([]);
  });

  it('a cache with the current signature is used as-is', () => {
    expect(hasProbedFallback(FRESH_CACHE)).toBe(true);
    expect(getCachedFallbackModels(FRESH_CACHE)).toEqual(['openrouter/some-model:free']);
  });

  it('no cache at all stays "not probed" (empty list is valid once signed)', () => {
    const empty: any = { classifier_fallback_models: [], classifier_fallback_probe_sig: PROBE_SIGNATURE };
    expect(hasProbedFallback(empty)).toBe(true);
    expect(getCachedFallbackModels(empty)).toEqual([]);
  });
});
