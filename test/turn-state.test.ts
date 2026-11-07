// test/turn-state.test.ts
// src/turn-state.ts (docs/plans/2026-11-07-session-keyed-turn-state.md): the
// bounded per-session store, the ambient session scope, the live-context
// fallback and the Router's per-session turn fields. The wiring through the
// extension (events, streams, shutdown) is pinned in
// session-keyed-turn-state.test.ts.

import { describe, it, expect } from 'vitest';
import {
  currentSessionId,
  DEFAULT_MAX_SESSIONS,
  emptyTurnState,
  LiveSessionContexts,
  runInSession,
  SessionStore,
  sessionIdOf,
} from '../src/turn-state.ts';
import { Router } from '../src/routing.ts';

describe('SessionStore', () => {
  it('gives every session its own state and returns the same object on a repeat lookup', () => {
    const store = new SessionStore(emptyTurnState);
    store.forSession('a').curModel = 'x/one';
    expect(store.forSession('a').curModel).toBe('x/one');
    expect(store.forSession('b').curModel).toBe('');
    expect(store.forSession('a')).toBe(store.forSession('a'));
  });

  it('reset forgets only the named session', () => {
    const store = new SessionStore(emptyTurnState);
    store.forSession('a').lastDynamicModel = 'x/one';
    store.forSession('b').lastDynamicModel = 'x/two';
    store.reset('a');
    expect(store.forSession('a').lastDynamicModel).toBe('');
    expect(store.forSession('b').lastDynamicModel).toBe('x/two');
  });

  it('evicts the least recently used session past the cap, not the oldest-created one', () => {
    const store = new SessionStore(emptyTurnState, 3);
    store.forSession('a').curModel = 'A';
    store.forSession('b').curModel = 'B';
    store.forSession('c').curModel = 'C';
    store.forSession('a'); // touch: b is now the least recently used
    store.forSession('d').curModel = 'D';
    expect(store.size).toBe(3);
    expect(store.forSession('a').curModel).toBe('A');
    expect(store.forSession('c').curModel).toBe('C');
    expect(store.forSession('b').curModel).toBe(''); // evicted, recreated empty
  });

  it('default cap is 64 sessions', () => {
    expect(DEFAULT_MAX_SESSIONS).toBe(64);
    const store = new SessionStore(emptyTurnState);
    for (let i = 0; i < 100; i++) store.forSession(`s${i}`);
    expect(store.size).toBe(64);
  });
});

describe('runInSession / currentSessionId', () => {
  it('is empty outside any scope and inside a scope without an id', () => {
    expect(currentSessionId()).toBe('');
    runInSession(undefined, () => expect(currentSessionId()).toBe(''));
  });

  it('nests, restores, and keeps the ambient session when no id is given', () => {
    runInSession('outer', () => {
      expect(currentSessionId()).toBe('outer');
      runInSession('inner', () => expect(currentSessionId()).toBe('inner'));
      runInSession(undefined, () => expect(currentSessionId()).toBe('outer'));
      expect(currentSessionId()).toBe('outer');
    });
    expect(currentSessionId()).toBe('');
  });

  it('keeps concurrent async chains apart', async () => {
    const seen: Record<string, string[]> = { a: [], b: [] };
    const chain = (id: string): Promise<void> =>
      runInSession(id, async () => {
        for (let i = 0; i < 3; i++) {
          await new Promise((r) => setTimeout(r, id === 'a' ? 1 : 2));
          seen[id].push(currentSessionId());
        }
      });
    await Promise.all([chain('a'), chain('b')]);
    expect(seen.a).toEqual(['a', 'a', 'a']);
    expect(seen.b).toEqual(['b', 'b', 'b']);
  });
});

describe('sessionIdOf', () => {
  it('reads the id of a Pi context and tolerates partial ones', () => {
    expect(sessionIdOf({ sessionManager: { getSessionId: () => 's1' } })).toBe('s1');
    expect(sessionIdOf({})).toBeUndefined();
    expect(sessionIdOf(undefined)).toBeUndefined();
    expect(sessionIdOf({ sessionManager: { getSessionId: () => '' } })).toBeUndefined();
    expect(sessionIdOf({ sessionManager: { getSessionId: () => 42 } })).toBeUndefined();
  });
});

describe('LiveSessionContexts', () => {
  it('falls back to the latest remaining context when a session ends, null when none is left', () => {
    const live = new LiveSessionContexts<string>();
    live.start('parent', 'P');
    live.start('child', 'C');
    expect(live.end('child')).toBe('P'); // the child's shutdown leaves the parent usable
    expect(live.end('parent')).toBeNull();
  });

  it('a restarted session becomes the most recent one', () => {
    const live = new LiveSessionContexts<string>();
    live.start('a', 'A');
    live.start('b', 'B');
    live.start('a', 'A2');
    expect(live.end('a')).toBe('B');
  });

  it('is bounded', () => {
    const live = new LiveSessionContexts<number>(2);
    live.start('a', 1);
    live.start('b', 2);
    live.start('c', 3);
    expect(live.end('c')).toBe(2);
    expect(live.end('b')).toBeNull(); // 'a' was evicted
  });
});

describe('Router turn fields are per session', () => {
  const makeRouter = (): Router => new Router({ model_groups: {} } as any, {} as any, new Map());

  it('keeps the driving-model pin, the factual ref and the group of each session apart', () => {
    const router = makeRouter();
    runInSession('parent', () => {
      router.noteTurnStart(1000);
      router.setActiveGroup('planning');
      router.setCurModel('prov/strong');
    });
    runInSession('child', () => {
      router.noteTurnStart(1000);
      router.setActiveGroup('simple');
      router.setCurModel('prov/cheap');
    });
    runInSession('parent', () => {
      expect(router.getCurModel()).toBe('prov/strong');
      expect(router.getTurnDriverRef()).toBe('prov/strong');
      expect(router.getActiveGroup()).toBe('planning');
    });
    runInSession('child', () => {
      expect(router.getCurModel()).toBe('prov/cheap');
      expect(router.getTurnDriverRef()).toBe('prov/cheap');
      expect(router.getActiveGroup()).toBe('simple');
    });
  });

  it('a Router built on the same store sees the state (a replacement drops nothing)', () => {
    const store = new SessionStore(() => ({
      activeGroup: null as string | null,
      curModel: '',
      curModelAt: 0,
      turnDriverRef: '',
      turnDriverAt: 0,
      turnBoundaryAt: 0,
    }));
    const before = new Router({ model_groups: {} } as any, {} as any, new Map(), store);
    runInSession('s', () => {
      before.noteTurnStart(500);
      before.setCurModel('prov/driver');
    });
    const after = new Router({ model_groups: {} } as any, {} as any, new Map(), store);
    runInSession('s', () => {
      expect(after.getTurnDriverRef(500)).toBe('prov/driver');
      expect(after.getCurModel(500)).toBe('prov/driver');
    });
  });
});
