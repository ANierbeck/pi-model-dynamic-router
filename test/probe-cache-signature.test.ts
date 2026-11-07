// test/probe-cache-signature.test.ts
// Sourcery PR #70 review, finding "Cached models return obsolete categories":
// the persisted classifier-fallback probe cache (cache.classifier_cloud_models)
// survives taxonomy/prompt migrations. A model that passed the OLD probe may
// no longer be acceptable under the NEW prompt (and vice versa), and the router
// would keep using the stale list. The cache therefore records a probe
// signature (derived from the probe cases + the valid category set) and is
// treated as "not probed" when the signature does not match — the next scan
// re-probes against the current prompt surface.
// Red-first: both pins were observed failing against the pre-fix code
// (hasProbedCloudChain returned true / getCachedCloudModels returned the
// stale list for a signature-less cache).

import { describe, it, expect } from 'vitest';
import {
  getCachedCloudModels,
  hasProbedCloudChain,
  PROBE_SIGNATURE,
} from '../src/classifier-cloud-probe.ts';

const STALE_CACHE: any = {
  // Written by a probe of the OLD taxonomy: a model list but no signature.
  classifier_cloud_models: ['openrouter/some-old-model:free'],
};
const FRESH_CACHE: any = {
  classifier_cloud_models: ['openrouter/some-model:free'],
  classifier_cloud_probe_sig: PROBE_SIGNATURE,
};
const MIGRATED_CACHE: any = {
  // Same list, but recorded under the previous (now changed) prompt surface.
  classifier_cloud_models: ['openrouter/some-old-model:free'],
  classifier_cloud_probe_sig: 'old-signature',
};

describe('classifier-fallback probe cache signature', () => {
  it('a signature-less cache (pre-migration layout) is treated as not probed', () => {
    expect(hasProbedCloudChain(STALE_CACHE)).toBe(false);
    expect(getCachedCloudModels(STALE_CACHE)).toEqual([]);
  });

  it('a cache recorded under a different prompt surface is treated as not probed', () => {
    expect(hasProbedCloudChain(MIGRATED_CACHE)).toBe(false);
    expect(getCachedCloudModels(MIGRATED_CACHE)).toEqual([]);
  });

  it('a cache with the current signature is used as-is', () => {
    expect(hasProbedCloudChain(FRESH_CACHE)).toBe(true);
    expect(getCachedCloudModels(FRESH_CACHE)).toEqual(['openrouter/some-model:free']);
  });

  it('no cache at all stays "not probed" (empty list is valid once signed)', () => {
    const empty: any = {
      classifier_cloud_models: [],
      classifier_cloud_probe_sig: PROBE_SIGNATURE,
    };
    expect(hasProbedCloudChain(empty)).toBe(true);
    expect(getCachedCloudModels(empty)).toEqual([]);
  });
});
