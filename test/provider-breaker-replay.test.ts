// test/provider-breaker-replay.test.ts
// Phase 4 replay validation of the provider circuit breaker plan
// (docs/plans/2026-10-06-provider-circuit-breaker.md): the sanitized,
// bounded excerpts of the REAL failure events from ~/.pi/logs/router.log
// (test/fixtures/provider-breaker-replay/, extracted with
// scripts/provider-breaker-replay.ts --extract) replayed through the real
// module — no live provider. The plan's gate:
//   - NO trip on the Mistral 400/422 days (per-model request/shape errors
//     are not a wedge — six distinct mistral models failing 422 in 12 s
//     must not open anything);
//   - trips on every bridge cascade (several distinct claude-bridge models
//     returning empty responses in one short window), with the failures
//     AFTER the trip counted as avoided hops (the intra-walk short-circuit).
//
// Validation status per AGENTS.md §4: this is the plan's VALIDATION
// harness, not a bugfix regression — the module under test shipped in
// Phase 1. The no-trip half guards the D1 evidence filter, whose red
// evidence is Phase 1's (test/provider-breaker.test.ts, false-positive
// class) plus Phase 2's naive-intermediate red (cases 3/4 of
// test/provider-breaker-orchestration.test.ts).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  recordProviderFailure,
  recordProviderSuccess,
  isProviderOpen,
} from '../src/provider-breaker.ts';
import type { Cache } from '../src/types.ts';

interface FixtureEvent {
  ts: number;
  ref: string;
  kind?: string;
  detail?: string;
  ok?: boolean;
}

interface Fixture {
  description: string;
  events: FixtureEvent[];
}

function loadFixture(name: string): Fixture {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'provider-breaker-replay');
  return JSON.parse(readFileSync(path.join(dir, name), 'utf-8')) as Fixture;
}

/**
 * Replays one fixture through the real breaker with the events' own
 * timestamps (injected clock). Returns the trips (provider, at) and how
 * many failures landed inside an already-open window of their provider —
 * the hops the pre-flight skip would have avoided.
 */
function replay(fixture: Fixture): { trips: { provider: string; at: number }[]; avoidedHops: number } {
  const cache: Cache = {};
  const trips: { provider: string; at: number }[] = [];
  let avoidedHops = 0;
  for (const ev of fixture.events) {
    if (ev.ok) {
      recordProviderSuccess(cache, ev.ref);
      continue;
    }
    if (isProviderOpen(cache, ev.ref.split('/')[0], ev.ts)) avoidedHops++;
    if (recordProviderFailure(cache, ev.ref, ev.kind as never, ev.detail, ev.ts)) {
      trips.push({ provider: ev.ref.split('/')[0], at: ev.ts });
    }
  }
  return { trips, avoidedHops };
}

describe('provider-breaker replay of the real router.log windows (plan Phase 4 gate)', () => {
  it('the 2026-09-27 Mistral 422 wave does NOT trip: six distinct models, per-model shape errors', () => {
    const fixture = loadFixture('mistral-422-wave-2026-09-27.json');
    const { trips } = replay(fixture);
    expect(trips).toEqual([]);
    // Two claude-bridge empties are real evidence but stay below the cloud
    // threshold (N=3): one flaky model is never a wedge.
    const cache: Cache = {};
    for (const ev of fixture.events.filter((e) => e.kind)) {
      recordProviderFailure(cache, ev.ref, ev.kind as never, ev.detail, ev.ts);
    }
    expect(isProviderOpen(cache, 'mistral', fixture.events[fixture.events.length - 1].ts)).toBe(false);
    expect(isProviderOpen(cache, 'claude-bridge', fixture.events[fixture.events.length - 1].ts)).toBe(false);
  });

  it('the 2026-10-04 08:31 bridge cascade trips on the third distinct model and skips the rest of the walk', () => {
    const fixture = loadFixture('bridge-wedge-cascade-2026-10-04.json');
    const { trips, avoidedHops } = replay(fixture);
    expect(trips).toHaveLength(1);
    expect(trips[0].provider).toBe('claude-bridge');
    // The trip fires when the THIRD distinct bridge model fails; the fourth
    // and fifth (same walk, 1-3 ms later) land inside the open window —
    // exactly the hops the intra-walk short-circuit saves.
    expect(avoidedHops).toBeGreaterThanOrEqual(1);
    // Mistral's 'terminated' and the 400 invalid-model error are not
    // evidence: mistral never trips in this window either.
    expect(trips.every((t) => t.provider === 'claude-bridge')).toBe(true);
  });

  it('the 2026-10-06 08:03 bridge burst trips and saves the three remaining bridge attempts', () => {
    const fixture = loadFixture('bridge-wedge-burst-2026-10-06.json');
    const { trips, avoidedHops } = replay(fixture);
    expect(trips).toHaveLength(1);
    expect(trips[0].provider).toBe('claude-bridge');
    expect(avoidedHops).toBe(3);
  });
});
