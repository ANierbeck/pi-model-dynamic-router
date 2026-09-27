/**
 * Regression tests for the 2026-09-27 afternoon incident ("models stop right
 * before finishing, restart on another model, Claude usage jumps to ~50%").
 *
 * Root causes (router.log 13:30–13:47, 25 mid-stream kills of paid/subscription
 * models after 2.6–32.7s of healthy streaming, zero of them real API limits):
 *
 *  1. consumeWithDetection scanned the MODEL'S OWN text_delta output against
 *     the rate-limit pattern table ('rate limit', 'out of', 'exceeded',
 *     'quota', 'credits', 'overloaded', ...). Any answer that merely talked
 *     about limits — e.g. while debugging the router's own limit handling —
 *     was killed mid-sentence, discarded, and restarted on the next candidate.
 *     The scan was also useless for its stated purpose: pi-claude-bridge
 *     (v0.8.0) reports a real Claude limit as an `error` EVENT whose
 *     errorMessage starts with "Claude rate limit", and its yellow warning is
 *     a piUI.notify UI notification that never enters the stream.
 *
 *  2. The router never aborted an abandoned candidate. claude-bridge only
 *     cancels its Claude Agent SDK query on options.signal abort, so every
 *     discarded attempt kept running to completion in the background —
 *     burning subscription tokens for an answer nobody read, and piling
 *     concurrent queries onto the bridge's shared session.
 *
 *  3. After an empty/stall timeout the consumer loop kept running and kept
 *     forwarding the abandoned stream's late events into the proxy — i.e.
 *     into the output of whichever candidate had taken over.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeNoOpScanCache, removeNoOpScanCache, flushBackgroundScan } from './helpers/noop-scan-cache.ts';

const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

async function withIsolatedRouter(
  configOverride: Record<string, unknown>,
  fn: (defaultExport: any) => Promise<void>
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-abandon-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const dynBak = `${dynamicConfigPath}.abandon-bak`;
  const cacheBak = `${scanCachePath}.abandon-bak`;
  const hadDyn = fs.existsSync(dynamicConfigPath);
  const hadCache = fs.existsSync(scanCachePath);
  if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
  if (hadCache) fs.renameSync(scanCachePath, cacheBak);

  writeNoOpScanCache(scanCachePath);

  try {
    vi.resetModules();
    const mod = await import('../index.ts');
    await fn(mod.default as any);
  } finally {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
    removeNoOpScanCache(scanCachePath);
    if (hadCache) fs.renameSync(cacheBak, scanCachePath);
  }
}

type StreamScript = (signal: AbortSignal | undefined) => AsyncIterable<AssistantMessageEvent>;

/** Mock registry: each model serves the script for its N-th call (last one
 * repeats) and every call's options.signal is recorded for inspection. */
function makeRegistry(modelsByRef: Record<string, any>) {
  const calls: { ref: string; signal: AbortSignal | undefined }[] = [];
  const scripts: Record<string, StreamScript[]> = {};
  const modelList = Object.entries(modelsByRef).map(([ref, model]) => ({ ref, model }));

  const streamSimple = vi.fn((model: any, _context: any, options: any) => {
    const ref = modelList.find((e) => e.model.id === model.id)!.ref;
    const signal: AbortSignal | undefined = options?.signal;
    calls.push({ ref, signal });
    const script = scripts[ref] ?? [];
    const idx = calls.filter((c) => c.ref === ref).length - 1;
    const run = idx < script.length ? script[idx] : script[script.length - 1];
    return run(signal);
  });

  return {
    calls,
    scripts,
    registry: {
      getAvailable: () => modelList.map((e) => e.model),
      find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
      getApiKeyForProvider: async () => null,
      runtime: { streamSimple },
    },
  };
}

function textEvents(text: string, stopReason = 'stop'): AssistantMessageEvent[] {
  return [
    { type: 'text_delta', contentIndex: 0, delta: text, partial: { role: 'assistant', content: [{ type: 'text', text }], stopReason } } as any,
    { type: 'done', reason: stopReason, message: { role: 'assistant', content: [{ type: 'text', text }], stopReason } } as any,
  ];
}

const scripted = (events: AssistantMessageEvent[]): StreamScript => () =>
  (async function* () { for (const ev of events) yield ev; })();

const model = (provider: string, id: string) => ({
  provider, id, api: `${provider}-api`,
  contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
});

const baseCfg = {
  free_models: [],
  providers: { openrouter: { free_models: [] } },
  model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
  gdpval_builtin: { 'first-model': 1000, 'second-model': 900 },
  empty_response_timeout_ms: 5_000,
  reasoning_empty_response_timeout_ms: 5_000,
  stall_timeout_ms: 30_000,
  // Keep the ADR-0017 wait path out of these tests — they are about detection
  // and cancellation, not about waiting for resets.
  rate_limit_wait_max_ms: 0,
};

async function runGroupStream(defaultExport: any, registry: any) {
  const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
  const pi: any = {
    registerTool: vi.fn(), registerCommand: vi.fn(), registerProvider: vi.fn(),
    setModel: vi.fn(async () => true),
    on: vi.fn((event: string, handler: any) => { onHandlers[event] = handler; }),
  };
  defaultExport(pi);
  const ctx: any = { modelRegistry: registry, cwd: os.tmpdir(), ui: { setFooter: vi.fn() } };
  await onHandlers['session_start']?.({}, ctx);
  await flushBackgroundScan();
  const context: any = { messages: [{ role: 'user', content: 'explain the limit handling' }] };
  return drainStream(defaultExport.groupStream({ provider: 'standard', id: 'standard' }, context, {}));
}

const joinedText = (events: AssistantMessageEvent[]) =>
  events.filter((e: any) => e.type === 'text_delta').map((e: any) => e.delta ?? '').join('');

describe('consumeWithDetection: model prose is never scanned for rate-limit words', () => {
  it('an answer that talks about rate limits, quotas and "3 out of 5" streams through untouched', async () => {
    await withIsolatedRouter(baseCfg, async (defaultExport) => {
      const mock = makeRegistry({
        'p1/first-model': model('p1', 'first-model'),
        'p2/second-model': model('p2', 'second-model'),
      });
      const prose =
        'The router hit a rate limit on 3 out of 5 models; the spend limit and quota were exceeded, ' +
        'credits ran low and one provider was overloaded. Here is the fix.';
      mock.scripts['p1/first-model'] = [scripted(textEvents(prose))];
      mock.scripts['p2/second-model'] = [scripted(textEvents('SHOULD NEVER BE SERVED'))];

      const events = await runGroupStream(defaultExport, mock.registry);

      expect(events.find((e: any) => e.type === 'error')).toBeUndefined();
      expect(joinedText(events)).toContain('Here is the fix.');
      expect(joinedText(events)).not.toContain('SHOULD NEVER BE SERVED');
      // The false positive cascaded to the next candidate — must not happen.
      expect(mock.calls.map((c) => c.ref)).toEqual(['p1/first-model']);
    });
  }, 30_000);

  it('a real claude-bridge limit (error EVENT) still falls over to the next candidate', async () => {
    await withIsolatedRouter(baseCfg, async (defaultExport) => {
      const mock = makeRegistry({
        'p1/first-model': model('p1', 'first-model'),
        'p2/second-model': model('p2', 'second-model'),
      });
      // Shape emitted by pi-claude-bridge describeRateLimitFailure().
      mock.scripts['p1/first-model'] = [scripted([
        {
          type: 'error', reason: 'error',
          error: { stopReason: 'error', errorMessage: "Claude rate limit (five_hour): You're out of extra usage · resets 6:30pm" },
        } as any,
      ])];
      mock.scripts['p2/second-model'] = [scripted(textEvents('served by the fallback'))];

      const events = await runGroupStream(defaultExport, mock.registry);

      expect(joinedText(events)).toContain('served by the fallback');
      expect(mock.calls.map((c) => c.ref)).toEqual(['p1/first-model', 'p2/second-model']);
    });
  }, 30_000);
});

describe('consumeWithDetection: text overflow scan only looks at the start of an answer', () => {
  it('a long answer that quotes "prompt is too long" later on is NOT treated as a context overflow', async () => {
    await withIsolatedRouter(baseCfg, async (defaultExport) => {
      const mock = makeRegistry({
        'p1/first-model': model('p1', 'first-model'),
        'p2/second-model': model('p2', 'second-model'),
      });
      const prose = 'Compaction analysis. '.repeat(30) +
        'Mistral answered "prompt is too long" because the estimate undercounted tool results. Done.';
      mock.scripts['p1/first-model'] = [scripted(textEvents(prose))];
      mock.scripts['p2/second-model'] = [scripted(textEvents('SHOULD NEVER BE SERVED'))];

      const events = await runGroupStream(defaultExport, mock.registry);

      expect(events.find((e: any) => e.type === 'error')).toBeUndefined();
      expect(joinedText(events)).toContain('undercounted tool results. Done.');
      expect(mock.calls.map((c) => c.ref)).toEqual(['p1/first-model']);
    });
  }, 30_000);

  it('a short provider rejection sent as text is still detected as a context overflow', async () => {
    await withIsolatedRouter(baseCfg, async (defaultExport) => {
      const mock = makeRegistry({
        'p1/first-model': model('p1', 'first-model'),
        'p2/second-model': model('p2', 'second-model'),
      });
      mock.scripts['p1/first-model'] = [scripted(textEvents('Error: prompt is too long: 93022 tokens > 32768 maximum'))];
      mock.scripts['p2/second-model'] = [scripted(textEvents('served by the larger model'))];

      const events = await runGroupStream(defaultExport, mock.registry);
      const text = joinedText(events);

      // Detected as overflow: the router hands over to a larger-context
      // candidate (driveStream's context_overflow branch) ...
      expect(text).toMatch(/trying 1 larger model/);
      expect(text).toContain('served by the larger model');
      // ... and the raw rejection text never reaches the user.
      expect(text).not.toContain('93022 tokens > 32768');
      expect(mock.calls.map((c) => c.ref)).toEqual(['p1/first-model', 'p2/second-model']);
    });
  }, 30_000);
});

describe('driveStream: abandoned candidates are cancelled', () => {
  it('aborts the signal of a candidate it gives up on, but not of the one that succeeds', async () => {
    await withIsolatedRouter(baseCfg, async (defaultExport) => {
      const mock = makeRegistry({
        'p1/first-model': model('p1', 'first-model'),
        'p2/second-model': model('p2', 'second-model'),
      });
      mock.scripts['p1/first-model'] = [scripted([
        { type: 'error', reason: 'error', error: { errorMessage: 'upstream connection reset' } } as any,
      ])];
      mock.scripts['p2/second-model'] = [scripted(textEvents('ok from second', 'toolUse'))];

      await runGroupStream(defaultExport, mock.registry);

      expect(mock.calls.map((c) => c.ref)).toEqual(['p1/first-model', 'p2/second-model']);
      // Without a per-candidate signal the provider cannot be told to stop —
      // claude-bridge would keep its Claude query running in the background.
      expect(mock.calls[0].signal).toBeDefined();
      expect(mock.calls[0].signal!.aborted).toBe(true);
      // The winner must NOT be aborted: after a toolUse turn claude-bridge
      // keeps the same SDK query alive for the tool results.
      expect(mock.calls[1].signal).toBeDefined();
      expect(mock.calls[1].signal!.aborted).toBe(false);
    });
  }, 30_000);

  it('after an empty-response timeout the abandoned stream is aborted and its late events never reach the output', async () => {
    await withIsolatedRouter({ ...baseCfg, empty_response_timeout_ms: 300, reasoning_empty_response_timeout_ms: 300 },
      async (defaultExport) => {
        const mock = makeRegistry({
          'p1/first-model': model('p1', 'first-model'),
          'p2/second-model': model('p2', 'second-model'),
        });
        let lateEventsEmitted = false;
        // Silent until aborted (or 3s), then emits late content + a terminal
        // event — exactly what a still-running provider does after the router
        // has already moved on.
        mock.scripts['p1/first-model'] = [(signal) => (async function* () {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 3_000);
            signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
          });
          lateEventsEmitted = true;
          yield { type: 'text_delta', contentIndex: 0, delta: 'LATE GHOST TEXT', partial: {} } as any;
          yield signal?.aborted
            ? ({ type: 'error', reason: 'aborted', error: { stopReason: 'aborted' } } as any)
            : ({ type: 'done', reason: 'stop', message: { role: 'assistant', content: [], stopReason: 'stop' } } as any);
        })()];
        mock.scripts['p2/second-model'] = [(signal) => (async function* () {
          // Stay open long enough for the ghost to fire if it were not aborted.
          await new Promise((r) => setTimeout(r, 50));
          for (const ev of textEvents('second model answer')) yield ev;
          void signal;
        })()];

        const events = await runGroupStream(defaultExport, mock.registry);

        expect(mock.calls[0].signal?.aborted).toBe(true);
        expect(lateEventsEmitted).toBe(true);
        expect(joinedText(events)).toContain('second model answer');
        expect(joinedText(events)).not.toContain('LATE GHOST TEXT');
        // The ghost's aborted terminal must not end the user's stream as "aborted".
        expect(events.find((e: any) => e.type === 'error')).toBeUndefined();
      });
  }, 30_000);
});
