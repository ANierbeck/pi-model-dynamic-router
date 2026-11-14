// `/router corrections [list|clear]` (ADR-0030 Option 1, step 3). Drives the
// real /router handler against a cache object: the listing, the clear, the
// persistence call and the usage line. The rejected form must not touch the
// store.

import { describe, it, expect, vi } from 'vitest';
import { createCommands } from '../src/commands.ts';

type Handler = (args: string, ctx: any) => Promise<void>;

function setup(cache: Record<string, unknown>): {
  run: (args: string) => Promise<string[]>;
  complete: (prefix: string) => Array<{ value: string }> | null;
  saveCache: ReturnType<typeof vi.fn>;
} {
  let handler: Handler | undefined;
  let complete: ((prefix: string) => Array<{ value: string }> | null) | undefined;
  const saveCache = vi.fn();
  const rt: any = {
    pi: {
      registerCommand: (name: string, def: any) => {
        if (name === 'router') {
          handler = def.handler;
          complete = def.getArgumentCompletions;
        }
      },
    },
    load: () => {},
    sessionCtx: undefined,
    router: { setSessionCtx: () => {} },
    cfg: { model_groups: {} },
    cache,
    cacheManager: { saveCache },
  };
  createCommands(rt);
  return {
    run: async (args: string) => {
      const notes: string[] = [];
      await handler!(args, { ui: { notify: (m: string) => notes.push(m) } });
      return notes;
    },
    complete: complete!,
    saveCache,
  };
}

const CONTENT = 'Design a rollout plan for the new cache layer';

describe('/router corrections', () => {
  it('lists the saved corrections with their category and time', async () => {
    const { run } = setup({
      hint_corrections: {
        [CONTENT]: {
          hintType: 'category',
          target: 'planning',
          savedAt: '2026-11-14T10:00:00.000Z',
        },
      },
    });
    const out = (await run('corrections')).join('\n');
    expect(out).toContain(CONTENT);
    expect(out).toContain('planning');
    expect(out).toContain('2026-11-14T10:00:00.000Z');
  });

  it('says so when nothing is saved, for both the bare form and list', async () => {
    const { run } = setup({});
    expect((await run('corrections')).join('\n')).toMatch(/No saved HINT corrections/);
    expect((await run('corrections list')).join('\n')).toMatch(/No saved HINT corrections/);
  });

  it('clear empties the store, persists it, and reports the count', async () => {
    const cache: any = {
      hint_corrections: {
        [CONTENT]: { hintType: 'category', target: 'planning', savedAt: 'x' },
      },
    };
    const { run, saveCache } = setup(cache);
    const out = (await run('corrections clear')).join('\n');
    expect(out).toMatch(/Cleared 1 saved HINT correction/);
    expect(cache.hint_corrections).toEqual({});
    expect(saveCache).toHaveBeenCalledTimes(1);
  });

  it('an unknown subcommand prints the usage line and changes nothing', async () => {
    const cache: any = {
      hint_corrections: {
        [CONTENT]: { hintType: 'category', target: 'planning', savedAt: 'x' },
      },
    };
    const { run, saveCache } = setup(cache);
    const out = (await run('corrections purge')).join('\n');
    expect(out).toMatch(/Usage: \/router corrections \[list\|clear\]/);
    expect(Object.keys(cache.hint_corrections)).toHaveLength(1);
    expect(saveCache).not.toHaveBeenCalled();
  });

  it('is offered by tab completion', () => {
    const { complete } = setup({});
    expect((complete('cor') ?? []).map((i) => i.value)).toContain('corrections');
  });
});
