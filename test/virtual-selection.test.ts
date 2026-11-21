/**
 * The selection layer of the virtual-models migration (plan
 * docs/plans/2026-11-21-virtual-models-migration.md, step 2): `router/dynamic`
 * is the session's model, and its route() names the hidden group model that
 * dispatches the request — the pinned group, or the classifying group.
 */
import { describe, expect, it } from 'vitest';
import {
  createPinHandoff,
  createServedGroups,
  decideSelection,
  sessionGroupOf,
  dispatchGroupOf,
  VIRTUAL_MODEL_ID,
  VIRTUAL_PROVIDER,
} from '../src/virtual-selection.ts';

const groups = new Set(['dynamic', 'planning', 'code_complex', 'simple']);

describe('dispatchGroupOf', () => {
  it('is the dynamic group when it classifies', () => {
    expect(dispatchGroupOf({ simple: { method: 'static' }, dynamic: { method: 'dynamic' } })).toBe(
      'dynamic'
    );
  });

  it('is the first classifying group when the user renamed it', () => {
    expect(dispatchGroupOf({ simple: { method: 'static' }, auto: { method: 'dynamic' } })).toBe(
      'auto'
    );
  });

  it('is the first group when no group classifies', () => {
    expect(dispatchGroupOf({ simple: {}, planning: {} })).toBe('simple');
  });

  it('is null without groups', () => {
    expect(dispatchGroupOf({})).toBeNull();
  });
});

describe('decideSelection', () => {
  const base = { groupNames: groups, dispatchGroup: 'dynamic' };

  it('routes an unpinned request to the classifying group and keeps the state', () => {
    expect(
      decideSelection({ ...base, reason: 'user', state: undefined, pending: undefined })
    ).toEqual({ group: 'dynamic', state: undefined });
  });

  it('routes to the pinned group of the branch state', () => {
    for (const reason of ['user', 'continuation', 'retry', 'direct'] as const) {
      expect(
        decideSelection({ ...base, reason, state: { pin: 'planning' }, pending: undefined })
      ).toEqual({ group: 'planning', state: undefined });
    }
  });

  it('applies a pending pin and stores it', () => {
    expect(
      decideSelection({
        ...base,
        reason: 'continuation',
        state: undefined,
        pending: 'code_complex',
      })
    ).toEqual({ group: 'code_complex', state: { pin: 'code_complex' } });
  });

  it('a pending release (null) clears the pin', () => {
    expect(
      decideSelection({
        ...base,
        reason: 'continuation',
        state: { pin: 'planning' },
        pending: null,
      })
    ).toEqual({ group: 'dynamic', state: { pin: null } });
  });

  it('pinning the classifying group is the same as no pin', () => {
    expect(
      decideSelection({ ...base, reason: 'user', state: undefined, pending: 'dynamic' })
    ).toEqual({ group: 'dynamic', state: { pin: null } });
  });

  it('drops a pin whose group no longer exists', () => {
    expect(
      decideSelection({ ...base, reason: 'user', state: { pin: 'design' }, pending: undefined })
    ).toEqual({ group: 'dynamic', state: { pin: null } });
  });

  it('a direct request never changes the state (Pi ignores it there)', () => {
    expect(
      decideSelection({ ...base, reason: 'direct', state: { pin: 'design' }, pending: undefined })
    ).toEqual({ group: 'dynamic', state: undefined });
  });

  it('treats a malformed state as no pin', () => {
    expect(
      decideSelection({
        ...base,
        reason: 'user',
        state: { pin: 42 } as unknown as { pin: string },
        pending: undefined,
      })
    ).toEqual({ group: 'dynamic', state: { pin: null } });
  });
});

describe('createPinHandoff', () => {
  it('hands a pin to the next take of the same session only, once', () => {
    const h = createPinHandoff();
    h.set('s1', 'planning');
    expect(h.take('s2')).toBeUndefined();
    expect(h.take('s1')).toBe('planning');
    expect(h.take('s1')).toBeUndefined();
  });

  it('keeps a release (null) distinct from nothing pending', () => {
    const h = createPinHandoff();
    h.set('s1', null);
    expect(h.take('s1')).toBeNull();
  });

  it('ignores a missing session id', () => {
    const h = createPinHandoff();
    h.set(undefined, 'planning');
    expect(h.take(undefined)).toBeUndefined();
  });

  it('forgets a session’s pending pin unapplied (session_shutdown)', () => {
    const h = createPinHandoff();
    h.set('s1', 'planning');
    h.set('s2', 'simple');
    h.forget('s1');
    expect(h.take('s1')).toBeUndefined();
    expect(h.take('s2')).toBe('simple');
  });
});

describe('sessionGroupOf', () => {
  const GROUP_CFG = { dynamic: { method: 'dynamic' }, planning: { method: 'best' } };
  const VIRTUAL = { provider: VIRTUAL_PROVIDER, id: VIRTUAL_MODEL_ID };
  const stateEntry = (pin: string | null): unknown => ({
    type: 'custom',
    customType: 'pi.virtual-model-state',
    data: { provider: VIRTUAL_PROVIDER, modelId: VIRTUAL_MODEL_ID, state: { pin } },
  });
  const of = (opts: {
    served?: string;
    pending?: string | null;
    branch?: unknown[];
    model?: { provider: string; id: string };
  }): string | null => {
    const served = createServedGroups();
    if (opts.served) served.record('s', opts.served);
    const pins = createPinHandoff();
    if (opts.pending !== undefined) pins.set('s', opts.pending);
    return sessionGroupOf(opts.model ?? VIRTUAL, 's', GROUP_CFG, {
      served,
      pins,
      branch: opts.branch ?? [],
    });
  };

  // Review 2026-11-21 (re-review Minor 2): group models are provider === id.
  it('a concrete model whose id equals a group name is no group', () => {
    expect(of({ model: { provider: 'some-provider', id: 'planning' } })).toBeNull();
    expect(of({ model: { provider: 'planning', id: 'planning:use-static' } })).toBeNull();
  });

  // Review 2026-11-21 (re-review Minor 1): before the first request of a
  // resumed or migrated session nothing is served yet.
  it('before any request: the pending pin, then the branch’s stored pin', () => {
    expect(of({ pending: 'planning' })).toBe('planning');
    expect(of({ pending: null, branch: [stateEntry('planning')] })).toBe('dynamic');
    expect(of({ branch: [stateEntry('planning'), stateEntry(null)] })).toBe('dynamic');
    expect(of({ branch: [stateEntry(null), stateEntry('planning')] })).toBe('planning');
    expect(of({})).toBe('dynamic');
  });

  it('the served group wins, a stored pin of a removed group does not count', () => {
    expect(of({ served: 'planning', branch: [stateEntry(null)] })).toBe('planning');
    expect(of({ branch: [stateEntry('retired')] })).toBe('dynamic');
  });

  it('peeking leaves the pending pin for route()', () => {
    const pins = createPinHandoff();
    pins.set('s', 'planning');
    expect(pins.peek('s')).toBe('planning');
    expect(pins.take('s')).toBe('planning');
    expect(pins.peek('s')).toBeUndefined();
  });
});

describe('the virtual model ref', () => {
  it('is router/dynamic (owner decision 2026-11-21)', () => {
    expect(`${VIRTUAL_PROVIDER}/${VIRTUAL_MODEL_ID}`).toBe('router/dynamic');
  });
});
