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

/** Provider id of the virtual model (owner decision 2026-11-21). */
export const VIRTUAL_PROVIDER = 'router';
/** Model id of the virtual model. */
export const VIRTUAL_MODEL_ID = 'dynamic';

/** Why Pi routes a request (pi-coding-agent `ModelRouteReason`). */
export type SelectionReason = 'user' | 'continuation' | 'retry' | 'direct';

/** Router state on the session branch (Pi's `pi.virtual-model-state`). */
export interface SelectionState {
  /** The pinned group, or null when the classifying group decides. */
  readonly pin: string | null;
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
  return { group, state: changed ? { pin } : undefined };
}

/** Pins set by a tool during a turn, handed to the session's next route() call. */
export interface PinHandoff {
  set(sessionId: string | undefined, group: string | null): void;
  /** The pending pin of the session (and forget it), or undefined. */
  take(sessionId: string | undefined): string | null | undefined;
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
  };
}
