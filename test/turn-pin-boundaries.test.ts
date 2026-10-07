// test/turn-pin-boundaries.test.ts — nightly R1 triage (2026-10-07),
// routing.ts Router turn-driver pin (noteTurnStart / setCurModel /
// adoptTurnDriverRef / getCurModel). The pin protects the expensive-model
// read block (test/expensive-model-read-block.test.ts covers the end-to-end
// story with real timestamps); the nightly found the BOUNDARY behavior
// unpinned because those tests never control the clock:
//
//   - the turn boundary only moves FORWARD (a late/stale noteTurnStart for
//     an older turn must not drag it back and freeze the pin)
//   - without any turn_start the very first ref of the session is pinned
//   - adoptTurnDriverRef('') carries nothing and must not wipe a live pin
//   - a stream ref set exactly AT the turn start belongs to that turn

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Router } from '../src/routing.ts';
import type { Config } from '../src/types.ts';

const mkRouter = () => new Router({ model_groups: {}, model_metrics: {}, providers: {} } as Config, {} as never, new Map() as never);

describe('Router turn pin — clock-controlled boundaries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(5000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the turn boundary never moves backwards: a stale older noteTurnStart is ignored', () => {
    const r = mkRouter();
    r.noteTurnStart(5000);
    r.setCurModel('prov/first'); // pinned at t=5000

    vi.setSystemTime(5100);
    r.noteTurnStart(5100); // the next turn begins
    r.noteTurnStart(5000); // a late call for the PREVIOUS turn must not lower the boundary

    vi.setSystemTime(5200);
    r.setCurModel('prov/second'); // first stream of the new turn → must re-pin
    expect(r.getTurnDriverRef(5100)).toBe('prov/second');
  });

  it('without any turn_start the very first ref of the session is pinned', () => {
    const r = mkRouter();
    r.setCurModel('prov/session-first');
    r.setCurModel('prov/nested');
    expect(r.getTurnDriverRef()).toBe('prov/session-first');
  });

  it('adoptTurnDriverRef("") does not wipe a live pin', () => {
    const r = mkRouter();
    r.setCurModel('prov/driver');
    r.adoptTurnDriverRef('');
    expect(r.getTurnDriverRef()).toBe('prov/driver');
  });

  it('a stream ref set exactly at the turn start belongs to that turn', () => {
    const r = mkRouter();
    r.noteTurnStart(5000);
    r.setCurModel('prov/at-start'); // Date.now() === 5000 === turnStart
    expect(r.getCurModel(5000)).toBe('prov/at-start');
    expect(r.getTurnDriverRef(5000)).toBe('prov/at-start');
  });

  it('a stream ref from before the turn start is stale for it', () => {
    const r = mkRouter();
    r.setCurModel('prov/previous-turn'); // t=5000
    expect(r.getCurModel(5001)).toBe('');
  });
});
