// test/set-model-from-group-pin.test.ts
// Virtual-models migration step 2 (docs/plans/2026-11-21-virtual-models-migration.md):
// set_model_from_group pins a group for the session branch instead of
// switching the session's model; "none" releases the pin. Review 2026-11-21
// (Important 2 and 3): the pin could never be released — "none" and the
// classifying group both threw — and the tool reported success on a session
// that is not on router/dynamic, where no route() ever applies the pin.
import { describe, it, expect, vi } from 'vitest';

import { createTools } from '../src/tools.ts';
import { createPinHandoff } from '../src/virtual-selection.ts';

const SID = 'pin-session';
const ON_VIRTUAL = { provider: 'router', id: 'dynamic', api: 'pi-virtual' };
const ON_PHYSICAL = { provider: 'paid-cloud-provider', id: 'paid-model' };

function setup() {
  const registerTool = vi.fn();
  const pins = createPinHandoff();
  const cfg: any = {
    model_groups: {
      dynamic: { method: 'dynamic' },
      planning: { models: ['paid-cloud-provider/paid-model'] },
      // Configured, but refused at registration (named like a Pi provider, ADR-0019).
      refused: { models: ['paid-cloud-provider/paid-model'] },
    },
  };
  createTools({
    activeGroup: null,
    cfg,
    cfgPath: '/dev/null',
    fmtModel: (ref: string) => ref,
    getM: () => ({ gdpval: 1500, throughput_tps: 80 }) as any,
    load: () => {},
    pins,
    pi: { registerTool } as any,
    // resolve() knows only static groups (method: 'dynamic' resolves to null).
    resolve: (name: string) =>
      name === 'planning'
        ? {
            selected: 'paid-cloud-provider/paid-model',
            candidates: ['paid-cloud-provider/paid-model'],
          }
        : null,
    router: {} as any,
  });
  const tool = registerTool.mock.calls.find((c) => c[0]?.name === 'set_model_from_group')![0];
  // async: the tool throws synchronously, like its siblings; Pi awaits it.
  const call = async (group: string, model: any = ON_VIRTUAL) =>
    tool.execute('t', { group }, undefined, undefined, {
      model,
      sessionManager: { getSessionId: () => SID },
      modelRegistry: {
        find: (provider: string, id: string) =>
          provider === id && (id === 'dynamic' || id === 'planning') ? { provider, id } : undefined,
      },
    });
  return { pins, call };
}

describe('set_model_from_group pins the group', () => {
  it('a static group becomes the pending pin', async () => {
    const { pins, call } = setup();
    const result = await call('planning');
    expect(pins.take(SID)).toBe('planning');
    expect(result.details).toMatchObject({ group: 'planning', pinned: 'planning' });
  });

  it('"none" releases the pin', async () => {
    const { pins, call } = setup();
    await call('planning');
    const result = await call('none');
    expect(pins.take(SID)).toBeNull();
    expect(result.details).toMatchObject({ pinned: null });
  });

  it('the classifying group releases the pin too', async () => {
    const { pins, call } = setup();
    await call('dynamic');
    expect(pins.take(SID)).toBeNull();
  });

  // Re-review Minor 4: route() would fall back from it on every request.
  it('a configured group without a registered model throws and pins nothing', async () => {
    const { pins, call } = setup();
    await expect(call('refused')).rejects.toThrow(/no registered model/);
    expect(pins.take(SID)).toBeUndefined();
  });

  it('an unknown group throws and pins nothing', async () => {
    const { pins, call } = setup();
    await expect(call('retired')).rejects.toThrow(/Available: dynamic, planning/);
    expect(pins.take(SID)).toBeUndefined();
  });
});

describe('set_model_from_group only works on router/dynamic', () => {
  it('a session on a concrete model throws and pins nothing', async () => {
    const { pins, call } = setup();
    await expect(call('planning', ON_PHYSICAL)).rejects.toThrow(/router\/dynamic/);
    expect(pins.take(SID)).toBeUndefined();
  });

  it('a release on a concrete model throws too', async () => {
    const { pins, call } = setup();
    await expect(call('none', ON_PHYSICAL)).rejects.toThrow(/router\/dynamic/);
    expect(pins.take(SID)).toBeUndefined();
  });
});
