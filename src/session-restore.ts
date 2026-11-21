/**
 * `--continue` restores the router group (docs/plans/2026-11-21-continue-restores-group.md).
 *
 * Pi restores a resumed session's model with getBranchSelection: a
 * `model_change` only outlives the assistant messages after it when the
 * model it names is a Pi virtual model (`api: "pi-virtual"`). Router group
 * models are ordinary providers, and every response names the physical model
 * that answered, so a resumed router session lands on that physical model and
 * is no longer routed. This module decides when to put the group back.
 */

import { isVirtualGroupRef } from './routing.ts';

/** A model as Pi names it: provider + id. */
export interface ModelRefLike {
  readonly provider: string;
  readonly id: string;
}

/** A group model to select again: the provider and model id of a `model_change`. */
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

/**
 * The group to select again, or null. Only when Pi fell back to the last
 * responder: the branch's latest `model_change` names one of the router's
 * group models (a deliberate `/model` switch to a concrete model writes its
 * own `model_change` and wins), the current model is no group model, and it
 * is the model of the latest assistant reply that does not name a Pi virtual
 * model — exactly the reply getBranchSelection returns for a non-virtual
 * selection, whatever its stopReason (the router forwards a physical model's
 * aborted or failed message unchanged; review 2026-11-21).
 */
export function groupToRestore(
  branch: readonly unknown[],
  current: ModelRefLike | undefined,
  groupNames: ReadonlySet<string>
): GroupSelection | null {
  if (!current) return null;
  if (isVirtualGroupRef(`${current.provider}/${current.id}`, groupNames)) return null;
  let lastReply: { provider: unknown; model: unknown } | undefined;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    const type = field(entry, 'type');
    if (type === 'model_change') {
      const provider = field(entry, 'provider');
      const modelId = field(entry, 'modelId');
      if (typeof provider !== 'string' || typeof modelId !== 'string') return null;
      if (!isVirtualGroupRef(`${provider}/${modelId}`, groupNames)) return null;
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
