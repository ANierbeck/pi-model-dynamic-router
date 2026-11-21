// test/router-overview-session-group.test.ts
// Virtual-models migration step 2 (review 2026-11-21, Important 4): on
// `router/dynamic` the session's group is the one route() last dispatched it
// to. The bare /router overview marks that group's header with ◀. Before,
// the marker did not depend on the group at all: once the session had
// streamed (curModel known), every group header carried it.

import { describe, it, expect } from 'vitest';
import { createCommands } from '../src/commands.ts';
import { createPinHandoff, createServedGroups } from '../src/virtual-selection.ts';

const GROUPS = {
  dynamic: { method: 'dynamic' },
  planning: { method: 'best' },
  simple: { method: 'tiered' },
};
const VIRTUAL = { provider: 'router', id: 'dynamic', api: 'pi-virtual' };

type Handler = (args: string, ctx: unknown) => Promise<void>;

async function overviewHeaders(
  model: { provider: string; id: string } | undefined,
  servedGroup?: string
): Promise<string[]> {
  let handler: Handler | undefined;
  const served = createServedGroups();
  if (servedGroup) served.record('S', servedGroup);
  const rt = {
    pi: {
      registerCommand: (name: string, d: { handler: Handler }) => {
        if (name === 'router') handler = d.handler;
      },
    },
    load: () => {},
    sessionCtx: undefined,
    router: { setSessionCtx: () => {} },
    cfg: { model_groups: GROUPS },
    cache: {},
    served,
    pins: createPinHandoff(),
    curModel: 'paid-cloud-provider/paid-model',
    resolve: () => null,
    rateLimitManager: { getLimits: () => new Map() },
    isLimited: () => false,
    getTopModels: () => ({ models: [], total: 0 }),
    allDiscoveredRefs: () => ['paid-cloud-provider/paid-model'],
  };
  createCommands(rt as never);
  const notes: string[] = [];
  await handler!('', {
    model,
    sessionManager: { getSessionId: () => 'S' },
    ui: { notify: (m: string) => notes.push(m) },
  });
  return notes
    .join('\n')
    .split('\n')
    .filter((l) => l.startsWith('┌─ '));
}

const marked = (headers: string[]): string[] =>
  headers.filter((h) => h.includes('◀')).map((h) => h.split(/\s+/)[1]!);

describe('/router overview marks the session’s group', () => {
  it('on router/dynamic: the group route() served last', async () => {
    expect(marked(await overviewHeaders(VIRTUAL, 'planning'))).toEqual(['planning']);
  });

  it('on router/dynamic before any request: the classifying group', async () => {
    expect(marked(await overviewHeaders(VIRTUAL))).toEqual(['dynamic']);
  });

  it('on a group model: that group', async () => {
    expect(marked(await overviewHeaders({ provider: 'simple', id: 'simple:use-static' }))).toEqual([
      'simple',
    ]);
  });

  it('on a concrete model: no group', async () => {
    expect(
      marked(await overviewHeaders({ provider: 'paid-cloud-provider', id: 'paid-model' }))
    ).toEqual([]);
  });
});
