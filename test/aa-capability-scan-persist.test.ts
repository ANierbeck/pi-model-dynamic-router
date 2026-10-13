// test/aa-capability-scan-persist.test.ts
// Guards the scan()-level persistence semantics of the AA capability
// profiles (Sourcery PR #69 review round, 2026-10-13), red-first:
//
//   1. REPLACE, not merge: a model the latest scrape DROPPED must not linger
//      with stale capability scores in the cache (the in-memory mirror gets
//      the same replace via setCache). gdpval_provenance made the same
//      REPLACE decision in PR #66 for the same reason.
//   2. scrape_version is stamped only when the capability extraction
//      produced profiles: gdpval scores parsing while capabilities come
//      back empty must NOT pin empty capability data for the cache TTL —
//      leaving scrape_version unstamped makes needsGdpvalScrape retry the
//      whole scrape on the next scan instead.
//
// The scan runner is driven directly (createScanRunner) with globalThis.fetch
// stubbed per-URL — the same hermetic pattern as the adr-0021 tests. The
// inventory block is skipped via a fresh models_cached timestamp; the
// classifier probes no-op on an empty sessionCtx.

import { describe, it, expect, afterEach } from 'vitest';
import { createScanRunner } from '../src/scan-runner.js';
import * as metricsModule from '../src/metrics.js';
import type { Cache } from '../src/types.js';

const GDPVAL_URL = 'https://aa.test/gdpval';
const originalFetch = globalThis.fetch;

function makeRt(cache: Cache) {
  return {
    cache,
    cacheManager: { saveCache: () => {} },
    cfg: {} as any,
    GDPVAL_URL,
    generateDynamicConfig: async () => {},
    MODELS_TTL: 1000 * 60 * 60 * 24 * 30,
    saveCache: () => {},
    scanning: false,
    sessionCtx: {},
  } as any;
}

function stubFetch(html: string) {
  globalThis.fetch = ((url: any) => {
    if (String(url) === GDPVAL_URL) {
      return Promise.resolve(new Response(html, { status: 200 })) as any;
    }
    return Promise.reject(new Error('network disabled during test'));
  }) as typeof fetch;
}

// Minimal Format-A gdpval entry (scores parse, no capability records).
const SCORES_ONLY_HTML =
  '{"label":"Test Model","gdpvalAaElo":[{"@type":"PropertyValue","name":"mid","value":1234.5}],"detailsUrl":"/models/test-model"}';

// One Stage-2 model record with briefcaseElo for the live slug.
const ONE_PROFILE_HTML =
  '{"slug":"gdpval-aa","initialModels":[{"id":"11111111-1111-1111-1111-111111111111","slug":"live-model","name":"Live Model","shortName":"LM","briefcaseElo":1500.5}]}';

afterEach(() => {
  globalThis.fetch = originalFetch;
  metricsModule.setCache({ available_models: [] } as any);
});

describe('scan() capability persistence (PR #69 round)', () => {
  it('REPLACES capability_profiles with the fresh extraction (dropped models do not linger)', async () => {
    const cache: Cache = {
      // ghost-model is ABSENT from the fresh payload — it must be dropped,
      // not merged over (stale scores would sort a returning model by
      // obsolete benchmark columns).
      capability_profiles: { 'ghost-model': { briefcase: 9999, coding: 9999 } },
      models_cached: new Date().toISOString(),
      openrouter_pricing: {},
    } as any;
    stubFetch(ONE_PROFILE_HTML);
    await createScanRunner(makeRt(cache)).scan(false);
    expect(cache.capability_profiles).toEqual({ 'live-model': { briefcase: 1500.5 } });
  });

  it('does NOT stamp scrape_version when the capability extraction is empty (retry instead of pinning)', async () => {
    const cache: Cache = {
      // No capability_profiles yet; SCORES_ONLY_HTML yields gdpval scores
      // but zero profiles.
      models_cached: new Date().toISOString(),
      openrouter_pricing: {},
    } as any;
    stubFetch(SCORES_ONLY_HTML);
    await createScanRunner(makeRt(cache)).scan(false);
    // The scrape ran and the scores landed...
    expect(cache.gdpval_scraped).toBe(true);
    expect(cache.gdpval_scores?.['test-model']).toBe(1234.5);
    // ...but the version must stay unstamped so the NEXT scan retries the
    // scrape (needsGdpvalScrape: scrape_version !== SCRAPE_VERSION).
    expect(cache.scrape_version).toBeUndefined();
  });
});
