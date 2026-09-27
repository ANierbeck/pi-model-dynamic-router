/**
 * Integration test: the router must detect a stream that ends with
 * stopReason 'length' (max output tokens hit — the answer is truncated and
 * the task is incomplete) and treat it as a soft failure so the group falls
 * over to the next candidate, instead of reporting success.
 *
 * Root cause this guards against: consumeWithDetection() used to classify
 * EVERY cleanly-ending stream with content as { ok: true } — the `done`
 * event's `reason` field ('stop' | 'length' | 'toolUse') was never inspected.
 * A model that hits max_tokens mid-task (observed with
 * mistral/mistral-small-latest, 2026-09-27: "it just stops, says nothing
 * more, never finishes the task") therefore recorded a SUCCESS: no cooldown,
 * no soft-failure accumulation, no fallback to the next candidate — and the
 * same broken model was picked again on the next turn.
 *
 * Fix: the done event is now intercepted; reason 'length' is classified as a
 * new soft failure `truncated_length` (narration + recordSoftFailure + next
 * candidate), and every terminal stopReason is logged to router.log so the
 * "lazy 'stop'" variant of the failure remains diagnosable.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  fn: (defaultExport: any, tmpDir: string) => Promise<void>
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-trunc-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const dynBak = `${dynamicConfigPath}.trunc-bak`;
  const cacheBak = `${scanCachePath}.trunc-bak`;
  const hadDyn = fs.existsSync(dynamicConfigPath);
  const hadCache = fs.existsSync(scanCachePath);
  if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
  if (hadCache) fs.renameSync(scanCachePath, cacheBak);

  writeNoOpScanCache(scanCachePath);

  try {
    vi.resetModules();
    const mod = await import('../index.ts');
    await fn(mod.default as any, tmpDir);
  } finally {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
    removeNoOpScanCache(scanCachePath);
    if (hadCache) fs.renameSync(cacheBak, scanCachePath);
  }
}

describe('driveStream: stopReason length interception', () => {
  it('treats a stream ending with done.reason "length" as truncated_length and falls over to the next candidate', async () => {
    await withIsolatedRouter(
      {
        free_models: [],
        providers: { openrouter: { free_models: [] } },
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        // Deterministic ranking: truncating-model ranks first, healthy-model
        // second — same convention as the stall test (higher gdpval first).
        gdpval_builtin: {
          'truncating-model': 1000,
          'healthy-model': 900,
        },
        // Short first-token window so the test resolves quickly. The stall
        // window is irrelevant here: the truncated stream ends CLEANLY (no
        // stall), so only the empty-response window bounds a hang if the
        // interception were broken and the stream never yielded content.
        empty_response_timeout_ms: 300,
        reasoning_empty_response_timeout_ms: 300,
        stall_timeout_ms: 5000,
      },
      async (defaultExport) => {
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
        defaultExport(pi);

        const truncatingModel = {
          provider: 'truncating-provider',
          id: 'truncating-model',
          api: 'truncating-api',
          contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        };
        const healthyModel = {
          provider: 'healthy-provider',
          id: 'healthy-model',
          api: 'healthy-api',
          contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        };
        const modelsByRef: Record<string, any> = {
          'truncating-provider/truncating-model': truncatingModel,
          'healthy-provider/healthy-model': healthyModel,
        };
        const streamSimple = vi.fn((model: any) => {
          if (model.id === 'truncating-model') {
            // Simulate max_tokens truncation: content streams, then the
            // stream ends cleanly with done.reason === 'length'. No error,
            // no stall — the pre-fix watcher classified this as success.
            return (async function* () {
              yield { type: 'text_delta', delta: 'Half a sentence, cut off mid-' };
              yield { type: 'done', reason: 'length' };
            })();
          }
          if (model.id === 'healthy-model') {
            return (async function* () {
              yield { type: 'text_delta', delta: 'served by the healthy fallback' };
              yield { type: 'done', reason: 'stop' };
            })();
          }
          return (async function* () {})();
        });
        const modelRegistry = {
          getAvailable: () => [truncatingModel, healthyModel],
          find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
          getApiKeyForProvider: async () => null,
          runtime: { streamSimple },
        };
        const ctx: any = { modelRegistry, cwd: os.tmpdir(), ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        const groupModel = { provider: 'standard', id: 'standard' };
        const context: any = { messages: [{ role: 'user', content: 'edit the file' }] };

        const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

        // Must NOT have emitted a hard error — the cascade found a healthy model.
        const errEvent = events.find((e: any) => e.type === 'error') as any;
        expect(errEvent).toBeUndefined();

        // The healthy fallback's content must have made it through.
        const text = events
          .filter((e: any) => e.type === 'text_delta')
          .map((e: any) => e.delta ?? '')
          .join('');
        expect(text).toContain('served by the healthy fallback');

        // The router must have narrated the truncation (not silently succeeded).
        expect(text).toContain('output truncated at max tokens');

        // Both candidates were actually streamed: the truncating one first,
        // then the healthy one — proving the fallback path fired.
        expect(streamSimple).toHaveBeenCalledTimes(2);
      }
    );
  }, 30000);

  it('does NOT flag a stream ending with done.reason "stop" — normal completion stays a success', async () => {
    await withIsolatedRouter(
      {
        free_models: [],
        providers: { openrouter: { free_models: [] } },
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        gdpval_builtin: {
          'normal-model': 1000,
          'unused-model': 900,
        },
        empty_response_timeout_ms: 300,
        reasoning_empty_response_timeout_ms: 300,
        stall_timeout_ms: 5000,
      },
      async (defaultExport) => {
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
        defaultExport(pi);

        const normalModel = {
          provider: 'normal-provider',
          id: 'normal-model',
          api: 'normal-api',
          contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        };
        const modelsByRef: Record<string, any> = {
          'normal-provider/normal-model': normalModel,
        };
        const streamSimple = vi.fn((model: any) => {
          if (model.id === 'normal-model') {
            return (async function* () {
              yield { type: 'text_delta', delta: 'complete answer' };
              yield { type: 'done', reason: 'stop' };
            })();
          }
          return (async function* () {})();
        });
        const modelRegistry = {
          getAvailable: () => [normalModel],
          find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
          getApiKeyForProvider: async () => null,
          runtime: { streamSimple },
        };
        const ctx: any = { modelRegistry, cwd: os.tmpdir(), ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        const groupModel = { provider: 'standard', id: 'standard' };
        const context: any = { messages: [{ role: 'user', content: 'say something' }] };

        const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

        const errEvent = events.find((e: any) => e.type === 'error') as any;
        expect(errEvent).toBeUndefined();

        const text = events
          .filter((e: any) => e.type === 'text_delta')
          .map((e: any) => e.delta ?? '')
          .join('');
        expect(text).toContain('complete answer');

        // Exactly ONE stream: a normal 'stop' completion must not trigger
        // any fallback (no second candidate, no truncation narration).
        expect(streamSimple).toHaveBeenCalledTimes(1);
        expect(text).not.toContain('output truncated');
      }
    );
  }, 30000);
});
