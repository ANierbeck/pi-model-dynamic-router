// test/fallback-exit-characterization.test.ts
// Characterization of every place where the dynamic router falls back to the
// cheap group, and of the shipped failover chains.
//
// Step 1 of docs/plans/2026-10-25-category-group-mismatch.md and Round 1 of
// docs/plans/2026-10-25-fallback-naming.md: the original pins captured the
// pre-2.0 exits into the group literally named `fallback`. With D4 (the
// cheap-group merge) shipped, the three exits and the tool follow-up pool
// point at `simple` instead — this file pins the NEW behaviour, so every
// later change is a deliberate, visible edit of this file.
//
// Already pinned elsewhere and NOT repeated here: the category → group table
// (category-groups.test.ts, consolidated-classifier-pins.test.ts), the global
// FALLBACK_GROUP_ORDER (fallback-chain.test.ts) and detectGroup's unrestricted
// tier list (display-dispatch.test.ts).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { StreamOrchestrator } from '../src/stream-orchestrator.ts';

// The orchestrator logs through the shared file logger; keep the tests off
// the real log files.
vi.mock('../src/logger.ts', async (orig) => {
  const actual = await orig<typeof import('../src/logger.ts')>();
  return { ...actual, appendRawLog: vi.fn(), routerLog: vi.fn(), warnLog: vi.fn(), errorLog: vi.fn() };
});

// ── Orchestrator harness ──────────────────────────────────────────────────

type Resolution = { candidates: string[]; selected: string };

interface Harness {
  orch: StreamOrchestrator;
  ctx: any;
  drive: ReturnType<typeof vi.spyOn>;
  proxy: () => any;
}

/**
 * A dynamic group `dynamic` plus the given resolvable groups. `resolvable`
 * maps a group name to its resolution; every other name resolves to null.
 */
function harness(opts: {
  groups: string[];
  resolvable: Record<string, Resolution>;
  classify?: () => Promise<any>;
  lastDynamicModel?: string;
  toolFollowUp?: boolean;
}): Harness & { call: () => any; resolveCalls: string[] } {
  const model_groups: Record<string, any> = { dynamic: { method: 'dynamic' } };
  for (const g of opts.groups) model_groups[g] = { method: 'best' };
  const resolveCalls: string[] = [];

  const ctx: any = {
    cfg: { model_groups, model_metrics: {} },
    cache: {},
    router: {},
    lastDynamicModel: opts.lastDynamicModel ?? '',
    lastClassifiedCategory: undefined,
    escalation: { level: 'standard' },
    sessionCtx: undefined,
    resolve: (name: string) => {
      resolveCalls.push(name);
      const r = opts.resolvable[name];
      return r ? { candidates: [...r.candidates], selected: r.selected } : null;
    },
    extractLastUserPrompt: () => 'please do the thing',
    extractLastAssistantSnippet: () => undefined,
    detectHintDirectly: () => null,
    isCompactionTurn: () => false,
    isLimited: () => false,
    getGroupForCategory: (category: string) => (category === 'standard' ? 'standard' : 'code_complex'),
    classifyPrompt: opts.classify ?? (async () => ({ category: 'standard' })),
  };

  const orch = new StreamOrchestrator(ctx);
  const drive = vi.spyOn(orch, 'driveStream').mockResolvedValue(undefined as never);
  let proxy: any;

  const messages = opts.toolFollowUp
    ? [
        { role: 'user', content: 'run it', timestamp: 1 },
        { role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }], timestamp: 2 },
      ]
    : [{ role: 'user', content: 'please do the thing', timestamp: 1 }];

  const call = () => {
    proxy = orch.groupStream(
      { provider: 'router', id: 'dynamic', api: 'openai-completions' } as any,
      { messages } as any,
      undefined,
    );
    return proxy;
  };
  return { orch, ctx, drive, proxy: () => proxy, call, resolveCalls };
}

/** driveStream is called as (proxy, candidates, context, options, label, group, …). */
const driven = (drive: Harness['drive']) => {
  const a = drive.mock.calls[0] as unknown as any[];
  return { candidates: a[1] as string[], label: a[4] as string | undefined, group: a[5] as string | undefined };
};

beforeEach(() => vi.clearAllMocks());

// ── Exit 1: the classified target group cannot be resolved ────────────────

describe("exit: classified target group unresolvable → group 'simple' (D4)", () => {
  it('resolves `simple` instead and keeps the label of the ORIGINAL target', async () => {
    const h = harness({
      groups: ['standard', 'simple'],
      resolvable: { simple: { candidates: ['free/a', 'free/b'], selected: 'free/a' } },
    });
    h.call();
    await vi.waitFor(() => expect(h.drive).toHaveBeenCalledTimes(1));

    const d = driven(h.drive);
    expect(d.group).toBe('simple');
    expect(d.candidates).toEqual(['free/a', 'free/b']);
    // Quirk worth pinning: the label still names the unresolvable target,
    // while the stream runs in `simple`.
    expect(d.label).toBe('standard → standard');
    expect(h.resolveCalls).toEqual(['standard', 'simple']);
    // The next classification sees the fallback pick as the last model.
    expect(h.ctx.lastDynamicModel).toBe('free/a');
  });

  it('a resolvable target never touches `simple`', async () => {
    const h = harness({
      groups: ['standard', 'simple'],
      resolvable: {
        standard: { candidates: ['mid/a'], selected: 'mid/a' },
        simple: { candidates: ['free/a'], selected: 'free/a' },
      },
    });
    h.call();
    await vi.waitFor(() => expect(h.drive).toHaveBeenCalledTimes(1));

    expect(driven(h.drive).group).toBe('standard');
    expect(h.resolveCalls).not.toContain('simple');
    expect(h.ctx.lastDynamicModel).toBe('mid/a');
  });
});

// ── Exit 2: classification throws ─────────────────────────────────────────

describe("exit: classification fails → group 'simple' (D4)", () => {
  it('streams from `simple` with no dynamic label', async () => {
    // `alpha` comes first in config order: a wrong group name would land there.
    const h = harness({
      groups: ['alpha', 'simple'],
      resolvable: { simple: { candidates: ['free/a', 'free/b'], selected: 'free/a' } },
      classify: async () => {
        throw new Error('classifier down');
      },
    });
    h.call();
    await vi.waitFor(() => expect(h.drive).toHaveBeenCalledTimes(1));

    const d = driven(h.drive);
    expect(d.group).toBe('simple');
    expect(d.candidates).toEqual(['free/a', 'free/b']);
    expect(d.label).toBeUndefined();
  });

  it('with `simple` unresolvable it takes the FIRST non-dynamic group in config order', async () => {
    const h = harness({
      groups: ['alpha', 'beta', 'simple'],
      resolvable: { alpha: { candidates: ['a/1'], selected: 'a/1' }, beta: { candidates: ['b/1'], selected: 'b/1' } },
      classify: async () => {
        throw new Error('classifier down');
      },
    });
    h.call();
    await vi.waitFor(() => expect(h.drive).toHaveBeenCalledTimes(1));

    const d = driven(h.drive);
    expect(d.group).toBe('alpha');
    expect(d.candidates).toEqual(['a/1']);
    expect(h.resolveCalls).toEqual(['simple', 'alpha']);
  });

  it('with nothing resolvable it does not stream; the proxy ends in an error event', async () => {
    const h = harness({
      groups: ['alpha', 'simple'],
      resolvable: {},
      classify: async () => {
        throw new Error('classifier down');
      },
    });
    const proxy = h.call();
    const first = await proxy[Symbol.asyncIterator]().next();

    expect(h.drive).not.toHaveBeenCalled();
    expect(first.value.type).toBe('error');
    expect(JSON.stringify(first.value)).toContain('Dynamic routing failed');
  });
});

// ── Exit 3: tool follow-up step ───────────────────────────────────────────

describe("exit: tool follow-up step → pool 'simple' behind the last model (D4)", () => {
  it('skips classification and puts the last model first, de-duplicated', async () => {
    const classify = vi.fn(async () => ({ category: 'standard' }));
    const h = harness({
      groups: ['alpha', 'simple'],
      toolFollowUp: true,
      lastDynamicModel: 'free/b',
      resolvable: { simple: { candidates: ['free/a', 'free/b', 'free/c'], selected: 'free/a' } },
      classify,
    });
    h.call();
    await vi.waitFor(() => expect(h.drive).toHaveBeenCalledTimes(1));

    const d = driven(h.drive);
    expect(classify).not.toHaveBeenCalled();
    expect(d.group).toBe('simple');
    expect(d.candidates).toEqual(['free/b', 'free/a', 'free/c']);
  });

  it('prepends the last model when the pool does not contain it', async () => {
    const h = harness({
      groups: ['alpha', 'simple'],
      toolFollowUp: true,
      lastDynamicModel: 'top/x',
      resolvable: { simple: { candidates: ['free/a'], selected: 'free/a' } },
    });
    h.call();
    await vi.waitFor(() => expect(h.drive).toHaveBeenCalledTimes(1));

    expect(driven(h.drive).candidates).toEqual(['top/x', 'free/a']);
  });

  it('with `simple` unresolvable it uses the first non-dynamic group', async () => {
    const h = harness({
      groups: ['alpha', 'simple'],
      toolFollowUp: true,
      lastDynamicModel: 'top/x',
      resolvable: { alpha: { candidates: ['a/1'], selected: 'a/1' } },
    });
    h.call();
    await vi.waitFor(() => expect(h.drive).toHaveBeenCalledTimes(1));

    const d = driven(h.drive);
    expect(d.group).toBe('alpha');
    expect(d.candidates).toEqual(['top/x', 'a/1']);
  });
});

// ── The shipped failover chains ───────────────────────────────────────────

describe('shipped router-config.json failover chains', () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../router-config.json', import.meta.url), 'utf8'));
  const chains: Record<string, string[] | undefined> = Object.fromEntries(
    Object.entries<any>(shipped.model_groups).map(([name, g]) => [name, g.fallback_groups]),
  );

  it('pins every group and its chain, exactly', () => {
    expect(chains).toEqual({
      simple: ['standard'],
      standard: ['simple'],
      code_complex: ['planning', 'standard', 'simple'],
      design: ['planning', 'code_complex', 'standard', 'simple'],
      planning: ['code_complex', 'standard', 'simple'],
      dynamic: undefined,
      bulk_reader: ['standard', 'simple'],
      code_writer: ['standard', 'simple'],
    });
  });

  it('six chains end in `simple`; the group itself and `dynamic` have none', () => {
    const endsInSimple = Object.entries(chains)
      .filter(([, c]) => c && c[c.length - 1] === 'simple')
      .map(([name]) => name)
      .sort();
    expect(endsInSimple).toEqual(
      ['bulk_reader', 'code_complex', 'code_writer', 'design', 'planning', 'standard'],
    );
    expect(chains.simple).toEqual(['standard']);
    expect(chains.dynamic).toBeUndefined();
  });

  it('every chain entry names a group that exists', () => {
    for (const [name, chain] of Object.entries(chains)) {
      for (const target of chain ?? []) {
        expect(Object.keys(chains), `${name} → ${target}`).toContain(target);
      }
    }
  });
});
