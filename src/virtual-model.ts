/**
 * Wires the selection layer to Pi (plan
 * docs/plans/2026-11-21-virtual-models-migration.md, step 2): the session's
 * model is the one virtual model `router/dynamic`; its route() names the
 * hidden group model (src/group-registration.ts) that dispatches the request.
 * The decisions live in src/virtual-selection.ts.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRouteRequest,
  ModelRoute,
} from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import {
  VIRTUAL_PROVIDER,
  VIRTUAL_MODEL_ID,
  decideSelection,
  dispatchGroupOf,
  type PinHandoff,
  type SelectionState,
} from './virtual-selection.ts';
import { warnLog } from './logger.ts';

/**
 * Every thinking level Pi knows (pi-ai `MODEL_THINKING_LEVELS`, not exported
 * from the package index). Pi offers only "off" for a virtual model without
 * a list; the router passes the selected level on to the group model, whose
 * driveStream maps it onto the served model.
 */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface SelectionModelDeps {
  /** The configured groups, read per request (the config can reload). */
  groups(): Readonly<Record<string, { method?: string }>>;
  /** Pins `set_model_from_group` set during a turn. */
  pins: PinHandoff;
  /**
   * The window Pi shows before the first response (the dispatch group's).
   * Read lazily: before the first load() the config is still unset, and a
   * group's spec exists only after registerGroupProviders().
   */
  readonly contextWindow?: number | undefined;
}

function groupModel(ctx: ExtensionContext, group: string): Model<Api> | undefined {
  return ctx.modelRegistry.find(group, group);
}

/**
 * Register `router/dynamic`. Once, at extension load: a re-registration
 * queues a catalog refresh, and until it lands Pi's availability snapshot
 * lists the hidden group models (spike condition G1b).
 */
export function registerSelectionModel(
  pi: Pick<ExtensionAPI, 'registerVirtualModel'>,
  deps: SelectionModelDeps
): void {
  pi.registerVirtualModel<SelectionState>({
    provider: VIRTUAL_PROVIDER,
    id: VIRTUAL_MODEL_ID,
    name: 'Router (dynamic)',
    thinkingLevels: THINKING_LEVELS,
    ...(deps.contextWindow ? { contextWindow: deps.contextWindow } : {}),
    maxTokens: 64_000,
    route: async (
      request: ModelRouteRequest<SelectionState>,
      ctx: ExtensionContext
    ): Promise<ModelRoute<SelectionState>> => {
      const groups = deps.groups();
      const dispatchGroup = dispatchGroupOf(groups);
      if (dispatchGroup === null) throw new Error('[router] no model group is configured');
      const sessionId = await Promise.resolve(ctx.sessionManager?.getSessionId?.());
      // Pi ignores the state a direct request returns, so a pin taken there
      // would be lost: it waits for the next agent-loop request.
      const pending = request.reason === 'direct' ? undefined : deps.pins.take(sessionId);
      const decision = decideSelection({
        reason: request.reason,
        state: request.state,
        pending,
        groupNames: new Set(Object.keys(groups)),
        dispatchGroup,
      });
      let model = groupModel(ctx, decision.group);
      if (!model && decision.group !== dispatchGroup) {
        // A group the router refused to register (named like a Pi provider,
        // ADR-0019) has no model to route to.
        warnLog(
          `[router] group "${decision.group}" has no registered model; routing to "${dispatchGroup}"`
        );
        model = groupModel(ctx, dispatchGroup);
      }
      if (!model) throw new Error(`[router] group "${dispatchGroup}" has no registered model`);
      return {
        model,
        thinkingLevel: request.thinkingLevel,
        ...(decision.state ? { state: decision.state } : {}),
      };
    },
  });
}
