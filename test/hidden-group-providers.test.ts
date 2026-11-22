/**
 * Group providers are the dispatch layer behind the `router/dynamic` virtual
 * model (plan docs/plans/2026-11-21-virtual-models-migration.md, step 2):
 * native pi-ai providers whose models stay in Pi's catalog (route() returns
 * them, `--model` and delegation still name them) but never in its
 * availability list (`/model`, scoped models).
 *
 * Spike condition G1b (docs/research/2026-11-21-router-shape-spike.md):
 * every re-registration shows the hidden models in Pi's availability snapshot
 * until the queued refresh lands, so the provider serves its models live and
 * is registered once.
 */
import { describe, expect, it, vi } from 'vitest';
import { createGroupRegistration } from '../src/group-registration.ts';

const candidatesByGroup: Record<string, string[]> = {
  standard: ['mistral/m-large'],
  planning: ['anthropic/a-big'],
};

function setup(windows: Record<string, number> = { 'mistral/m-large': 128_000 }) {
  const registerProvider = vi.fn();
  const groupStream = vi.fn();
  const cfg = {
    model_groups: { standard: {}, planning: {}, dynamic: { method: 'dynamic' } },
  } as any;
  const reg = createGroupRegistration({
    cache: {} as any,
    cfg,
    getM: () => ({}) as any,
    groupStream: groupStream as any,
    pi: { registerProvider } as any,
    resolve: (name: string) =>
      candidatesByGroup[name]
        ? { selected: candidatesByGroup[name][0], candidates: candidatesByGroup[name] }
        : null,
    sessionCtx: null,
    contextWindow: (ref: string) => windows[ref] ?? null,
  });
  const providerOf = (id: string): any =>
    registerProvider.mock.calls.map((c: any[]) => c[0]).find((p: any) => p?.id === id);
  return { reg, registerProvider, groupStream, providerOf, windows };
}

describe('group providers are hidden native providers', () => {
  it('registers each group as a native provider object, not a name + config', () => {
    const { reg, registerProvider } = setup();
    reg.registerGroupProviders();
    expect(registerProvider.mock.calls.length).toBe(3);
    for (const call of registerProvider.mock.calls) {
      expect(call).toHaveLength(1);
      expect(typeof call[0]).toBe('object');
    }
  });

  it('lists the group models in the catalog and none as available', () => {
    const { reg, providerOf } = setup();
    reg.registerGroupProviders();
    const dynamic = providerOf('dynamic');
    // The `<group>:use-static` variant is gone: one catalog entry per group.
    expect(dynamic.getModels().map((m: any) => m.id)).toEqual(['dynamic']);
    expect(dynamic.filterModels(dynamic.getModels(), undefined)).toEqual([]);
    expect(providerOf('standard').getModels()[0]).toMatchObject({
      id: 'standard',
      provider: 'standard',
      contextWindow: 128_000,
    });
  });

  it('is configured without any credential (route() needs it)', async () => {
    const { reg, providerOf } = setup();
    reg.registerGroupProviders();
    const resolved = await providerOf('planning').auth.apiKey.resolve({} as any);
    expect(resolved).toBeTruthy();
  });

  it('streams through the router (groupStream) for both stream entry points', () => {
    const { reg, providerOf, groupStream } = setup();
    reg.registerGroupProviders();
    const p = providerOf('standard');
    const model = p.getModels()[0];
    p.streamSimple(model, { messages: [] }, {});
    p.stream(model, { messages: [] }, {});
    expect(groupStream).toHaveBeenCalledTimes(2);
    expect(groupStream.mock.calls[0][0]).toBe(model);
  });
});

describe('registered once, served live (spike condition G1b)', () => {
  it('a second registerGroupProviders() (session_start) registers nothing again', () => {
    const { reg, registerProvider } = setup();
    reg.registerGroupProviders();
    registerProvider.mockClear();
    reg.registerGroupProviders();
    expect(registerProvider).not.toHaveBeenCalled();
  });

  it('a refreshed resolution still reaches the catalog (live getModels)', () => {
    const { reg, providerOf, windows } = setup();
    reg.registerGroupProviders();
    windows['mistral/m-large'] = 200_000;
    reg.registerGroupProviders();
    expect(providerOf('standard').getModels()[0].contextWindow).toBe(200_000);
  });

  it('declared cache economics show up live, without a re-registration', () => {
    const { reg, registerProvider, providerOf } = setup();
    reg.registerGroupProviders();
    const planning = providerOf('planning');
    registerProvider.mockClear();
    const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
    reg.declareCacheEconomics('planning', 'planning', {
      cost,
      promptCache: { ttlSeconds: 300 },
    } as any);
    expect(registerProvider).not.toHaveBeenCalled();
    expect(planning.getModels()[0]).toMatchObject({
      cost,
      promptCache: { ttlSeconds: 300 },
    });
  });
});
