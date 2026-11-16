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
  formatBlockLogLine,
} from '../src/model-blocklist.ts';
import type { Cache } from '../src/types.ts';

const DECOMMISSIONED =
  '404: {"message":"No endpoints found for nex-agi/nex-n2.5-pro:free.","code":404}';
const FREE_RETIRED =
  '404: {"message":"This model is unavailable for free. The paid version is available now - use this slug instead: z-ai/glm-5.2","code":404}';
// HTTP 500/502/503 are classified 'transient' and never count toward Tier 2;
// 422 with unrecognised text is 'unknown' and does (see error-signatures.ts).
const UNKNOWN = '422: {"message":"something exploded","code":422}';
// Verbatim shape from the 2026-09-26 incident: an OpenRouter account-level
// privacy/guardrail restriction, i.e. an access condition, not a retirement.
const GUARDRAIL =
  '404: {"message":"0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy. We removed them for the following reasons (an endpoint may have matched multiple reasons):\\nFree model training violation (guardrail): 1 endpoint excluded","code":404,"metadata":{"input_endpoint_count":1,"ineligibility_reasons":[{"reason":"free-model-training-violation-by-guardrail","endpoint_count":1}],"failed_routing_step":"Filter by Guardrails"}}';

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

  // A guardrail restriction is a property of the ACCOUNT settings, not of the
  // model: the owner can lift it, so the block must keep its TTL and heal.
  // Same for the agentic-harness gate, which a host update can change.
  it('keeps an access-level block (guardrail) temporary so the model can heal', () => {
    const cache = emptyCache();
    const t0 = 1_000_000;
    recordBlocklistFailure(cache, 'openrouter/guardrailed/model:free', GUARDRAIL, t0);
    expect(isBlocked(cache, 'openrouter/guardrailed/model:free', t0 + 1)).toBe(true);
    expect(isBlocked(cache, 'openrouter/guardrailed/model:free', t0 + BLOCKLIST_TTL_MS)).toBe(
      false
    );
    expect(isPermanentlyBlocked(cache, 'openrouter/guardrailed/model:free')).toBe(false);
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

  // Entries written before the `permanent` flag existed (upgrade 2026-11-16)
  // carry no flag. Their `reason` is the Tier-1 signature reason — only
  // Tier-2 promotions use 'unknown-signature' — so permanence is derivable
  // and they must not silently start expiring after the upgrade.
  describe('entries from before the flag existed', () => {
    const legacy = (reason: string, lastSeen: number) => ({
      reason,
      code: 404,
      signature: `404:${reason}`,
      first_seen: lastSeen,
      last_seen: lastSeen,
      occurrences: 1,
    });

    it('treats a legacy Tier-1 entry as permanent', () => {
      const cache = emptyCache();
      const old = Date.now() - 90 * 86_400_000;
      cache.model_blocklist = { 'openrouter/legacy/retired:free': legacy('decommissioned', old) };
      expect(isBlocked(cache, 'openrouter/legacy/retired:free')).toBe(true);
      expect(isPermanentlyBlocked(cache, 'openrouter/legacy/retired:free')).toBe(true);
    });

    it('keeps a legacy access-level entry temporary', () => {
      const cache = emptyCache();
      const old = Date.now() - 90 * 86_400_000;
      cache.model_blocklist = {
        'openrouter/legacy/guardrailed:free': legacy('workspace-guardrail', old),
      };
      expect(isBlocked(cache, 'openrouter/legacy/guardrailed:free')).toBe(false);
      expect(isPermanentlyBlocked(cache, 'openrouter/legacy/guardrailed:free')).toBe(false);
    });

    it('keeps a legacy Tier-2 entry temporary', () => {
      const cache = emptyCache();
      const old = Date.now() - 90 * 86_400_000;
      cache.model_blocklist = {
        'openrouter/legacy/flaky:free': legacy('unknown-signature', old),
      };
      expect(isBlocked(cache, 'openrouter/legacy/flaky:free')).toBe(false);
      expect(isPermanentlyBlocked(cache, 'openrouter/legacy/flaky:free')).toBe(false);
    });

    it('reports a legacy permanent entry in activeBlocks without a countdown', () => {
      const cache = emptyCache();
      const old = Date.now() - 90 * 86_400_000;
      cache.model_blocklist = { 'openrouter/legacy/retired:free': legacy('decommissioned', old) };
      const active = activeBlocks(cache);
      expect(active.map((b) => b.ref)).toEqual(['openrouter/legacy/retired:free']);
      expect(active[0].reprobeInMs).toBeNull();
    });

    it('narrates a legacy permanent entry as permanent', () => {
      const cache = emptyCache();
      const old = Date.now() - 90 * 86_400_000;
      cache.model_blocklist = { 'openrouter/legacy/retired:free': legacy('decommissioned', old) };
      expect(
        formatBlockLogLine(
          'openrouter/legacy/retired:free',
          cache.model_blocklist['openrouter/legacy/retired:free']
        )
      ).toContain('blocked permanently');
    });
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
