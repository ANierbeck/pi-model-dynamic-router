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

/** Pi's custom entry type for the state route() returns (pi.virtual-model-state). */
const STATE_ENTRY = 'pi.virtual-model-state';

/**
 * The pin the branch stored last for `router/dynamic`: a group, null for
 * none, undefined when the branch stores no state (Pi's
 * getVirtualModelState, which extensions cannot import).
 */
export function branchPin(branch: readonly unknown[]): string | null | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as
      | { type?: unknown; customType?: unknown; data?: Record<string, unknown> }
      | undefined;
    if (entry?.type !== 'custom' || entry.customType !== STATE_ENTRY) continue;
    const data = entry.data;
    if (data?.provider !== VIRTUAL_PROVIDER || data.modelId !== VIRTUAL_MODEL_ID) continue;
    const pin = (data.state as { pin?: unknown } | undefined)?.pin;
    return typeof pin === 'string' ? pin : null;
  }
  return undefined;
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
    const pin = pending !== undefined ? pending : branchPin(sources.branch);
    return known(pin) ? pin : dispatchGroupOf(groups);
  }
  const group = model?.id;
  return known(group) && model?.provider === group ? group : null;
}
