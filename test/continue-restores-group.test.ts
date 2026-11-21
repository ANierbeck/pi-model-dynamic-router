// test/continue-restores-group.test.ts
// docs/plans/2026-11-21-continue-restores-group.md, step 1.
//
// Pi restores a resumed session's model with getBranchSelection: a
// `model_change` only outlives later responses when it names a Pi virtual
// model. Router group models are ordinary providers and every response names
// the physical model that answered, so `pi --continue` lands on that model
// and no request is routed any more. The router puts the group back.
import { describe, it, expect, vi } from 'vitest';

import { groupToRestore } from '../src/session-restore.ts';
import { makeObservableExtensionContext, makeSessionCtx } from './helpers/extension-harness.ts';
import { flushBackgroundScan } from './helpers/noop-scan-cache.ts';
import { paidCloudModel } from './helpers/stream-fixtures.ts';
import { withRouterEnv } from './helpers/router-env.ts';

const GROUPS: ReadonlySet<string> = new Set(['dynamic', 'planning']);
const PHYSICAL = { provider: 'paid-cloud-provider', id: 'paid-model' };

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
    expect(groupToRestore(routedBranch(), PHYSICAL, GROUPS)).toEqual({
      provider: 'dynamic',
      modelId: 'dynamic',
    });
  });

  it('restores the static variant of a dynamic group', () => {
    const branch = [modelChange('dynamic', 'dynamic:use-static'), ...routedBranch().slice(1)];
    expect(groupToRestore(branch, PHYSICAL, GROUPS)).toEqual({
      provider: 'dynamic',
      modelId: 'dynamic:use-static',
    });
  });

  it('judges the latest successful reply, not a failed one after it', () => {
    const branch = [...routedBranch(), userMsg(), reply('other-provider', 'other', 'error')];
    expect(groupToRestore(branch, PHYSICAL, GROUPS)).not.toBeNull();
  });
});

describe('groupToRestore — leaves every other start alone', () => {
  it('a deliberate /model switch to a concrete model is respected', () => {
    const branch = [...routedBranch(), modelChange('paid-cloud-provider', 'paid-model')];
    expect(groupToRestore(branch, PHYSICAL, GROUPS)).toBeNull();
  });

  it('a session already on its group (reload) is a no-op', () => {
    expect(
      groupToRestore(routedBranch(), { provider: 'dynamic', id: 'dynamic' }, GROUPS)
    ).toBeNull();
  });

  it('a session that never selected a group is a no-op', () => {
    const branch = [
      modelChange('paid-cloud-provider', 'paid-model'),
      userMsg(),
      reply('paid-cloud-provider', 'paid-model'),
    ];
    expect(groupToRestore(branch, PHYSICAL, GROUPS)).toBeNull();
  });

  it('a current model other than the last responder (an explicit --model) is a no-op', () => {
    expect(groupToRestore(routedBranch(), { provider: 'x', id: 'y' }, GROUPS)).toBeNull();
  });

  it('a new session (no history) and no model are no-ops', () => {
    expect(groupToRestore([], PHYSICAL, GROUPS)).toBeNull();
    expect(groupToRestore(routedBranch(), undefined, GROUPS)).toBeNull();
  });

  it('a group the config no longer has is not restored', () => {
    const branch = [modelChange('retired', 'retired'), ...routedBranch().slice(1)];
    expect(groupToRestore(branch, PHYSICAL, GROUPS)).toBeNull();
  });
});

describe('session_start wiring', () => {
  async function resume(
    branch: any[],
    current: any,
    hasUI = true
  ): Promise<ReturnType<typeof vi.fn>> {
    let setModel!: ReturnType<typeof vi.fn>;
    await withRouterEnv(
      async (defaultExport, tmpDir) => {
        const { ctx: pi, onHandlers } = makeObservableExtensionContext();
        setModel = pi.setModel;
        defaultExport(pi);
        const physical = paidCloudModel();
        const modelRegistry = {
          getAvailable: () => [physical],
          find: (provider: string, id: string) =>
            provider === 'dynamic'
              ? { provider, id, api: 'router-group-dynamic' }
              : provider === physical.provider && id === physical.id
                ? physical
                : undefined,
          getApiKeyForProvider: async () => null,
          getRegisteredProviderIds: () => [],
        };
        const ctx = {
          ...makeSessionCtx({ modelRegistry, cwd: tmpDir }),
          model: current,
          hasUI,
          sessionManager: { getBranch: () => branch, getEntries: () => branch },
        };
        await onHandlers['session_start']?.({ reason: 'startup' }, ctx);
        await flushBackgroundScan();
      },
      { config: { model_groups: { dynamic: { method: 'dynamic' } } }, disableNetwork: true }
    );
    return setModel;
  }

  it('pi --continue on a routed session switches back to the group', async () => {
    const setModel = await resume(routedBranch(), paidCloudModel());
    expect(setModel).toHaveBeenCalledTimes(1);
    expect(setModel.mock.calls[0][0]).toMatchObject({ provider: 'dynamic', id: 'dynamic' });
  }, 30000);

  // pi-subagents forks the parent's branch into a child session and starts it
  // headless (bind mode "print") with reason 'startup'. A child given exactly
  // the model that answered the parent last would look like Pi's fallback;
  // its explicit model must win, so only sessions with a UI are restored.
  it('a headless child session (forked subagent) keeps its model', async () => {
    const setModel = await resume(routedBranch(), paidCloudModel(), false);
    expect(setModel).not.toHaveBeenCalled();
  }, 30000);

  it('a resumed session on a deliberately chosen model keeps it', async () => {
    const branch = [...routedBranch(), modelChange('paid-cloud-provider', 'paid-model')];
    const setModel = await resume(branch, paidCloudModel());
    expect(setModel).not.toHaveBeenCalled();
  }, 30000);
});
