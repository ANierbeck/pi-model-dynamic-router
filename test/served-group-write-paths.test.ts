// Step 5 of docs/plans/2026-11-21-virtual-models-migration.md: every path
// that opens a stream names the walk's group (recordServedRef). The main
// walk is pinned end to end in test/serve-persists-group.test.ts; these pin
// the two dead-end paths that open a stream WITHOUT the main walk having
// opened one (the forced breaker probe and the cooldown collapse), and the
// sub-call guard (a delegation stream is the turn's tool work, not the
// session's served group). Walk level: ctx.activeGroup is the bridge to
// selectionState.write({ group }) in index.ts. The logger is not mocked: its
// files land in the per-file isolated home (test/setup/isolate-home.ts).
import { describe, it, expect, vi } from 'vitest';

import { walkStubWorld } from './helpers/walk-stub-ctx.ts';
import { runAsSubCall } from '../src/subcall-scope.ts';

const okRouter = (): Record<string, unknown> => ({
  setCurModel: vi.fn(),
  limitSecs: () => 999,
});

describe('the dead-end paths write the walk group', () => {
  it('the forced breaker probe', async () => {
    const w = walkStubWorld({
      breakerOpen: ['wedge/x-1'],
      ctxOverrides: {
        router: okRouter(),
        cache: {
          provider_breaker: {
            wedge: { open_until: Date.now() + 60_000, trip_count: 1, evidence: [] },
          },
        },
      },
    });
    await w.run(['wedge/x-1']);
    expect(
      w.attempts.map((a) => a.ref),
      'only the probe opened a stream'
    ).toEqual(['wedge/x-1']);
    expect(w.ctx.activeGroup).toBe('standard');
  });

  it('the cooldown collapse', async () => {
    const w = walkStubWorld({
      ctxOverrides: { router: okRouter(), isLimited: () => true },
    });
    await w.run(['cool/x-1']);
    expect(
      w.attempts.map((a) => a.ref),
      'only the collapse opened a stream'
    ).toEqual(['cool/x-1']);
    expect(w.ctx.activeGroup).toBe('standard');
  });
});

describe('a sub-call stream', () => {
  it('does not write the session group', async () => {
    const w = walkStubWorld({ ctxOverrides: { router: okRouter() } });
    await runAsSubCall(() => w.run(['sub/x-1']));
    expect(w.attempts.map((a) => a.ref)).toEqual(['sub/x-1']);
    expect(w.ctx.activeGroup).toBeUndefined();
  });
});
