// Regression test for the host 1.4.0 alignment (2026-10-26).
//
// pi-ai 1.4.0 times terminal stream events in AssistantMessageEventStream
// .push(): `done` must carry `message`, `error` must carry `error`. A
// terminal event without them throws inside proxy.push() while the router
// forwards it.
//
// The router's consume loop caught that exception and returned 'done' —
// the SAME value as a successful candidate — so driveStream recorded the
// candidate as a success, the proxy stream never received a terminal event,
// and the consumer (Pi's runtime) awaited a stream that would never end:
// a permanent hang of the whole turn.
//
// This test drives the full groupStream path with a candidate whose
// terminal `done` event is malformed (no `message`). The router must treat
// that as a soft failure of the candidate, fall over to the next candidate,
// and the stream must TERMINATE. Without the fix this test times out
// (observed red: hang, 0 terminal events).

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

async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

// First candidate streams content, then terminates with a MALFORMED done
// event (no `message`) — the exact shape that makes pi-ai 1.4.0's push()
// throw. The second candidate is healthy and must serve the turn.
const brokenModel = {
  provider: 'cloud-a',
  id: 'malformed-done',
  api: 'openai-completions',
  contextWindow: 1_000_000, cost: { input: 0.05, output: 0.1, cacheRead: 0, cacheWrite: 0 },
};
const healthyModel = {
  provider: 'cloud-b',
  id: 'healthy-model',
  api: 'openai-completions',
  contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
};

const context: any = { messages: [{ role: 'user', content: 'do the thing' }] };

describe('driveStream: forwarding exception must not hang the stream', () => {
  it('a candidate whose terminal done event fails to forward is a soft failure — the next candidate serves and the stream terminates', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-fwd-throw-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify({
      free_models: [],
      providers: { openrouter: { free_models: [] } },
      model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
      // Same gdpval for both: cost order puts the broken candidate first.
      gdpval_builtin: { 'malformed-done': 900, 'healthy-model': 900 },
    }));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    const dynBak = `${dynamicConfigPath}.fwd-throw-bak`;
    const hadDyn = fs.existsSync(dynamicConfigPath);
    if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
    writeNoOpScanCache(scanCachePath);

    try {
      vi.resetModules();
      const mod = await import('../index.ts');

      const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
      const pi: any = {
        registerTool: vi.fn(),
        registerCommand: vi.fn(),
        registerProvider: vi.fn(),
        setModel: vi.fn(async () => true),
        on: vi.fn((event: string, handler: any) => {
          onHandlers[event] = handler;
        }),
      };
      mod.default(pi);

      const streamSimple = vi.fn((model: any) => {
        if (model.id === brokenModel.id) {
          return (async function* () {
            yield { type: 'text_delta', delta: 'partial answer from the broken candidate' };
            // Malformed terminal event — pi-ai 1.4.0 push() throws on it.
            yield { type: 'done' };
          })();
        }
        return (async function* () {
          yield { type: 'text_delta', delta: 'served by the healthy candidate' };
          yield {
            type: 'done',
            reason: 'stop',
            message: { role: 'assistant', content: [], stopReason: 'stop', timestamp: Date.now() },
          };
        })();
      });
      const modelRegistry = {
        getAvailable: () => [brokenModel, healthyModel],
        find: (provider: string, modelId: string) =>
          (provider === brokenModel.provider && modelId === brokenModel.id) ||
          (provider === healthyModel.provider && modelId === healthyModel.id)
            ? { ...brokenModel, provider, id: modelId }
            : null,
        getApiKeyForProvider: async (provider: string) => 'sk-test',
        runtime: { streamSimple },
      };
      const ctx: any = { modelRegistry, cwd: os.tmpdir(), ui: { setFooter: vi.fn() } };
      await onHandlers['session_start']?.({}, ctx);
      await flushBackgroundScan();

      const groupModel = { provider: 'standard', id: 'standard' };
      const stream = mod.default.groupStream(groupModel, context, {});

      // Guard against the exact regression this test pins: without the fix,
      // draining never completes. Race the drain against a hard deadline so
      // the failure is a clear assertion message, not a 30s suite timeout.
      const drained = await Promise.race([
        drainStream(stream).then((events) => ({ ok: true as const, events })),
        new Promise<{ ok: false; events: AssistantMessageEvent[] }>((resolve) =>
          setTimeout(() => resolve({ ok: false, events: [] }), 10_000)
        ),
      ]);
      expect(drained.ok).toBe(true);

      const text = drained.events
        .filter((e: any) => e.type === 'text_delta')
        .map((e: any) => e.delta)
        .join('');
      // The healthy candidate served the turn…
      expect(text).toContain('served by the healthy candidate');
      // …after the broken candidate soft-failed on the forwarding exception.
      const tried = streamSimple.mock.calls.map((c: any[]) => c[0].id);
      expect(tried).toContain('malformed-done');
      expect(tried).toContain('healthy-model');
      // The stream really terminated with a terminal event.
      const terminal = drained.events.filter(
        (e: any) => e.type === 'done' || e.type === 'error'
      );
      expect(terminal.length).toBeGreaterThan(0);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      removeNoOpScanCache(scanCachePath);
      if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
    }
  }, 20000);
});
