/**
 * Integration test: statically-configured free models (cfg.providers[provider]
 * .free_models) must be registered into Pi's model registry on demand when
 * tryStream encounters them, not silently skipped as "not registered".
 *
 * Reproduces the observed "claude-sonnet-5 dominates, GLM/free models unused"
 * symptom: free models listed in router-config.json never go through the
 * scan/cache.available_models path, so registerGroupModels never sees them,
 * and tryStream skipped every free model forever — the cascade fell through
 * to the next non-free model (claude-sonnet-5) on every turn.
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-free-reg-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const dynBak = `${dynamicConfigPath}.freereg-bak`;
  const cacheBak = `${scanCachePath}.freereg-bak`;
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

describe('driveStream: on-demand free-model registration', () => {
  it('registers a configured free model into Pi registry when tryStream needs it, so it actually streams', async () => {
    await withIsolatedRouter(
      {
        free_models: [],
        providers: {
          // A provider with a free model statically configured. The model is
          // NOT in cache.available_models (simulating the real situation:
          // statically-configured free models never go through the scan path).
          openrouter: {
            free_models: ['openrouter/z-ai/glm-5.2:free'],
            keys: [{ key: 'sk-or-test-fake-key' }],
          },
        },
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        gdpval_builtin: { 'openrouter/z-ai/glm-5.2:free': 900 },
      },
      async (defaultExport, tmpDir) => {
        const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
        const registerProviderCalls: any[] = [];
        const pi: any = {
          registerTool: vi.fn(),
          registerCommand: vi.fn(),
          registerProvider: vi.fn((name: string, opts: any) => {
            registerProviderCalls.push({ name, opts });
            // Mirror how Pi's real registry makes the model findable after
            // registration: once openrouter is registered with the free
            // model id, find() should return it.
            if (name === 'openrouter' && Array.isArray(opts?.models)) {
              openrouterRegistered = true;
            }
          }),
          setModel: vi.fn(async () => true),
          on: vi.fn((event: string, handler: any) => {
            onHandlers[event] = handler;
          }),
        };
        defaultExport(pi);

        const freeModel = { provider: 'openrouter', id: 'z-ai/glm-5.2:free', api: 'openai-completions', contextWindow: 128_000 };
        // The model registry starts with the free model NOT findable (it's
        // not registered yet). After tryStream's on-demand registration
        // calls pi.registerProvider, the registry must find it — simulate
        // that by making find() return the model once registerProvider has
        // been called for openrouter with that model id in the models list.
        const modelsByRef: Record<string, any> = {
          'openrouter/z-ai/glm-5.2:free': freeModel,
        };
        let openrouterRegistered = false;
        const modelRegistry = {
          getAvailable: () => [freeModel],
          find: (provider: string, modelId: string) => {
            if (provider === 'openrouter' && openrouterRegistered) {
              return modelsByRef[`${provider}/${modelId}`] ?? null;
            }
            return null;
          },
          getApiKeyForProvider: async () => 'sk-or-test-fake-key',
          runtime: { streamSimple: vi.fn(() => (async function* () {
            yield { type: 'text_delta', delta: 'glm free model ok' };
            yield { type: 'done' };
          })()) },
        };
        // Hook: pi.registerProvider now flips openrouterRegistered in the
        // mock defined above (combined with the push), so subsequent find()
        // calls succeed — mirrors how Pi's real registry makes the model
        // findable after registration.
        const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        const groupModel = { provider: 'standard', id: 'standard' };
        const context: any = { messages: [{ role: 'user', content: 'hi' }] };
        const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

        // No hard error — the cascade reached the free model.
        const errEvent = events.find((e: any) => e.type === 'error') as any;
        expect(errEvent).toBeUndefined();

        // The free model's content came through (not skipped as "not registered").
        const text = events
          .filter((e: any) => e.type === 'text_delta')
          .map((e: any) => e.delta ?? '')
          .join('');
        expect(text).toContain('glm free model ok');

        // And openrouter was registered on demand.
        const openrouterReg = registerProviderCalls.find((c) => c.name === 'openrouter');
        expect(openrouterReg).toBeDefined();
      }
    );
  }, 15000);
});
