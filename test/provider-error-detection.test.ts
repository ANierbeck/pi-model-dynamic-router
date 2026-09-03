/**
 * Integration test: when a provider ends its stream with an unrecognized
 * finish_reason (which pi-ai turns into a generic error event like
 * `{type:'error', error:{errorMessage:'Provider finish_reason: error'}}`),
 * consumeWithDetection must treat that as a soft failure — not silently
 * report success just because content streamed first.
 *
 * Root cause this guards against: before the fix, consumeWithDetection only
 * recognized rate-limit and overflow text patterns. A free OpenRouter model
 * (observed in practice: minimax/minimax-m3:free, cohere/north-mini-code:free,
 * thinkingmachines/inkling:free) that streams partial content and then errors
 * with "Provider finish_reason: <unknown>" fell through every detection branch
 * to the final `return { ok: true }` — the router recorded a successful turn,
 * no cooldown got registered, and the same broken model got picked again next
 * turn. The visible symptom was pi becoming unresponsive while the router
 * silently churned on the same broken model.
 *
 * Fix: any error event that isn't a recognized rate-limit or overflow now
 * sets a generic providerErrorDetected flag. consumeWithDetection returns
 * `{ ok: false, reason: 'provider_error', detail: <errorMessage> }`, and
 * driveStream records a soft failure so the next candidate gets tried.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireRouterStateLock,
  releaseRouterStateLock,
  writeNoOpScanCache,
  removeNoOpScanCache,
  flushBackgroundScan,
} from './helpers/router-state-lock.ts';

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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-provider-err-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const dynBak = `${dynamicConfigPath}.provider-err-bak`;
  const cacheBak = `${scanCachePath}.provider-err-bak`;
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

describe('driveStream: mid-stream provider error (unrecognized finish_reason)', () => {
  it('a model that streams content then errors with an unrecognized finish_reason fails over to the next candidate', async () => {
    await withIsolatedRouter(
      {
        free_models: [],
        providers: { openrouter: { free_models: [] } },
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        // Broken model ranks first so the router picks it; healthy fallback
        // ranks second and must take over after the soft failure.
        gdpval_builtin: {
          'err-finish-model': 1000,
          'healthy-model': 900,
        },
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

        const errModel = {
          provider: 'err-provider',
          id: 'err-finish-model',
          api: 'openai-completions',
          contextWindow: 1_000_000,
        };
        const healthyModel = {
          provider: 'healthy-provider',
          id: 'healthy-model',
          api: 'openai-completions',
          contextWindow: 1_000_000,
        };
        const modelsByRef: Record<string, any> = {
          'err-provider/err-finish-model': errModel,
          'healthy-provider/healthy-model': healthyModel,
        };
        const streamSimple = vi.fn((model: any) => {
          if (model.id === 'err-finish-model') {
            // Stream partial content, then end with an unrecognized
            // finish_reason that pi-ai maps to an error event. This is the
            // exact shape observed in the wild with free OpenRouter models
            // (minimax-m3, north-mini-code, inkling) — the model streams a
            // few tokens, then the provider's finish_reason="error" (or any
            // value pi-ai doesn't recognize) is converted into:
            //   { type: 'error', error: { errorMessage: 'Provider finish_reason: <reason>' } }
            // Without the fix, the router would treat this as a successful
            // turn because hadContent was already true.
            return (async function* () {
              yield { type: 'text_delta', delta: 'partial answer ' };
              yield {
                type: 'error',
                error: { errorMessage: 'Provider finish_reason: error' },
              };
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
          getAvailable: () => [errModel, healthyModel],
          find: (provider: string, modelId: string) =>
            modelsByRef[`${provider}/${modelId}`] ?? null,
          getApiKeyForProvider: async () => null,
          runtime: { streamSimple },
        };
        const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        const groupModel = { provider: 'standard', id: 'standard' };
        const context: any = { messages: [{ role: 'user', content: 'do the thing' }] };

        const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

        // The healthy fallback's content must have made it through — proves
        // the broken model was detected and the cascade fell over instead of
        // returning "ok: true" on the partial stream.
        const text = events
          .filter((e: any) => e.type === 'text_delta')
          .map((e: any) => e.delta ?? '')
          .join('');
        expect(text).toContain('served by the healthy fallback');

        // The error event from the broken model must NOT have been forwarded
        // to the user — consumeWithDetection explicitly drops error events so
        // the cascade can try the next candidate without surfacing the raw
        // provider text.
        const errEvent = events.find((e: any) => e.type === 'error') as any;
        expect(errEvent).toBeUndefined();

        // The broken model must have actually been called (sanity check —
        // otherwise the test would pass trivially with the healthy model
        // ranked first).
        const calledIds = streamSimple.mock.calls.map((c: any[]) => c[0].id);
        expect(calledIds).toContain('err-finish-model');
      }
    );
  }, 30000);
});
