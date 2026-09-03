/**
 * Integration test: the router must detect a mid-stream stall — a model that
 * emits some content, then goes silent forever (connection open, no error, no
 * close, no further events) — and treat it as a soft failure so the group
 * falls over to the next candidate, instead of hanging the whole session
 * indefinitely.
 *
 * Root cause this guards against: consumeWithDetection() used to clear the
 * timeout timer on the first content token and never re-arm it. A stream that
 * opened, emitted content, then went silent (observed with free/rate-limited
 * OpenRouter proxies like cohere/north-mini-code:free) left the for-await loop
 * blocked forever — no error, no timeout, no fallback. The user had to
 * hard-kill Pi to recover.
 *
 * Fix: the stall timer is now (re)armed on every received event, so both the
 * first-token window AND a mid-stream stall trip the same timer. A stall after
 * content is reported as `stall_timeout` (distinct from `empty_timeout`).
 */
import { describe, it, expect, vi } from 'vitest';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireRouterStateLock, releaseRouterStateLock, writeNoOpScanCache, removeNoOpScanCache, flushBackgroundScan } from './helpers/router-state-lock.ts';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dynamicConfigPath = path.join(repoRoot, 'router-config.dynamic.json');
const scanCachePath = path.join(repoRoot, '.cache', 'scan-cache.json');

async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

async function withIsolatedRouter(
  configOverride: Record<string, unknown>,
  fn: (defaultExport: any, tmpDir: string) => Promise<void>
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-stall-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const dynBak = `${dynamicConfigPath}.stall-bak`;
  const cacheBak = `${scanCachePath}.stall-bak`;
  await acquireRouterStateLock();
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
    releaseRouterStateLock();
  }
}

describe('driveStream: mid-stream stall detection', () => {
  it('aborts a model that goes silent after emitting content and falls over to the next candidate', async () => {
    await withIsolatedRouter(
      {
        free_models: [],
        providers: { openrouter: { free_models: [] } },
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        // Deterministic ranking: stalling-model ranks first, healthy-model
        // second. The router must detect the stall and switch.
        gdpval_builtin: {
          'stalling-model': 1000,
          'healthy-model': 900,
        },
        // Short timeouts so the test resolves quickly. The stall is simulated
        // by a stream that emits one token then never yields again (and never
        // closes). BOTH the first-token window and the mid-stream inactivity
        // window must be short here — the re-armed inactivity timer fires within
        // the stall window after the stream goes silent.
        empty_response_timeout_ms: 300,
        reasoning_empty_response_timeout_ms: 300,
        stall_timeout_ms: 300,
      },
      async (defaultExport, tmpDir) => {
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

        const stallingModel = {
          provider: 'stalling-provider',
          id: 'stalling-model',
          api: 'stalling-api',
          contextWindow: 1_000_000,
        };
        const healthyModel = {
          provider: 'healthy-provider',
          id: 'healthy-model',
          api: 'healthy-api',
          contextWindow: 1_000_000,
        };
        const modelsByRef: Record<string, any> = {
          'stalling-provider/stalling-model': stallingModel,
          'healthy-provider/healthy-model': healthyModel,
        };
        const streamSimple = vi.fn((model: any) => {
          if (model.id === 'stalling-model') {
            // Simulate a mid-stream stall: emit one content token, then go
            // silent forever. The connection never closes, no error is
            // emitted — the generator just blocks on a promise that never
            // resolves. Without the re-armed stall timer, the for-await loop
            // would block indefinitely.
            return (async function* () {
              yield { type: 'text_delta', delta: 'starting...' };
              // Hang forever — never yields again, never returns.
              await new Promise(() => {}); // never resolves
            })();
          }
          if (model.id === 'healthy-model') {
            return (async function* () {
              yield { type: 'text_delta', delta: 'served by the healthy fallback' };
              yield { type: 'done' };
            })();
          }
          return (async function* () {})();
        });
        const modelRegistry = {
          getAvailable: () => [stallingModel, healthyModel],
          find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
          getApiKeyForProvider: async () => null,
          runtime: { streamSimple },
        };
        const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        const groupModel = { provider: 'standard', id: 'standard' };
        const context: any = { messages: [{ role: 'user', content: 'edit the file' }] };

        // Must resolve (not hang). If the stall timer isn't re-armed, this
        // await never returns and the test times out.
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
        expect(streamSimple).toHaveBeenCalled();
      }
    );
  }, 30000);
});
