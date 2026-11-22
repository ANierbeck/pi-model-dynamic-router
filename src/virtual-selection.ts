/**
 * The selection layer (plan docs/plans/2026-11-21-virtual-models-migration.md,
 * step 2): the session's model is one Pi virtual model, `router/dynamic`.
 * Its route() names the hidden group model that dispatches the request: the
 * group the branch pinned, otherwise the classifying group, whose
 * groupStream classifies exactly as before. Failover, waits, breaker and
 * narration stay in the group provider (driveStream).
 *
 * Pure decisions only; src/virtual-model.ts wires them to Pi.
 */

import { VALID_CATEGORIES } from './classification-prompt.ts';
import { debugLog } from './logger.ts';
import { textOf } from './utils.ts';

/** Provider id of the virtual model (owner decision 2026-11-21). */
export const VIRTUAL_PROVIDER = 'router';
/** Model id of the virtual model. */
export const VIRTUAL_MODEL_ID = 'dynamic';

/** Why Pi routes a request (pi-coding-agent `ModelRouteReason`). */
export type SelectionReason = 'user' | 'continuation' | 'retry' | 'direct';

/** Pi's custom entry type for the state route() returns (pi.virtual-model-state). */
export const STATE_ENTRY = 'pi.virtual-model-state';

/**
 * Router state on the session branch (Pi's `pi.virtual-model-state`). Step 3
 * of the migration plan stores more than the pin here, so a fork and a /tree
 * jump see their own branch's values and a restart keeps them. `runGroup` is
 * the current tool follow-up run's group, `lastCategory` the previous turn's
 * classified category (inherited by terse follow-ups).
 *
 * `group` is the group whose candidate walk last opened a stream on this
 * branch (the classified or pinned group; after an all-failed walk, the
 * fallback group the cascade walked), written by the orchestrator's
 * recordServedRef (step 5, owner decision 2026-11-21). The
 * per-group compaction budget and the decision log's previous-turn group read
 * it, so both survive a restart; `model_select` clears it to null. It is not
 * route()'s dispatch group (`router/dynamic` dispatches to `dynamic` unless
 * pinned): that one lives per process in `ServedGroups`.
 */
export interface SelectionState {
  /** The pinned group, or null when the classifying group decides. */
  readonly pin: string | null;
  /** The group that last served a stream on this branch — see above. */
  readonly group?: string | null | undefined;
  readonly runGroup?: string | null | undefined;
  readonly lastCategory?: string | undefined;
}

function strOrNull(v: unknown): string | null | undefined {
  return typeof v === 'string' ? v : v === null ? null : undefined;
}
// Hint categories are never persisted (a processed hint has no `category`
// field), so the taxonomy list IS the complete set of valid stored values.
function isKnownCategory(v: unknown): string | undefined {
  return typeof v === 'string' && (VALID_CATEGORIES as readonly string[]).includes(v)
    ? v
    : undefined;
}

function storedStateEntry(branch: readonly unknown[]): Record<string, unknown> | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as
      | { type?: unknown; customType?: unknown; data?: Record<string, unknown> }
      | undefined;
    if (entry?.type !== 'custom' || entry.customType !== STATE_ENTRY) continue;
    const data = entry.data;
    if (data?.provider !== VIRTUAL_PROVIDER || data.modelId !== VIRTUAL_MODEL_ID) continue;
    // A non-object state Pi or an older router wrote is skipped, not trusted.
    if (typeof (data.state as Record<string, unknown>) !== 'object' || data.state === null)
      continue;
    return data.state as Record<string, unknown>;
  }
  return undefined;
}

/**
 * The full state the branch stores last for `router/dynamic`, or undefined
 * when the branch stores no state (Pi's getVirtualModelState, which
 * extensions cannot import). Tolerant: garbage entries are skipped.
 */
export function branchState(branch: readonly unknown[]): SelectionState | undefined {
  const s = storedStateEntry(branch);
  if (!s) return undefined;
  const pin = strOrNull(s.pin);
  if (pin === undefined) return undefined; // no usable pin field: treat as no state
  return {
    pin,
    group: strOrNull(s.group),
    runGroup: strOrNull(s.runGroup),
    // The stored value is untrusted JSON: an entry outside the taxonomy
    // (hand-edited file, future router) reads back undefined, exactly like
    // the other garbage this scan skips (review step-3 round 1, Minor 1).
    lastCategory: isKnownCategory(s.lastCategory),
  };
}

/**
 * The complete state after one field changes: unmentioned fields pass
 * through, `pin` is normalized. Every writer stores the WHOLE state, because
 * a state write replaces the branch's last entry.
 */
export function foldSelectionState(
  current: SelectionState | undefined,
  partial: Partial<SelectionState>
): SelectionState {
  // An ABSENT field passes the stored value through; an explicit null is a
  // deliberate CLEAR (a ?? would fall through on the null and re-graft the
  // stored value — exactly the leak the field semantics must not have).
  const pass = <T extends string | null | undefined>(incoming: T | undefined, stored: T): T =>
    // Not ?? — an explicit null in the partial is a deliberate CLEAR and must
    // not fall through to the stored value.
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    incoming === undefined ? stored : incoming;
  return {
    pin: pass(partial.pin, current?.pin ?? null),
    group: pass(partial.group, current?.group),
    runGroup: pass(partial.runGroup, current?.runGroup),
    lastCategory: pass(partial.lastCategory, current?.lastCategory),
  };
}

/** An append-only sink for the branch state (index.ts wires the SessionManager). */
export interface SelectionStateSink {
  appendState(state: SelectionState): void;
}

/**
 * Read/write access to the session's branch state, memoized by the branch's
 * leaf id (a /tree jump changes the leaf, so the memo cannot serve a stale
 * branch). io must resolve the AMBIENT session's manager — liveSessions,
 * not the latest-started ctx.
 */
export function createSelectionStateSource(io: {
  branch(): readonly unknown[];
  leafId(): string | undefined;
  appendState(state: SelectionState): void;
}): {
  read(): SelectionState | undefined;
  write(partial: Partial<Omit<SelectionState, 'pin'>>): void;
  beginBatch(): void;
  endBatch(): void;
} {
  let memoLeaf: string | undefined;
  let memoHasRead = false;
  let memoState: SelectionState | undefined;
  // Write batching (step 5, live-phase follow-up 2026-11-21): the writes of
  // one stream (run group at open, category after classification, group at
  // serve) fold into ONE branch entry at the outermost end. One source serves
  // one session, so one pending buffer is enough. The ends are unconditional
  // (driveStream's finally), so a batch cannot stay open.
  let batchDepth = 0;
  // Set by write() inside an open batch: the folded state not yet appended.
  let pending: SelectionState | undefined;
  const persist = (state: SelectionState): void => {
    try {
      io.appendState(state);
    } catch (err) {
      // Same contract as write(): a throw is a real persistence failure, and
      // it is logged. It must not escape here: flush runs in the stream path's
      // finally (driveStream), where an exception would break the stream.
      debugLog(`[selection] branch state not persisted: ${textOf(err)}`);
    }
  };
  const flush = (): void => {
    if (!pending) return;
    const state = pending;
    pending = undefined;
    // The append moves the leaf: the memo must re-read, not serve the value
    // it buffered (the pre-append branch read is outdated).
    memoHasRead = false;
    persist(state);
  };
  return {
    /**
     * Batch the writes of one walk into a single branch entry: the walk's
     * writes (run group at open, category after classification, group at
     * serve) each change the state, and appending one entry per write would
     * add a branch entry per tool step. Writes inside an open batch fold
     * into the in-memory state (reads see the folded value immediately) and
     * land as ONE entry at the outermost end. begin/end nest: a fallback or
     * retry walk started inside the outer walk joins its batch, it does not
     * split it.
     */
    beginBatch(): void {
      batchDepth += 1;
    },
    endBatch(): void {
      if (batchDepth === 0) return;
      batchDepth -= 1;
      if (batchDepth === 0) flush();
    },
    read(): SelectionState | undefined {
      // The open batch's folded state is the truth until its flush. Checked
      // first: an empty branch has no leaf id to key the memo by, and the
      // folded writes would otherwise be lost to a re-read of the branch.
      if (pending !== undefined) return pending;
      const leaf = io.leafId();
      // An unknown leaf (empty branch, or a manager without getLeafId) is no
      // memo key — re-read, never serve a cache entry from another branch.
      if (leaf === undefined) return branchState(io.branch());
      if (!memoHasRead || leaf !== memoLeaf) {
        memoLeaf = leaf;
        memoState = branchState(io.branch());
        memoHasRead = true;
      }
      return memoState;
    },
    write(partial): void {
      try {
        const current = this.read();
        const next = foldSelectionState(current, partial);
        // Every served stream writes the group (step 5) and every turn the
        // run group / category: an unchanged state appends nothing, or each
        // tool step and failover hop would grow the session file.
        if (current !== undefined && sameSelectionState(current, next)) return;
        if (batchDepth > 0) {
          // Buffered for the batch flush; read() sees it until then.
          pending = next;
          return;
        }
        persist(next);
      } catch (err) {
        // The io seam no-ops quietly itself when no manager is in scope
        // (plain process code); a THROW is a real persistence failure —
        // logged, so step 3's "a restart keeps it" cannot fail silently
        // (review step-3 round 1, Important 2).
        debugLog(`[selection] branch state not persisted: ${textOf(err)}`);
      }
    },
  };
}

function sameSelectionState(a: SelectionState, b: SelectionState): boolean {
  return (
    a.pin === b.pin &&
    a.group === b.group &&
    a.runGroup === b.runGroup &&
    a.lastCategory === b.lastCategory
  );
}

/** A group config as far as the selection reads it. */
interface GroupLike {
  readonly method?: string;
}

/**
 * The group an unpinned request goes to: `dynamic` when it classifies, else
 * the first classifying group (a user may rename it), else the first group.
 */
export function dispatchGroupOf(groups: Readonly<Record<string, GroupLike>>): string | null {
  const names = Object.keys(groups);
  if (groups.dynamic?.method === 'dynamic') return 'dynamic';
  return names.find((name) => groups[name]?.method === 'dynamic') ?? names[0] ?? null;
}

export interface SelectionInput {
  readonly reason: SelectionReason;
  /** The branch's state as Pi hands it to route(); untrusted JSON. */
  readonly state: SelectionState | undefined;
  /**
   * A pin set since the last route() call of this session (the
   * `set_model_from_group` tool): a group, null to release, undefined for
   * none. Callers must not take it for `direct` requests, whose state Pi
   * ignores.
   */
  readonly pending: string | null | undefined;
  readonly groupNames: ReadonlySet<string>;
  readonly dispatchGroup: string;
}

export interface SelectionDecision {
  /** The group whose model route() returns. */
  readonly group: string;
  /** New state for the branch, or undefined to keep it. */
  readonly state: SelectionState | undefined;
}

function storedPin(state: SelectionState | undefined): string | null {
  const pin = (state as { pin?: unknown } | undefined)?.pin;
  return typeof pin === 'string' ? pin : null;
}

/** Decide one request: the dispatching group and the branch state after it. */
export function decideSelection(input: SelectionInput): SelectionDecision {
  const { reason, state, pending, groupNames, dispatchGroup } = input;
  const stored = storedPin(state);
  const wanted = pending !== undefined ? pending : stored;
  // A pin of the classifying group is no pin; a pin of a group the config no
  // longer has falls back to classification instead of failing the request.
  const pin = wanted !== null && wanted !== dispatchGroup && groupNames.has(wanted) ? wanted : null;
  const group = pin ?? dispatchGroup;
  if (reason === 'direct') return { group, state: undefined };
  const malformed = state !== undefined && (state as { pin?: unknown }).pin !== stored;
  const changed = pending !== undefined || pin !== stored || malformed;
  // Step 3: a state write replaces the branch's last entry, so it carries the
  // OTHER stored fields too (group / runGroup / lastCategory).
  return { group, state: changed ? foldSelectionState(state, { pin }) : undefined };
}

/** Pins set by a tool during a turn, handed to the session's next route() call. */
export interface PinHandoff {
  set(sessionId: string | undefined, group: string | null): void;
  /** The pending pin of the session (and forget it), or undefined. */
  take(sessionId: string | undefined): string | null | undefined;
  /** The pending pin of the session, left in place (display), or undefined. */
  peek(sessionId: string | undefined): string | null | undefined;
  /** Drop the session's pending pin unapplied (session_shutdown). */
  forget(sessionId: string | undefined): void;
}

export function createPinHandoff(): PinHandoff {
  const pending = new Map<string, string | null>();
  return {
    set(sessionId: string | undefined, group: string | null): void {
      if (sessionId !== undefined) pending.set(sessionId, group);
    },
    take(sessionId: string | undefined): string | null | undefined {
      if (sessionId === undefined || !pending.has(sessionId)) return undefined;
      const pin = pending.get(sessionId) ?? null;
      pending.delete(sessionId);
      return pin;
    },
    peek(sessionId: string | undefined): string | null | undefined {
      if (sessionId === undefined || !pending.has(sessionId)) return undefined;
      return pending.get(sessionId) ?? null;
    },
    forget(sessionId: string | undefined): void {
      if (sessionId !== undefined) pending.delete(sessionId);
    },
  };
}

/**
 * The group route() last dispatched each session to. ctx.model stays
 * `router/dynamic`, so this is what the footer names as the session's group.
 */
export interface ServedGroups {
  record(sessionId: string | undefined, group: string): void;
  get(sessionId: string | undefined): string | undefined;
  forget(sessionId: string | undefined): void;
}

export function createServedGroups(): ServedGroups {
  const served = new Map<string, string>();
  return {
    record(sessionId: string | undefined, group: string): void {
      if (sessionId !== undefined) served.set(sessionId, group);
    },
    get(sessionId: string | undefined): string | undefined {
      return sessionId === undefined ? undefined : served.get(sessionId);
    },
    forget(sessionId: string | undefined): void {
      if (sessionId !== undefined) served.delete(sessionId);
    },
  };
}

/**
 * The pin the branch stored last for `router/dynamic`: a group, null for
 * none, undefined when the branch stores no state (Pi's
 * getVirtualModelState, which extensions cannot import).
 */
export function branchPin(branch: readonly unknown[]): string | null | undefined {
  return branchState(branch)?.pin;
}

/** Where sessionGroupOf looks for the group of a session on `router/dynamic`. */
export interface SessionGroupSources {
  readonly served: Pick<ServedGroups, 'get'>;
  readonly pins: Pick<PinHandoff, 'peek'>;
  /** The session's current branch (ctx.sessionManager.getBranch()). */
  readonly branch: readonly unknown[];
}

/**
 * The group a session is on. On `router/dynamic`: the group route() last
 * dispatched it to on this branch; before the first request (a resume, a
 * migration, a /tree jump), the pin the next route() will apply — the
 * pending one, else the branch's stored one — and without either the
 * classifying group. On a group model (provider === group): that group.
 * On a concrete model: none. The footer and the
 * /router overview both name it.
 */
export function sessionGroupOf(
  model: { provider?: string; id?: string } | undefined,
  sessionId: string | undefined,
  groups: Readonly<Record<string, GroupLike>>,
  sources: SessionGroupSources
): string | null {
  const known = (g: string | null | undefined): g is string =>
    typeof g === 'string' && Object.prototype.hasOwnProperty.call(groups, g);
  if (model?.provider === VIRTUAL_PROVIDER && model?.id === VIRTUAL_MODEL_ID) {
    const served = sources.served.get(sessionId);
    if (known(served)) return served;
    const pending = sources.pins.peek(sessionId);
    // A pending pin (applied by the next route()) decides, INCLUDING a
    // pending null — that is a release, it beats the stored values.
    if (pending !== undefined) return known(pending) ? pending : dispatchGroupOf(groups);
    // The state persisted on THIS branch (step 3) — survives a restart, and a
    // /tree jump reads the jumped-to branch.
    const st = branchState(sources.branch);
    if (known(st?.group)) return st.group;
    if (known(st?.pin)) return st.pin;
    return dispatchGroupOf(groups);
  }
  const group = model?.id;
  return known(group) && model?.provider === group ? group : null;
}
