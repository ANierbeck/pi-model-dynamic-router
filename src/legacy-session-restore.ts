/**
 * Old sessions (before the virtual-models migration, plan
 * docs/plans/2026-11-21-virtual-models-migration.md step 2): the selection
 * was a group model, whose `model_change` only outlived the assistant
 * messages after it when the model it names is a Pi virtual model
 * (`api: "pi-virtual"`) — so `pi --continue` / `/resume` / `/fork` landed on
 * the physical model that answered last. At session_start, restore the
 * virtual selection: re-select `router/dynamic` (Pi rewrites the branch's
 * last selection) and pin the group the old branch had selected.
 */
/** A model as Pi names it: provider + id. */
export interface ModelRefLike {
  readonly provider: string;
  readonly id: string;
}

/** A group model a pre-migration branch selected: a `model_change`'s ref. */
export interface GroupSelection {
  readonly provider: string;
  readonly modelId: string;
}

/** Field access on Pi's untyped session entries. */
function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** API id of Pi's virtual catalog models (pi-coding-agent `VIRTUAL_MODEL_API`). */
const PI_VIRTUAL_API = 'pi-virtual';

/** The router's group models, hidden since the migration. */
export function isGroupModelRef(ref: string, groupNames: ReadonlySet<string>): boolean {
  const slash = ref.indexOf('/');
  if (slash === -1) return false;
  const provider = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
  return groupNames.has(provider) && (modelId === provider || modelId === `${provider}:use-static`);
}

/**
 * The group a PRE-MIGRATION branch had selected, or null. Only when Pi fell
 * back to the last responder: the branch's latest `model_change` names one
 * of the router's group models (a deliberate `/model` switch to a concrete
 * model writes its own `model_change` and wins), the current model is no
 * group model, and it is the model of the latest assistant reply that does
 * not name a Pi virtual model — exactly the reply getBranchSelection returns
 * for a non-virtual selection, whatever its stopReason (the router forwards
 * a physical model's aborted or failed message unchanged; review
 * 2026-11-21).
 */
export function legacyGroupToRestore(
  branch: readonly unknown[],
  current: ModelRefLike | undefined,
  groupNames: ReadonlySet<string>
): GroupSelection | null {
  if (!current) return null;
  if (isGroupModelRef(`${current.provider}/${current.id}`, groupNames)) return null;
  let lastReply: { provider: unknown; model: unknown } | undefined;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    const type = field(entry, 'type');
    if (type === 'model_change') {
      const provider = field(entry, 'provider');
      const modelId = field(entry, 'modelId');
      if (typeof provider !== 'string' || typeof modelId !== 'string') return null;
      if (!isGroupModelRef(`${provider}/${modelId}`, groupNames)) return null;
      // A selection after the last reply: Pi restored it itself.
      if (!lastReply) return null;
      const fellBack = lastReply.provider === current.provider && lastReply.model === current.id;
      return fellBack ? { provider, modelId } : null;
    }
    const message = field(entry, 'message');
    if (
      !lastReply &&
      type === 'message' &&
      field(message, 'role') === 'assistant' &&
      field(message, 'api') !== PI_VIRTUAL_API
    ) {
      lastReply = { provider: field(message, 'provider'), model: field(message, 'model') };
    }
  }
  return null;
}

/**
 * The group selection session_start moves to `router/dynamic`, or null.
 * Either the session model IS a router group model — Pi resolves the
 * settings default and `--model` through the unfiltered catalog, so a user
 * whose default is `dynamic/dynamic` still starts on the hidden group, where
 * no route() runs and no pin applies (review 2026-11-21, Important 1) — or
 * Pi fell back from a pre-migration group selection to the physical model
 * that answered last (legacyGroupToRestore).
 */
export function groupSelectionToMigrate(
  branch: readonly unknown[],
  current: ModelRefLike | undefined,
  groupNames: ReadonlySet<string>
): GroupSelection | null {
  if (current && isGroupModelRef(`${current.provider}/${current.id}`, groupNames))
    return { provider: current.provider, modelId: current.id };
  return legacyGroupToRestore(branch, current, groupNames);
}

/** The thinking level the branch records last (Pi's resume restores it), or undefined. */
export function branchThinkingLevel(branch: readonly unknown[]): string | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (field(entry, 'type') !== 'thinking_level_change') continue;
    const level = field(entry, 'thinkingLevel');
    return typeof level === 'string' ? level : undefined;
  }
  return undefined;
}
