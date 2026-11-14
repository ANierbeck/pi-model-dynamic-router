// `/router classifier [days]` wiring (ADR-0027 Phase 5). Drives the real
// /router handler against a decision log in a temp home directory, so the pin
// covers the file read, the window and the output text together. The home is
// mocked through node:os: a worker thread does not propagate a process.env.HOME
// change to os.homedir().

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCommands } from '../src/commands.ts';

const fakeHome = vi.hoisted(() => ({ dir: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fakeHome.dir || actual.homedir() };
});

type Handler = (args: string, ctx: any) => Promise<void>;

function registerRouter(): {
  handler: Handler;
  complete: (prefix: string) => Array<{ value: string }> | null;
} {
  let handler: Handler | undefined;
  let complete: ((prefix: string) => Array<{ value: string }> | null) | undefined;
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
    cache: {},
  };
  createCommands(rt);
  return { handler: handler!, complete: complete! };
}

async function run(handler: Handler, args: string): Promise<string[]> {
  const notes: string[] = [];
  await handler(args, { ui: { notify: (m: string) => notes.push(m) } });
  return notes;
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'classifier-summary-cmd-'));
  mkdirSync(path.join(home, '.pi', 'logs'), { recursive: true });
  fakeHome.dir = home;
});

afterEach(() => {
  fakeHome.dir = '';
  rmSync(home, { recursive: true, force: true });
});

function writeLog(records: Array<Record<string, unknown>>): void {
  const lines = records.map((r) => JSON.stringify(r)).join('\n');
  writeFileSync(path.join(home, '.pi', 'logs', 'classifier-decisions.jsonl'), lines + '\n');
}

function routing(ts: string, stage: string): Record<string, unknown> {
  return {
    v: 1,
    ts,
    proc: 'test',
    stage,
    answered_by: null,
    chain: [],
    cache_origin: null,
    raw: { category: 'code_simple', confidence: 0.9, reason: null },
    prev: null,
    final: { category: 'code_simple', group: 'simple', hint: null, reason: null },
    steps: [],
    ms: 120,
    input: { sha: 'x', len: 10, words: 2, lang: 'en' },
  };
}

describe('/router classifier', () => {
  it('prints the window summary read from the decision log', async () => {
    writeLog([
      routing(new Date().toISOString(), 'llm-cloud'),
      routing(new Date().toISOString(), 'cache'),
    ]);
    const { handler } = registerRouter();
    const notes = await run(handler, 'classifier 3');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/Classifier decisions, last 3 days: 2/);
    expect(notes[0]).toMatch(/Stages: llm-cloud 1, cache 1/);
  });

  it('defaults to 7 days when no number is given', async () => {
    writeLog([routing(new Date().toISOString(), 'llm-cloud')]);
    const { handler } = registerRouter();
    const notes = await run(handler, 'classifier');
    expect(notes[0]).toMatch(/last 7 days: 1/);
  });

  it('ignores records older than the window', async () => {
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
    writeLog([routing(old, 'llm-cloud')]);
    const { handler } = registerRouter();
    const notes = await run(handler, 'classifier 7');
    expect(notes[0]).toMatch(/no routing decisions in the last 7 days/);
  });

  it('rejects an out-of-range or non-numeric window with the usage line', async () => {
    const { handler } = registerRouter();
    for (const bad of ['classifier 0', 'classifier 91', 'classifier abc']) {
      const notes = await run(handler, bad);
      expect(notes[0]).toMatch(/Usage: \/router classifier \[days\] \(1\.\.90, default 7\)/);
    }
  });

  it('is offered in TAB completion', () => {
    const { complete } = registerRouter();
    const values = (complete('') ?? []).map((i) => i.value);
    expect(values).toContain('classifier');
  });
});
