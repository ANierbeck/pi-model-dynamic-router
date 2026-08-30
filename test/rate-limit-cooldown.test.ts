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

  it('resetAtMs overrides the backoff when the reset is further out', () => {
    // When a provider sends a reset-at time (e.g. 2.5 hours for five_hour),
    // the cooldown must be at least as long as the gap from now until reset.
    // Without this, a hit near the end of a 5-hour window would be capped at
    // 90 minutes (the backoff schedule ceiling), and the model would get
    // re-picked before the window actually resets.
    const cache: any = { exhausted_keys: {} };
    const rlm = new RateLimitManager(BACKOFF_MS, SOFT_BACKOFF_MS, COST_MUX_AT_HIT, cache);

    // Reset in 3 hours (well beyond the 1-minute first-hit backoff)
    const threeHours = 3 * 60 * 60 * 1000;
    const resetAtMs = Date.now() + threeHours;
    rlm.recordLimit('test-provider/model-1', {}, resetAtMs);

    const secs = rlm.limitSecs('test-provider/model-1');
    // Must wait at least until the reset window
    expect(secs).toBeGreaterThan(threeHours / 1000 - 2); // 2s tolerance
    // But capped by sanity (not 3 hours exactly due to test execution time)
    expect(secs).toBeLessThanOrEqual(threeHours / 1000 + 5);
  });

  it('resetAtMs is ignored when the backoff is already longer', () => {
    // When the escalating backoff is already past the reset window (e.g. many
    // consecutive hits already pushed us to 90 minutes), a short reset time
    // should not prematurely unlock the model.
    const cache: any = { exhausted_keys: {} };
    const rlm = new RateLimitManager(BACKOFF_MS, SOFT_BACKOFF_MS, COST_MUX_AT_HIT, cache);

    // Simulate many consecutive hits to push the backoff high
    for (let i = 0; i < 7; i++) {
      rlm.recordLimit('test-provider/model-1', {});
    }
    // Now try with a short reset time (only 1 minute away)
    const shortReset = Date.now() + 60_000;
    rlm.recordLimit('test-provider/model-1', {}, shortReset);

    const secs = rlm.limitSecs('test-provider/model-1');
    // Must still use the high backoff (90 minutes), not the short reset time
    expect(secs).toBeGreaterThan(80 * 60);
    expect(secs).toBeLessThanOrEqual(90 * 60);
  });
});