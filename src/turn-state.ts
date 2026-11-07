// Per-session turn state (docs/plans/2026-11-07-session-keyed-turn-state.md).
//
// The router used to keep its turn state in closure variables of the extension
// factory — one copy per PROCESS. pi-subagents runs child sessions in-process
// and every session_start rebuilds the router, so a child shared and overwrote
// the parent's turn model, group and inheritable category, and its
// session_shutdown could not be allowed to clear anything. The state now lives
// in a store keyed by Pi's session id.
//
// How the session id reaches the state: handlers and streams run inside
// `runInSession(id, fn)` (AsyncLocalStorage, the same mechanism as the sub-call
// scope in subcall-scope.ts), and the accessors in index.ts read the ambient
// session. Code that runs outside any scope — a unit test, a timer started with
// no session — gets the default entry under the empty key, which is exactly the
// old process-wide behaviour.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ClassificationResult } from './content-classifier.ts';

/** What one session remembers between turns. */
export interface TurnState {
  /** The ref pi currently shows for the session (the group ref in group sessions). */
  curModel: string;
  /** Group the session is routed through; null = none pinned. */
  activeGroup: string | null;
  /** Last concrete model that served a stream — the first candidate of a tool follow-up. */
  lastDynamicModel: string;
  /** Category of the previous classified turn, inherited by terse follow-ups. */
  lastClassifiedCategory: ClassificationResult['category'] | undefined;
  /** Start of the current turn (ms since epoch); 0 = no turn started. */
  turnStart: number;
}

/** Router-side per-session fields (the driving-model pin and the factual ref). */
export interface RouterTurnState {
  activeGroup: string | null;
  curModel: string;
  curModelAt: number;
  turnDriverRef: string;
  turnDriverAt: number;
  turnBoundaryAt: number;
}

/**
 * A long-lived process sees many sessions; entries are dropped on
 * session_shutdown and the oldest one goes when a session never shut down
 * cleanly (killed child, crashed run) — so the map cannot leak.
 */
export const DEFAULT_MAX_SESSIONS = 64;

/** Bounded least-recently-used map from session id to its state. */
export class SessionStore<T> {
  private readonly entries = new Map<string, T>();

  constructor(
    private readonly create: () => T,
    private readonly maxSessions: number = DEFAULT_MAX_SESSIONS
  ) {}

  /** The session's state, created on first use; a hit marks it most recently used. */
  forSession(id: string): T {
    const existing = this.entries.get(id);
    if (existing !== undefined) {
      this.entries.delete(id);
      this.entries.set(id, existing);
      return existing;
    }
    const fresh = this.create();
    this.entries.set(id, fresh);
    if (this.entries.size > this.maxSessions) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return fresh;
  }

  /** Forget one session (its session_shutdown). Other sessions are untouched. */
  reset(id: string): void {
    this.entries.delete(id);
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * The Pi ExtensionContext of every session that started and has not shut down.
 * The router keeps ONE "current" context (registry access for group
 * resolution) — the one of the most recently started session. When a session
 * ends, the context falls back to the latest one still alive instead of null:
 * a subagent's shutdown must not take the parent's model registry with it.
 */
export class LiveSessionContexts<C> {
  private readonly live = new Map<string, C>();

  constructor(private readonly maxSessions: number = DEFAULT_MAX_SESSIONS) {}

  /** A session started: it becomes the most recent one. */
  start(id: string, ctx: C): void {
    this.live.delete(id);
    this.live.set(id, ctx);
    if (this.live.size > this.maxSessions) {
      const oldest = this.live.keys().next().value;
      if (oldest !== undefined) this.live.delete(oldest);
    }
  }

  /** A session ended; returns the context the router should use now (null = none left). */
  end(id: string): C | null {
    this.live.delete(id);
    let latest: C | null = null;
    for (const ctx of this.live.values()) latest = ctx;
    return latest;
  }
}

export function emptyTurnState(): TurnState {
  return {
    curModel: '',
    activeGroup: null,
    lastDynamicModel: '',
    lastClassifiedCategory: undefined,
    turnStart: 0,
  };
}

export function emptyRouterTurnState(): RouterTurnState {
  return {
    activeGroup: null,
    curModel: '',
    curModelAt: 0,
    turnDriverRef: '',
    turnDriverAt: 0,
    turnBoundaryAt: 0,
  };
}

const sessionScope = new AsyncLocalStorage<string>();

/**
 * Run `fn` for session `id`. Without an id the ambient session is kept — a
 * stream opened inside a handler without its own `sessionId` stays in the
 * handler's session instead of dropping to the default entry.
 */
export function runInSession<R>(id: string | undefined | null, fn: () => R): R {
  if (!id) return fn();
  return sessionScope.run(id, fn);
}

/** The session the current async chain runs for; '' = none (the default entry). */
export function currentSessionId(): string {
  return sessionScope.getStore() ?? '';
}

/** Session id of a Pi extension context, tolerant of the partial ctx objects tests pass. */
export function sessionIdOf(ctx: unknown): string | undefined {
  const manager = (ctx as { sessionManager?: { getSessionId?: () => unknown } } | null | undefined)
    ?.sessionManager;
  const id = manager?.getSessionId?.();
  return typeof id === 'string' && id ? id : undefined;
}
