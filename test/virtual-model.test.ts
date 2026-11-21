/**
 * The `router/dynamic` virtual model wired to Pi (plan
 * docs/plans/2026-11-21-virtual-models-migration.md, step 2): one
 * registration at extension load, and a route() that names the hidden group
 * model the request dispatches to. The decisions themselves are pinned in
 * test/virtual-selection.test.ts; this file pins the wiring.
 */
import { describe, it, expect, vi } from 'vitest';
import { registerSelectionModel } from '../src/virtual-model.ts';
import { createPinHandoff, createServedGroups } from '../src/virtual-selection.ts';

const GROUPS = {
  dynamic: { method: 'dynamic' },
  planning: { method: 'best' },
  simple: { method: 'min_cost_if_all_priced' },
};

function groupModel(group: string) {
  return { provider: group, id: group, api: `router-group-${group}` };
}

function setup(registered: string[] = Object.keys(GROUPS)) {
  const registerVirtualModel = vi.fn();
  const pins = createPinHandoff();
  const served = createServedGroups();
  registerSelectionModel({ registerVirtualModel } as any, {
    groups: () => GROUPS,
    pins,
    served,
    contextWindow: 200_000,
  });
  const definition = registerVirtualModel.mock.calls[0]![0];
  const find = vi.fn((provider: string, id: string) =>
    provider === id && registered.includes(provider) ? groupModel(provider) : undefined
  );
  const ctx: any = {
    modelRegistry: { find },
    sessionManager: { getSessionId: () => 'S' },
  };
  const route = (request: Record<string, unknown>) =>
    definition.route(
      { thinkingLevel: 'high', reason: 'user', messages: [], model: {}, ...request },
      ctx
    );
  return { registerVirtualModel, definition, pins, served, route };
}

describe('registerSelectionModel', () => {
  it('registers router/dynamic once, offering every thinking level', () => {
    const { registerVirtualModel, definition } = setup();
    expect(registerVirtualModel).toHaveBeenCalledTimes(1);
    expect(definition).toMatchObject({ provider: 'router', id: 'dynamic', contextWindow: 200_000 });
    // Pi defaults to ["off"]: without the list a user could no longer pick a
    // thinking level for the router.
    expect(definition.thinkingLevels).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  it('routes an unpinned request to the classifying group, thinking level unchanged', async () => {
    const { route } = setup();
    const result = await route({ state: undefined });
    expect(result.model).toEqual(groupModel('dynamic'));
    expect(result.thinkingLevel).toBe('high');
    expect(result.state).toBeUndefined();
  });

  it('routes to the group the branch pinned', async () => {
    const { route } = setup();
    const result = await route({ reason: 'continuation', state: { pin: 'planning' } });
    expect(result.model).toEqual(groupModel('planning'));
  });

  it('applies a tool-set pin on the next request and stores it on the branch', async () => {
    const { route, pins } = setup();
    pins.set('S', 'planning');
    const result = await route({ reason: 'continuation', state: undefined });
    expect(result.model).toEqual(groupModel('planning'));
    expect(result.state).toEqual({ pin: 'planning' });
    // Taken once: the next request reads the stored state instead.
    expect(pins.take('S')).toBeUndefined();
  });

  it('a direct request leaves a pending pin for the next agent-loop request', async () => {
    const { route, pins } = setup();
    pins.set('S', 'planning');
    await route({ reason: 'direct', state: undefined });
    expect(pins.take('S')).toBe('planning');
  });

  it('a pinned group without a registered model falls back to the classifying group', async () => {
    const { route, served } = setup(['dynamic', 'simple']);
    const result = await route({ state: { pin: 'planning' } });
    expect(result.model).toEqual(groupModel('dynamic'));
    // The footer names the group that served, not the pinned one.
    expect(served.get('S')).toBe('dynamic');
    // Re-review Minor 4: the dead pin goes, so the warning does not repeat
    // on every request.
    expect(result.state).toEqual({ pin: null });
  });

  // Step 5 review (Boyscout, AGENTS §7): branchState reads only the LAST
  // state entry, so a release written as a bare `{ pin: null }` replaced the
  // branch's run group and inherited category with nothing — a restart after
  // the fallback lost the category memory step 3 persists.
  it('the fallback release keeps the other stored fields of the branch', async () => {
    const { route } = setup(['dynamic', 'simple']);
    const result = await route({
      state: { pin: 'planning', group: 'simple', runGroup: 'simple', lastCategory: 'design' },
    });
    expect(result.state).toEqual({
      pin: null,
      group: 'simple',
      runGroup: 'simple',
      lastCategory: 'design',
    });
  });

  // Review 2026-11-21 (Important 4): ctx.model stays router/dynamic, so the
  // footer reads the group route() dispatched the session to.
  it('records the group each session was dispatched to', async () => {
    const { route, served } = setup();
    expect(served.get('S')).toBeUndefined();
    await route({ reason: 'continuation', state: { pin: 'planning' } });
    expect(served.get('S')).toBe('planning');
    served.forget('S');
    expect(served.get('S')).toBeUndefined();
  });

  it('fails with a router message when no group model is registered', async () => {
    const { route } = setup([]);
    const outcome = route({ state: undefined }) as unknown as Promise<unknown>;
    await expect(outcome).rejects.toThrow(/\[router\]/);
  });
});
