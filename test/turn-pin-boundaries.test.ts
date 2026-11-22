// test/turn-pin-boundaries.test.ts — nightly R1 triage (2026-10-07),
// routing.ts Router turn-driver pin (noteTurnStart / setCurModel /
// getCurModel). The pin protects the expensive-model
// read block (test/expensive-model-read-block.test.ts covers the end-to-end
// story with real timestamps); the nightly found the BOUNDARY behavior
// unpinned because those tests never control the clock:
//
//   - the turn boundary only moves FORWARD (a late/stale noteTurnStart for
//     an older turn must not drag it back and freeze the pin)
//   - without any turn_start the very first ref of the session is pinned
//   - a stream ref set exactly AT the turn start belongs to that turn

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Router } from '../src/routing.ts';
import type { Config } from '../src/types.ts';
import { SessionStore, emptyRouterTurnState } from '../src/turn-state.ts';

const mkRouter = () =>
  new Router(
    { model_groups: {}, model_metrics: {}, providers: {} } as Config,
    {} as never,
    new Map() as never
  );

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

// load() replaces the Router on every session_start and from tools
// (resolve_model_group, update_model_metrics) — subagent sessions share it
// while a parent turn is still running. The turn's driving-model pin lives in
// the per-session store index.ts hands every Router, so the rebuild keeps it.
// Moved here from test/delegation.test.ts, whose end-to-end version drove the
// pin through set_model_from_group: the tool no longer sets the driver (the
// virtual-models migration pins a group instead), and that test passed
// without the tool call even before the migration.
describe('Router turn pin — survives the Router rebuild of load()', () => {
  const cfg = { model_groups: {}, model_metrics: {}, providers: {} } as Config;

  it('a Router built on the same store keeps the turn driver and boundary', () => {
    const store = new SessionStore(emptyRouterTurnState);
    const before = new Router(cfg, {} as never, new Map() as never, store);
    before.noteTurnStart(Date.now());
    before.setCurModel('pi-claude/claude-sonnet-5'); // the turn's driver
    const after = new Router(cfg, {} as never, new Map() as never, store);
    after.setCurModel('mistral/cheap-bulk-reader'); // a nested delegation stream
    expect(after.getTurnDriverRef()).toBe('pi-claude/claude-sonnet-5');
  });
});
