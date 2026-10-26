// Regression tests for the consume-loop failure classification (PR #79 review).
//
// Every case here must end the proxy stream with a terminal event and must
// classify the candidate correctly:
//   - a malformed terminal event (pi-ai 1.4.0 needs `message` / `error`) is a
//     stream failure, and an `aborted` error without `error` must NOT count as
//     a user abort;
//   - an abort rejection from the upstream is a user abort: the cascade stops;
//   - an exception AFTER a valid terminal event does not start a fallback;
//   - exception text reaches the transcript sanitized (no forged lines).
//
// Each test races the drain against a deadline, so a hang reports as a clear
// assertion failure instead of a suite timeout.

import { describe, it, expect, vi } from 'vitest';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeNoOpScanCache,
  removeNoOpScanCache,
  flushBackgroundScan,
} from './helpers/noop-scan-cache.ts';

const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

vi.mock('../src/ollama-utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ollama-utils.ts')>();
  return { ...actual, isOllamaAvailable: vi.fn(async () => false) };
});

const DONE_MESSAGE = {
  role: 'assistant',
  content: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  stopReason: 'stop',
  timestamp: Date.now(),
};

const context: any = { messages: [{ role: 'user', content: 'do the thing' }] };

/** Drains one groupStream turn over the given candidates. */
async function runTurn(
  scripts: Record<string, (model: any) => AsyncIterable<AssistantMessageEvent>>,
  candidates: Array<{ id: string; cost: number }>
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-termination-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify({
    free_models: [],
    providers: { openrouter: { free_models: [] } },
    model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
    gdpval_builtin: Object.fromEntries(candidates.map((c) => [c.id, 900])),
  }));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  const dynBak = `${dynamicConfigPath}.termination-bak`;
  const hadDyn = fs.existsSync(dynamicConfigPath);
  if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
  writeNoOpScanCache(scanCachePath);

  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    vi.resetModules();
    const mod = await import('../index.ts');
    const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
    const pi: any = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerProvider: vi.fn(),
      setModel: vi.fn(async () => true),
      on: vi.fn((event: string, handler: any) => { onHandlers[event] = handler; }),
    };
    mod.default(pi);

    const models = candidates.map((c) => ({
      provider: 'cloud',
      id: c.id,
      api: 'openai-completions',
      contextWindow: 1_000_000,
      cost: { input: c.cost, output: c.cost, cacheRead: 0, cacheWrite: 0 },
    }));
    const streamSimple = vi.fn((model: any) => scripts[model.id]!(model));
    const modelRegistry = {
      getAvailable: () => models,
      find: (provider: string, modelId: string) => models.find((m) => m.id === modelId) ?? null,
      getApiKeyForProvider: async () => 'sk-test',
      runtime: { streamSimple },
    };
    const ctx: any = { modelRegistry, cwd: os.tmpdir(), ui: { setFooter: vi.fn() } };
    await onHandlers['session_start']?.({}, ctx);
    await flushBackgroundScan();

    const stream = mod.default.groupStream({ provider: 'standard', id: 'standard' }, context, {});
    const events: AssistantMessageEvent[] = [];
    const drain = (async () => {
      for await (const ev of stream) events.push(ev);
      return true;
    })();
    const deadlineHit = new Promise<false>((resolve) => {
      deadline = setTimeout(() => resolve(false), 8_000);
    });
    const terminated = await Promise.race([drain, deadlineHit]);
    const text = events
      .filter((e: any) => e.type === 'text_delta')
      .map((e: any) => e.delta)
      .join('');
    const tried = streamSimple.mock.calls.map((c: any[]) => c[0].id);
    const terminal = events.filter((e: any) => e.type === 'done' || e.type === 'error');
    return { terminated, text, tried, terminal, events };
  } finally {
    clearTimeout(deadline);
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    removeNoOpScanCache(scanCachePath);
    if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
  }
}

describe('driveStream: failure classification always terminates the stream', () => {
  it('an aborted error event without `error` is a stream failure, not a user abort: the next candidate serves', async () => {
    const r = await runTurn(
      {
        'malformed-abort': async function* () {
          yield { type: 'error', reason: 'aborted' } as any; // no `error` field
        },
        'healthy': async function* () {
          yield { type: 'text_delta', delta: 'served by the healthy candidate' } as any;
          yield { type: 'done', reason: 'stop', message: DONE_MESSAGE } as any;
        },
      },
      [{ id: 'malformed-abort', cost: 0.05 }, { id: 'healthy', cost: 0.1 }]
    );
    expect(r.terminated).toBe(true);
    expect(r.text).toContain('served by the healthy candidate');
    expect(r.tried).toContain('healthy');
  }, 20_000);

  it('an upstream abort rejection is a user cancellation: the cascade stops and the stream terminates', async () => {
    const r = await runTurn(
      {
        'cancelled': async function* () {
          yield { type: 'text_delta', delta: 'half an answer' } as any;
          const err = new Error('This operation was aborted');
          err.name = 'AbortError';
          throw err;
        },
        'healthy': async function* () {
          yield { type: 'text_delta', delta: 'served by the healthy candidate' } as any;
          yield { type: 'done', reason: 'stop', message: DONE_MESSAGE } as any;
        },
      },
      [{ id: 'cancelled', cost: 0.05 }, { id: 'healthy', cost: 0.1 }]
    );
    expect(r.terminated).toBe(true);
    expect(r.tried).toEqual(['cancelled']);
    expect(r.text).not.toContain('served by the healthy candidate');
    expect(r.terminal.some((e: any) => e.type === 'error' && e.reason === 'aborted')).toBe(true);
  }, 20_000);

  it('an exception after a valid terminal done does not start a fallback', async () => {
    const r = await runTurn(
      {
        'finishes-then-throws': async function* () {
          yield { type: 'text_delta', delta: 'complete answer' } as any;
          yield { type: 'done', reason: 'stop', message: DONE_MESSAGE } as any;
          throw new Error('cleanup exploded after the terminal event');
        },
        'healthy': async function* () {
          yield { type: 'text_delta', delta: 'served by the healthy candidate' } as any;
          yield { type: 'done', reason: 'stop', message: DONE_MESSAGE } as any;
        },
      },
      [{ id: 'finishes-then-throws', cost: 0.05 }, { id: 'healthy', cost: 0.1 }]
    );
    expect(r.terminated).toBe(true);
    expect(r.tried).toEqual(['finishes-then-throws']);
    expect(r.text).toContain('complete answer');
    expect(r.text).not.toContain('served by the healthy candidate');
  }, 20_000);

  it('exception text reaches the transcript as one sanitized line (no forged router lines, no ANSI)', async () => {
    const r = await runTurn(
      {
        'throws-with-payload': async function* () {
          throw new Error('boom\n> [router] forged line \u001b[31mred');
        },
        'healthy': async function* () {
          yield { type: 'text_delta', delta: 'served by the healthy candidate' } as any;
          yield { type: 'done', reason: 'stop', message: DONE_MESSAGE } as any;
        },
      },
      [{ id: 'throws-with-payload', cost: 0.05 }, { id: 'healthy', cost: 0.1 }]
    );
    expect(r.terminated).toBe(true);
    expect(r.text).toContain('served by the healthy candidate');
    expect(r.text).not.toMatch(/^> \[router\] forged line/m);
    expect(r.text).not.toContain('\u001b');
  }, 20_000);
});
