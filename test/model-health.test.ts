// test/model-health.test.ts
// Tests for per-model reliability tracking.
//
// Scenario this guards against: openrouter free models return empty_response
// on every request. Ranking is purely GDPval-based, so after their 30s soft
// backoff expires they go straight back to rank 1 and the turn fails again.
// Health tracking must demote them below working models.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordModelFailure,
  recordModelSuccess,
  failureStreak,
  isUnhealthy,
  demoteUnhealthy,
  HEALTH_DECAY_MS,
  UNHEALTHY_AT,
} from '../src/model-health.ts';
import type { Cache } from '../src/types.ts';

let cache: Cache;

beforeEach(() => {
  cache = {} as Cache;
});

describe('failure tracking', () => {
  it('starts healthy with no streak', () => {
    expect(failureStreak(cache, 'openrouter/foo:free')).toBe(0);
    expect(isUnhealthy(cache, 'openrouter/foo:free')).toBe(false);
  });

  it('counts consecutive failures', () => {
    recordModelFailure(cache, 'openrouter/foo:free');
    expect(failureStreak(cache, 'openrouter/foo:free')).toBe(1);
    recordModelFailure(cache, 'openrouter/foo:free');
    expect(failureStreak(cache, 'openrouter/foo:free')).toBe(2);
  });

  it('becomes unhealthy at the threshold', () => {
    for (let i = 0; i < UNHEALTHY_AT; i++) recordModelFailure(cache, 'openrouter/foo:free');
    expect(isUnhealthy(cache, 'openrouter/foo:free')).toBe(true);
  });

  it('a single failure does not make a model unhealthy', () => {
    recordModelFailure(cache, 'openrouter/foo:free');
    expect(isUnhealthy(cache, 'openrouter/foo:free')).toBe(false);
  });

  it('success clears the streak', () => {
    recordModelFailure(cache, 'mistral/devstral-2512');
    recordModelFailure(cache, 'mistral/devstral-2512');
    expect(isUnhealthy(cache, 'mistral/devstral-2512')).toBe(true);
    recordModelSuccess(cache, 'mistral/devstral-2512');
    expect(failureStreak(cache, 'mistral/devstral-2512')).toBe(0);
    expect(isUnhealthy(cache, 'mistral/devstral-2512')).toBe(false);
  });

  it('failures decay after the decay window', () => {
    recordModelFailure(cache, 'openrouter/foo:free');
    recordModelFailure(cache, 'openrouter/foo:free');
    expect(isUnhealthy(cache, 'openrouter/foo:free')).toBe(true);

    // Age the record past the decay window.
    (cache as any).model_health['openrouter/foo:free'].last_fail =
      Date.now() - HEALTH_DECAY_MS - 1000;

    expect(failureStreak(cache, 'openrouter/foo:free')).toBe(0);
    expect(isUnhealthy(cache, 'openrouter/foo:free')).toBe(false);
  });

  it('a failure after decay restarts the streak at 1, not where it left off', () => {
    recordModelFailure(cache, 'openrouter/foo:free');
    recordModelFailure(cache, 'openrouter/foo:free');
    recordModelFailure(cache, 'openrouter/foo:free');
    (cache as any).model_health['openrouter/foo:free'].last_fail =
      Date.now() - HEALTH_DECAY_MS - 1000;

    recordModelFailure(cache, 'openrouter/foo:free');
    expect(failureStreak(cache, 'openrouter/foo:free')).toBe(1);
  });

  it('tracks each ref independently', () => {
    recordModelFailure(cache, 'openrouter/a:free');
    recordModelFailure(cache, 'openrouter/a:free');
    expect(isUnhealthy(cache, 'openrouter/a:free')).toBe(true);
    expect(isUnhealthy(cache, 'openrouter/b:free')).toBe(false);
  });
});

describe('demoteUnhealthy', () => {
  it('leaves an all-healthy list untouched', () => {
    const refs = ['a/1', 'b/2', 'c/3'];
    expect(demoteUnhealthy(cache, refs)).toEqual(refs);
  });

  it('never drops a candidate', () => {
    const refs = ['openrouter/dead:free', 'mistral/works', 'ollama/local'];
    for (let i = 0; i < 5; i++) recordModelFailure(cache, 'openrouter/dead:free');
    const out = demoteUnhealthy(cache, refs);
    expect(out.slice().sort()).toEqual(refs.slice().sort());
  });

  it('moves the broken free model below the working one', () => {
    // The real scenario: nemotron:free outranks mistral-medium on GDPval but
    // returns empty_response every time.
    const ranked = ['openrouter/nemotron:free', 'mistral/mistral-medium-2604'];
    for (let i = 0; i < 3; i++) recordModelFailure(cache, 'openrouter/nemotron:free');

    const out = demoteUnhealthy(cache, ranked);
    expect(out[0]).toBe('mistral/mistral-medium-2604');
    expect(out[1]).toBe('openrouter/nemotron:free');
  });

  it('preserves quality order among healthy models', () => {
    const ranked = ['best/a', 'mid/b', 'low/c', 'broken/d'];
    for (let i = 0; i < 3; i++) recordModelFailure(cache, 'broken/d');
    expect(demoteUnhealthy(cache, ranked)).toEqual(['best/a', 'mid/b', 'low/c', 'broken/d']);
  });

  it('orders demoted models by fewest failures first', () => {
    const ranked = ['x/worst', 'y/bad'];
    for (let i = 0; i < 6; i++) recordModelFailure(cache, 'x/worst');
    for (let i = 0; i < 2; i++) recordModelFailure(cache, 'y/bad');
    expect(demoteUnhealthy(cache, ranked)).toEqual(['y/bad', 'x/worst']);
  });

  it('a recovered model returns to the front', () => {
    const ranked = ['openrouter/nemotron:free', 'mistral/mistral-medium-2604'];
    for (let i = 0; i < 3; i++) recordModelFailure(cache, 'openrouter/nemotron:free');
    expect(demoteUnhealthy(cache, ranked)[0]).toBe('mistral/mistral-medium-2604');

    recordModelSuccess(cache, 'openrouter/nemotron:free');
    expect(demoteUnhealthy(cache, ranked)[0]).toBe('openrouter/nemotron:free');
  });
});
