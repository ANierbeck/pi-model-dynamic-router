// test/blocklist-drivestream.test.ts
// End-to-end check for ADR-0008 Tier 1: a provider_error with a known-permanent
// OpenRouter signature blocks the model for the following requests.
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

async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

async function withIsolatedRouter(
  configOverride: Record<string, unknown>,
  fn: (defaultExport: any, tmpDir: string) => Promise<void>
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-blocklist-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const dynBak = `${dynamicConfigPath}.blocklist-bak`;
  const cacheBak = `${scanCachePath}.blocklist-bak`;
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

describe('driveStream: learned blocklist (ADR-0008, Tier 1)', () => {
  it('blocks a model after a permanent 403, skips it on the next request and persists the block', async () => {
    await withIsolatedRouter(
      {
        free_models: [],
        providers: { openrouter: { free_models: [] } },
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        gdpval_builtin: { 'gated-model': 1000, 'healthy-model': 900 },
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

        // Not on the bundled static exclude list, so only the learned block can remove it.
        const gated = {
          provider: 'openrouter',
          id: 'test-vendor/gated-model:free',
          api: 'openai-completions',
          contextWindow: 1_000_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
        const healthy = {
          provider: 'healthy-provider',
          id: 'healthy-model',
          api: 'openai-completions',
          contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        };
        const byRef: Record<string, any> = {
          'openrouter/test-vendor/gated-model:free': gated,
          'healthy-provider/healthy-model': healthy,
        };
        const streamSimple = vi.fn((model: any) => {
          if (model.id === gated.id) {
            return (async function* () {
              yield {
                type: 'error',
                error: {
                  errorMessage:
                    '403: {"message":"test-vendor/gated-model:free is only available on agentic harnesses. Try plugging it into a coding agent or productivity app listed on https://openrouter.ai/apps","code":403}',
                },
              };
            })();
          }
          return (async function* () {
            yield { type: 'text_delta', delta: 'served by the healthy fallback' };
            yield { type: 'done' };
          })();
        });
        const modelRegistry = {
          getAvailable: () => [gated, healthy],
          find: (provider: string, modelId: string) => byRef[`${provider}/${modelId}`] ?? null,
          getApiKeyForProvider: async (provider: string) => (provider === 'openrouter' ? 'sk-or-test' : null),
          runtime: { streamSimple },
        };
        const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        const groupModel = { provider: 'standard', id: 'standard' };
        const context: any = { messages: [{ role: 'user', content: 'do the thing' }] };

        const first = await drainStream(defaultExport.groupStream(groupModel, context, {}));
        expect(first.filter((e: any) => e.type === 'text_delta').map((e: any) => e.delta).join('')).toContain(
          'served by the healthy fallback'
        );
        expect(streamSimple.mock.calls.map((c: any[]) => c[0].id)).toContain(gated.id);

        const persisted = JSON.parse(fs.readFileSync(scanCachePath, 'utf-8'));
        expect(persisted.model_blocklist?.['openrouter/test-vendor/gated-model:free']).toMatchObject({
          reason: 'agentic-harness-gate',
          code: 403,
          occurrences: 1,
        });

        streamSimple.mockClear();
        await drainStream(defaultExport.groupStream(groupModel, context, {}));
        const secondCalls = streamSimple.mock.calls.map((c: any[]) => c[0].id);
        expect(secondCalls).not.toContain(gated.id);
        expect(secondCalls).toContain('healthy-model');
      }
    );
  }, 30000);
});
