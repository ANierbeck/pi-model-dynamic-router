// test/rate-limit-cooldown.test.ts
// Tests for the RateLimitManager cooldown calculation.
// Critical bug was: backoffMinutes (already in ms) was multiplied by 60_000
// again, producing 60.000 * 60.000 = 3.6B ms = 41.67 days cooldown!

import { describe, it, expect } from 'vitest';
import { RateLimitManager } from '../src/rate-limit.ts';

// Simulate the BACKOFF array as index.ts creates it:
// _defaults.backoff_minutes.map((m) => m * 60_000)
const BACKOFF_MS = [1, 2, 4, 8, 16, 32, 64, 90].map((m) => m * 60_000);
const SOFT_BACKOFF_MS = [30000, 60000, 120000, 300000];
const COST_MUX_AT_HIT = 4;

describe('RateLimitManager cooldown calculation', () => {
  it('recordLimit produces cooldown in SECONDS, not days', () => {
    const cache: any = { exhausted_keys: {} };
    const rlm = new RateLimitManager(BACKOFF_MS, SOFT_BACKOFF_MS, COST_MUX_AT_HIT, cache);

    // Record a limit (no keys to rotate → falls back to model-level backoff)
    rlm.recordLimit('test-provider/model-1', {});

    const secs = rlm.limitSecs('test-provider/model-1');
    // Should be ~60 seconds (1 minute), NOT 3.6 million seconds (41 days)
    expect(secs).toBeGreaterThan(50);
    expect(secs).toBeLessThanOrEqual(60);

    // CRITICAL: must never exceed the max backoff (90 minutes = 5400 seconds)
    expect(secs).toBeLessThan(5401);
  });

  it('escalating hits produce correct backoff schedule', () => {
    const cache: any = { exhausted_keys: {} };
    const rlm = new RateLimitManager(BACKOFF_MS, SOFT_BACKOFF_MS, COST_MUX_AT_HIT, cache);

    const expectedMinutes = [1, 2, 4, 8, 16, 32, 64, 90];
    for (let i = 0; i < expectedMinutes.length; i++) {
      rlm.recordLimit('test-provider/model-1', {});
      const secs = rlm.limitSecs('test-provider/model-1');
      const expectedSecs = expectedMinutes[i] * 60;

      // Allow 1 second tolerance for test execution time
      expect(secs).toBeGreaterThanOrEqual(expectedSecs - 1);
      expect(secs).toBeLessThanOrEqual(expectedSecs);
    }
  });

  it('never produces a cooldown longer than 90 minutes (5400 seconds)', () => {
    const cache: any = { exhausted_keys: {} };
    const rlm = new RateLimitManager(BACKOFF_MS, SOFT_BACKOFF_MS, COST_MUX_AT_HIT, cache);

    // Record many hits — should cap at max backoff
    for (let i = 0; i < 20; i++) {
      rlm.recordLimit('test-provider/model-1', {});
    }
    const secs = rlm.limitSecs('test-provider/model-1');
    expect(secs).toBeLessThanOrEqual(5400); // 90 minutes max
  });

  it('recordSoftFailure produces correct cooldown', () => {
    const cache: any = { exhausted_keys: {} };
    const rlm = new RateLimitManager(BACKOFF_MS, SOFT_BACKOFF_MS, COST_MUX_AT_HIT, cache);

    rlm.recordSoftFailure('test-provider/model-1');
    const secs = rlm.limitSecs('test-provider/model-1');
    // First soft failure: 30000ms = 30 seconds
    expect(secs).toBeGreaterThan(25);
    expect(secs).toBeLessThanOrEqual(30);
  });

  it('soft failure cooldown never exceeds max (300 seconds)', () => {
    const cache: any = { exhausted_keys: {} };
    const rlm = new RateLimitManager(BACKOFF_MS, SOFT_BACKOFF_MS, COST_MUX_AT_HIT, cache);

    for (let i = 0; i < 20; i++) {
      rlm.recordSoftFailure('test-provider/model-1');
    }
    const secs = rlm.limitSecs('test-provider/model-1');
    expect(secs).toBeLessThanOrEqual(300); // 5 minutes max
  });
});