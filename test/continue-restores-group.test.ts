// test/continue-restores-group.test.ts
// docs/plans/2026-11-21-continue-restores-group.md, step 1.
//
// Pi restores a resumed session's model with getBranchSelection: a
// `model_change` only outlives later responses when it names a Pi virtual
// model. Router group models are ordinary providers and every response names
// the physical model that answered, so `pi --continue` lands on that model
// and no request is routed any more. The router puts the group back.
import { describe, it, expect, vi } from 'vitest';

import { groupSelectionToMigrate, legacyGroupToRestore } from '../src/legacy-session-restore.ts';
import { makeObservableExtensionContext, makeSessionCtx } from './helpers/extension-harness.ts';
import { flushBackgroundScan } from './helpers/noop-scan-cache.ts';
import { paidCloudModel } from './helpers/stream-fixtures.ts';
import { withRouterEnv } from './helpers/router-env.ts';

// Outcome records the router writes (ADR-0027): the restore must not log a
// user model pick nobody made.
const writeOutcomeRecord = vi.hoisted(() => vi.fn());
vi.mock('../src/classifier-decision-log.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/classifier-decision-log.ts')>();
  return { ...actual, writeOutcomeRecord };
});
const routerLog = vi.hoisted(() => vi.fn());
const warnLog = vi.hoisted(() => vi.fn());
vi.mock('../src/logger.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/logger.ts')>();
  return { ...actual, routerLog, warnLog };
});

const GROUPS: ReadonlySet<string> = new Set(['dynamic', 'planning']);
const PHYSICAL = { provider: 'paid-cloud-provider', id: 'paid-model' };
const SID = 'resume-session';

const modelChange = (provider: string, modelId: string): any => ({
  type: 'model_change',
  provider,
  modelId,
});
const reply = (provider: string, model: string, stopReason = 'stop'): any => ({
  type: 'message',
  message: { role: 'assistant', provider, model, stopReason, content: [] },
});
const userMsg = (): any => ({ type: 'message', message: { role: 'user', content: 'hi' } });

/** A branch Pi wrote for a session that ran on `dynamic`: selection, then routed replies. */
const routedBranch = (): any[] => [
  modelChange('dynamic', 'dynamic'),
  userMsg(),
  reply('paid-cloud-provider', 'paid-model'),
];

describe('groupToRestore — when Pi fell back to the last responder', () => {
  it('restores the group the branch selected', () => {
    expect(legacyGroupToRestore(routedBranch(), PHYSICAL, GROUPS)).toEqual({
      provider: 'dynamic',
      modelId: 'dynamic',
    });
  });

  it('restores the static variant of a dynamic group', () => {
    const branch = [modelChange('dynamic', 'dynamic:use-static'), ...routedBranch().slice(1)];
    expect(legacyGroupToRestore(branch, PHYSICAL, GROUPS)).toEqual({
      provider: 'dynamic',
      modelId: 'dynamic:use-static',
    });
  });

  // Review 2026-11-21: Pi's getBranchSelection takes the latest assistant
  // reply whatever its stopReason; the router forwards a physical model's
  // aborted or failed message unchanged, so Pi restores THAT model.
  it('an aborted last reply on another model is still Pi’s fallback', () => {
    const branch = [...routedBranch(), userMsg(), reply('other-provider', 'other', 'aborted')];
    expect(
      legacyGroupToRestore(branch, { provider: 'other-provider', id: 'other' }, GROUPS)
    ).toEqual({
      provider: 'dynamic',
      modelId: 'dynamic',
    });
  });

  it('a failed physical last reply is still Pi’s fallback', () => {
    const branch = [...routedBranch(), userMsg(), reply('other-provider', 'other', 'error')];
    expect(
      legacyGroupToRestore(branch, { provider: 'other-provider', id: 'other' }, GROUPS)
    ).not.toBeNull();
  });

  it('a Pi virtual-model reply does not count as the last responder', () => {
    const virtualReply = {
      type: 'message',
      message: {
        role: 'assistant',
        api: 'pi-virtual',
        provider: 'v',
        model: 'v',
        stopReason: 'error',
      },
    };
    expect(
      legacyGroupToRestore([...routedBranch(), virtualReply], PHYSICAL, GROUPS)
    ).not.toBeNull();
  });
});

describe('groupToRestore — leaves every other start alone', () => {
  it('a deliberate /model switch to a concrete model is respected', () => {
    const branch = [...routedBranch(), modelChange('paid-cloud-provider', 'paid-model')];
    expect(legacyGroupToRestore(branch, PHYSICAL, GROUPS)).toBeNull();
  });

  // No fallback to undo here; groupSelectionToMigrate (below) still moves
  // such a session to router/dynamic (review 2026-11-21, Important 1).
  it('a session already on its group is no fallback', () => {
    expect(
      legacyGroupToRestore(routedBranch(), { provider: 'dynamic', id: 'dynamic' }, GROUPS)
    ).toBeNull();
  });

  it('a session that never selected a group is a no-op', () => {
    const branch = [
      modelChange('paid-cloud-provider', 'paid-model'),
      userMsg(),
      reply('paid-cloud-provider', 'paid-model'),
    ];
    expect(legacyGroupToRestore(branch, PHYSICAL, GROUPS)).toBeNull();
  });

  it('a current model other than the last responder (an explicit --model) is a no-op', () => {
    expect(legacyGroupToRestore(routedBranch(), { provider: 'x', id: 'y' }, GROUPS)).toBeNull();
  });

  it('a new session (no history) and no model are no-ops', () => {
    expect(legacyGroupToRestore([], PHYSICAL, GROUPS)).toBeNull();
    expect(legacyGroupToRestore(routedBranch(), undefined, GROUPS)).toBeNull();
  });

  it('a group the config no longer has is not restored', () => {
    const branch = [modelChange('retired', 'retired'), ...routedBranch().slice(1)];
    expect(legacyGroupToRestore(branch, PHYSICAL, GROUPS)).toBeNull();
  });
});

// Review 2026-11-21 (Important 1): Pi resolves the settings default and
// `--model` through the unfiltered catalog, so a session can START on a
// hidden group model; it moves to router/dynamic like a fallen-back one.
describe('groupSelectionToMigrate', () => {
  it('a session on a group model migrates, whatever the branch says', () => {
    expect(groupSelectionToMigrate([], { provider: 'dynamic', id: 'dynamic' }, GROUPS)).toEqual({
      provider: 'dynamic',
      modelId: 'dynamic',
    });
    expect(
      groupSelectionToMigrate(routedBranch(), { provider: 'planning', id: 'planning' }, GROUPS)
    ).toEqual({ provider: 'planning', modelId: 'planning' });
  });

  it('a fallen-back pre-migration branch migrates its group', () => {
    expect(groupSelectionToMigrate(routedBranch(), PHYSICAL, GROUPS)).toEqual({
      provider: 'dynamic',
      modelId: 'dynamic',
    });
  });

  it('a concrete model chosen on purpose stays', () => {
    const branch = [...routedBranch(), modelChange('paid-cloud-provider', 'paid-model')];
    expect(groupSelectionToMigrate(branch, PHYSICAL, GROUPS)).toBeNull();
    expect(groupSelectionToMigrate([], undefined, GROUPS)).toBeNull();
  });
});

describe('session_start wiring', () => {
  interface Resumed {
    setModel: ReturnType<typeof vi.fn>;
    setThinkingLevel: ReturnType<typeof vi.fn>;
    /** Whether the session_start handler returned only after the switch. */
    awaitedSwitch: boolean;
    /**
     * The first request after the start, when the session ended up on
     * router/dynamic: route()'s result (the group model and branch state).
     */
    routed: { model: { provider: string; id: string }; state?: unknown } | undefined;
  }

  async function resume(
    branch: any[],
    current: any,
    hasUI = true,
    thinkingAfterSwitch = 'off',
    setModelResult = true
  ): Promise<Resumed> {
    const out = {} as Resumed;
    await withRouterEnv(
      async (defaultExport, tmpDir) => {
        writeOutcomeRecord.mockClear();
        routerLog.mockClear();
        warnLog.mockClear();
        const { ctx: pi, onHandlers } = makeObservableExtensionContext();
        let switched = false;
        let liveModel = current;
        // Pi's setModel: auth check first (async), then the switch, then the
        // model_select event (source "set") the router also listens to. It
        // routes nothing: route() runs with the next request.
        pi.setModel = vi.fn(async (model: any) => {
          await new Promise((r) => setTimeout(r, 5));
          if (!setModelResult) return false;
          liveModel = model;
          switched = true;
          await onHandlers['model_select']?.({ type: 'model_select', model, source: 'set' }, ctx);
          return true;
        });
        pi.getThinkingLevel = vi.fn(() => thinkingAfterSwitch);
        pi.setThinkingLevel = vi.fn();
        out.setModel = pi.setModel;
        out.setThinkingLevel = pi.setThinkingLevel;
        defaultExport(pi);
        const physical = paidCloudModel();
        const modelRegistry = {
          getAvailable: () => [physical],
          find: (provider: string, id: string) =>
            provider === 'router' && id === 'dynamic'
              ? { provider, id, api: 'pi-virtual' }
              : GROUPS.has(provider) && (id === provider || id === `${provider}:use-static`)
                ? { provider, id, api: `router-group-${provider}` }
                : provider === physical.provider && id === physical.id
                  ? physical
                  : undefined,
          getApiKeyForProvider: async () => null,
          getRegisteredProviderIds: () => [],
        };
        const ctx: any = {
          ...makeSessionCtx({ modelRegistry, cwd: tmpDir }),
          get model() {
            return liveModel;
          },
          hasUI,
          sessionManager: {
            getSessionId: () => SID,
            getBranch: () => branch,
            getEntries: () => branch,
          },
        };
        await onHandlers['session_start']?.({ reason: 'startup' }, ctx);
        out.awaitedSwitch = switched;
        // A failed switch: the user selects router/dynamic later by hand.
        if (liveModel?.api === 'pi-virtual' || !setModelResult) {
          // The first prompt on router/dynamic: Pi routes it through the
          // virtual model with the branch state (none yet on an old branch).
          const def = (pi.registerVirtualModel as ReturnType<typeof vi.fn>).mock.calls[0][0];
          out.routed = await def.route(
            { reason: 'user', messages: [], thinkingLevel: 'off', model: liveModel },
            ctx
          );
        }
        await flushBackgroundScan();
      },
      {
        config: {
          model_groups: {
            dynamic: { method: 'dynamic' },
            planning: { models: ['paid-cloud-provider/paid-model'] },
          },
          classifier: { log: { enabled: true, store_text: 'none' } },
        },
        disableNetwork: true,
      }
    );
    return out;
  }

  it('pi --continue on a routed session re-selects router/dynamic', async () => {
    const { setModel } = await resume(routedBranch(), paidCloudModel());
    expect(setModel).toHaveBeenCalledTimes(1);
    expect(setModel.mock.calls[0][0]).toMatchObject({ provider: 'router', id: 'dynamic' });
  }, 30000);

  // Review 2026-11-21 (Minor 3): Pi awaits what session_start returns; a
  // prompt sent right after the start must already see the selection.
  it('session_start returns only after the re-selection', async () => {
    const { awaitedSwitch } = await resume(routedBranch(), paidCloudModel());
    expect(awaitedSwitch).toBe(true);
  }, 30000);

  // Review 2026-11-21 (Important 2): Pi's setModel takes the thinking level
  // from the settings, Pi's resume from the branch. The branch's level wins.
  it('the branch’s thinking level survives the switch', async () => {
    const branch = [{ type: 'thinking_level_change', thinkingLevel: 'high' }, ...routedBranch()];
    const { setThinkingLevel } = await resume(branch, paidCloudModel());
    expect(setThinkingLevel).toHaveBeenCalledWith('high');
  }, 30000);

  it('a thinking level the switch kept is not set again', async () => {
    const branch = [{ type: 'thinking_level_change', thinkingLevel: 'high' }, ...routedBranch()];
    const { setThinkingLevel } = await resume(branch, paidCloudModel(), true, 'high');
    expect(setThinkingLevel).not.toHaveBeenCalled();
  }, 30000);

  // Review 2026-11-21 (Minor 2): the restore's model_select (source "set")
  // is no user pick — no outcome record for it.
  it('the restore writes no model_select outcome', async () => {
    await resume(routedBranch(), paidCloudModel());
    const picks = writeOutcomeRecord.mock.calls.filter((c) => c[0]?.via === 'model_select');
    expect(picks).toEqual([]);
  }, 30000);

  // Review 2026-11-21 (Minor 1): ctx.model is a live getter; the log names
  // the model Pi restored, not the re-selection afterwards.
  it('the log line names the migrate source and the pinned group', async () => {
    await resume(routedBranch(), paidCloudModel());
    const line = routerLog.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('resumed session'));
    expect(line).toContain('pre-migration selection dynamic/dynamic');
    expect(line).toContain('Pi restored paid-cloud-provider/paid-model');
  }, 30000);

  // Review 2026-11-21 (Important 5): an old branch on a non-classifying
  // group keeps that group — the first route() after the start serves it
  // and stores it as the branch's pin.
  it('an old planning branch is served by planning and pinned', async () => {
    const branch = [modelChange('planning', 'planning'), ...routedBranch().slice(1)];
    const { setModel, routed } = await resume(branch, paidCloudModel());
    expect(setModel).toHaveBeenCalledTimes(1);
    expect(routed?.model).toMatchObject({ provider: 'planning', id: 'planning' });
    expect(routed?.state).toEqual({ pin: 'planning' });
  }, 30000);

  it('an old dynamic branch is classified, with no pin', async () => {
    const { routed } = await resume(routedBranch(), paidCloudModel());
    expect(routed?.model).toMatchObject({ provider: 'dynamic', id: 'dynamic' });
    expect(routed?.state).toBeUndefined();
  }, 30000);

  // Review 2026-11-21 (Important 1): Pi starts on a hidden group model when
  // it is the settings default or `--model` names it.
  it('a session that starts on a group model moves to router/dynamic', async () => {
    const onGroup = { provider: 'planning', id: 'planning', api: 'router-group-planning' };
    const { setModel, routed } = await resume([], onGroup);
    expect(setModel.mock.calls[0]?.[0]).toMatchObject({ provider: 'router', id: 'dynamic' });
    expect(routed?.model).toMatchObject({ provider: 'planning', id: 'planning' });
  }, 30000);

  // Review 2026-11-21 (Minor 3): a pin set for a switch that failed would
  // wait in the handoff and fire on a later, unrelated switch.
  it('a failed switch leaves no pin behind', async () => {
    const branch = [modelChange('planning', 'planning'), ...routedBranch().slice(1)];
    const { routed, awaitedSwitch } = await resume(branch, paidCloudModel(), true, 'off', false);
    expect(awaitedSwitch).toBe(false);
    // The later, unrelated selection of router/dynamic classifies.
    expect(routed?.model).toMatchObject({ provider: 'dynamic', id: 'dynamic' });
    expect(routed?.state).toBeUndefined();
    expect(warnLog.mock.calls.map((c) => String(c[0]))).toContain(
      '[router] resumed session: could not select router/dynamic again'
    );
  }, 30000);

  // pi-subagents forks the parent's branch into a child session and starts it
  // headless (bind mode "print") with reason 'startup'. A child given exactly
  // the model that answered the parent last would look like Pi's fallback;
  // its explicit model must win, so only sessions with a UI are restored.
  it('a headless child session (forked subagent) keeps its model', async () => {
    const { setModel } = await resume(routedBranch(), paidCloudModel(), false);
    expect(setModel).not.toHaveBeenCalled();
  }, 30000);

  it('a resumed session on a deliberately chosen model keeps it', async () => {
    const branch = [...routedBranch(), modelChange('paid-cloud-provider', 'paid-model')];
    const { setModel } = await resume(branch, paidCloudModel());
    expect(setModel).not.toHaveBeenCalled();
  }, 30000);
});
