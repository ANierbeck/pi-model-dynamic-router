// test/blocklist-permanent-no-ttl.test.ts
// Plan docs/plans/2026-11-16-permanent-blocklist-no-ttl.md
//
// Live 2026-11-16: mistral/open-mistral-nemo and mistral/devstral-2512 were
// retired upstream (2026-07-31) but kept appearing in the generated group
// lists. Pi publishes no deprecation flag, so the only evidence the router
// can have is a failure. That evidence was thrown away after 7 days, because
// isBlocked() applied BLOCKLIST_TTL_MS to permanent verdicts as well, and
// the snapshot persist path ignored the blocklist entirely.
//
// A permanent verdict (Tier 1 signature: decommissioned, free-variant-retired,
// workspace-guardrail, agentic-harness-gate) states a property of the MODEL,
// not of the moment. It must not expire. Tier-2 promotions stay temporary.

import { describe, it, expect } from 'vitest';
import {
  BLOCKLIST_TTL_MS,
  recordBlocklistFailure,
  isBlocked,
  isPermanentlyBlocked,
  recordBlocklistSuccess,
  clearBlocklist,
  activeBlocks,
} from '../src/model-blocklist.ts';
import type { Cache } from '../src/types.ts';

const DECOMMISSIONED =
  '404: {"message":"No endpoints found for nex-agi/nex-n2.5-pro:free.","code":404}';
const FREE_RETIRED =
  '404: {"message":"This model is unavailable for free. The paid version is available now - use this slug instead: z-ai/glm-5.2","code":404}';
// HTTP 500/502/503 are classified 'transient' and never count toward Tier 2;
// 422 with unrecognised text is 'unknown' and does (see error-signatures.ts).
const UNKNOWN = '422: {"message":"something exploded","code":422}';

function emptyCache(): Cache {
  return {} as Cache;
}

describe('permanent blocklist entries never expire', () => {
  it('keeps a decommissioned model blocked long after the TTL', () => {
    const cache = emptyCache();
    const t0 = 1_000_000;
    expect(
      recordBlocklistFailure(cache, 'openrouter/retired/model:free', DECOMMISSIONED, t0)
    ).toBeTruthy();

    // Still blocked at the TTL boundary and far beyond it.
    expect(isBlocked(cache, 'openrouter/retired/model:free', t0 + BLOCKLIST_TTL_MS - 1)).toBe(true);
    expect(isBlocked(cache, 'openrouter/retired/model:free', t0 + BLOCKLIST_TTL_MS)).toBe(true);
    expect(isBlocked(cache, 'openrouter/retired/model:free', t0 + 365 * 24 * 60 * 60_000)).toBe(
      true
    );
  });

  it('still expires a Tier-2 (unknown-signature) promotion after the TTL', () => {
    const cache = emptyCache();
    const t0 = 1_000_000;
    // Five failures spanning an hour promote to a temporary block.
    for (let i = 0; i < 5; i++) {
      recordBlocklistFailure(cache, 'openrouter/flaky/model:free', UNKNOWN, t0 + i * 20 * 60_000);
    }
    // Promoted on the fifth failure (t0 + 80min).
    expect(isBlocked(cache, 'openrouter/flaky/model:free', t0 + 90 * 60_000)).toBe(true);
    expect(
      isBlocked(cache, 'openrouter/flaky/model:free', t0 + 90 * 60_000 + BLOCKLIST_TTL_MS)
    ).toBe(false);
  });

  it('distinguishes permanent from temporary blocks', () => {
    const cache = emptyCache();
    const t0 = 1_000_000;
    recordBlocklistFailure(cache, 'openrouter/retired/model:free', DECOMMISSIONED, t0);
    recordBlocklistFailure(cache, 'openrouter/retired/free-model:free', FREE_RETIRED, t0);
    for (let i = 0; i < 5; i++) {
      recordBlocklistFailure(cache, 'openrouter/flaky/model:free', UNKNOWN, t0 + i * 20 * 60_000);
    }

    expect(isPermanentlyBlocked(cache, 'openrouter/retired/model:free')).toBe(true);
    expect(isPermanentlyBlocked(cache, 'openrouter/retired/free-model:free')).toBe(true);
    expect(isPermanentlyBlocked(cache, 'openrouter/flaky/model:free')).toBe(false);
    expect(isPermanentlyBlocked(cache, 'openrouter/never/seen:free')).toBe(false);
  });

  it('reports permanent entries in activeBlocks with no re-probe countdown', () => {
    const cache = emptyCache();
    const t0 = 1_000_000;
    recordBlocklistFailure(cache, 'openrouter/retired/model:free', DECOMMISSIONED, t0);
    for (let i = 0; i < 5; i++) {
      recordBlocklistFailure(cache, 'openrouter/flaky/model:free', UNKNOWN, t0 + i * 20 * 60_000);
    }
    // 10 minutes after the Tier-2 promotion (t0 + 80min).
    const now = t0 + 90 * 60_000;

    const permanent = activeBlocks(cache, now).find(
      (b) => b.ref === 'openrouter/retired/model:free'
    );
    const temporary = activeBlocks(cache, now).find((b) => b.ref === 'openrouter/flaky/model:free');
    expect(permanent?.reprobeInMs).toBeNull();
    expect(temporary?.reprobeInMs).toBe(BLOCKLIST_TTL_MS - 10 * 60_000);

    // Past the TTL only the permanent entry is still active.
    const later = activeBlocks(cache, now + BLOCKLIST_TTL_MS);
    expect(later.map((b) => b.ref)).toEqual(['openrouter/retired/model:free']);
  });

  it('lets an observed success clear a permanent block', () => {
    const cache = emptyCache();
    recordBlocklistFailure(cache, 'openrouter/retired/model:free', DECOMMISSIONED, 1_000_000);
    expect(recordBlocklistSuccess(cache, 'openrouter/retired/model:free')).toBe(true);
    expect(isBlocked(cache, 'openrouter/retired/model:free')).toBe(false);
    expect(isPermanentlyBlocked(cache, 'openrouter/retired/model:free')).toBe(false);
  });

  it('lets the owner clear a permanent block manually', () => {
    const cache = emptyCache();
    recordBlocklistFailure(cache, 'openrouter/retired/model:free', DECOMMISSIONED, 1_000_000);
    expect(clearBlocklist(cache, 'openrouter/retired/model:free')).toBe(1);
    expect(isPermanentlyBlocked(cache, 'openrouter/retired/model:free')).toBe(false);
  });
});
