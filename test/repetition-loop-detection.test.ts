/**
 * Integration test: the router must detect when a model gets stuck
 * regenerating the same phrase over and over (observed with devstral
 * variants) and treat it as a soft failure, so the group falls over to
 * the next candidate instead of letting the loop burn the whole context
 * window and then retrying the same unhealthy model on the next turn.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireRouterStateLock, releaseRouterStateLock } from './helpers/router-state-lock.ts';

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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-repetition-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const dynBak = `${dynamicConfigPath}.repetition-bak`;
  const cacheBak = `${scanCachePath}.repetition-bak`;
  await acquireRouterStateLock();
  const hadDyn = fs.existsSync(dynamicConfigPath);
  const hadCache = fs.existsSync(scanCachePath);
  if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
  if (hadCache) fs.renameSync(scanCachePath, cacheBak);

  try {
    vi.resetModules();
    const mod = await import('../index.ts');
    await fn(mod.default as any, tmpDir);
  } finally {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
    if (hadCache) fs.renameSync(cacheBak, scanCachePath);
    releaseRouterStateLock();
  }
}

describe('driveStream: repetition loop detection', () => {
  it('aborts a looping model and falls over to the next candidate', async () => {
    await withIsolatedRouter(
      {
        free_models: [],
        providers: { openrouter: { free_models: [] } },
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        // Force a deterministic ranking: loopy-model has higher GDPval so
        // it ranks first, healthy-model second. The router must detect the
        // loop and switch to healthy-model instead of letting loopy-model
        // burn the whole context window.
        gdpval_builtin: {
          'loopy-model': 1000,
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

        // Two models: loopy-model repeats the same phrase, healthy-model
        // returns a unique response. The router must detect the loop and
        // switch to healthy-model.
        const loopyModel = {
          provider: 'loopy-provider',
          id: 'loopy-model',
          api: 'loopy-api',
          contextWindow: 1_000_000,
        };
        const healthyModel = {
          provider: 'healthy-provider',
          id: 'healthy-model',
          api: 'healthy-api',
          contextWindow: 1_000_000,
        };
        const modelsByRef: Record<string, any> = {
          'loopy-provider/loopy-model': loopyModel,
          'healthy-provider/healthy-model': healthyModel,
        };
        const streamSimple = vi.fn((model: any) => {
          if (model.id === 'loopy-model') {
            // Simulate a degenerate repetition loop: the same sentence
            // repeated many times. The detector should catch this and
            // abort the stream before it burns the whole context window.
            const sentence = 'Ich möchte jetzt die Datei bearbeiten und speichern. ';
            return (async function* () {
              for (let i = 0; i < 10; i++) {
                yield { type: 'text_delta', delta: sentence };
              }
              yield { type: 'done' };
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
          getAvailable: () => [loopyModel, healthyModel],
          find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
          getApiKeyForProvider: async () => null,
          runtime: { streamSimple },
        };
        const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);

        const groupModel = { provider: 'standard', id: 'standard' };
        const context: any = { messages: [{ role: 'user', content: 'edit the file' }] };

        const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

        // Must NOT have emitted an error — the cascade found a healthy model.
        const errEvent = events.find((e: any) => e.type === 'error') as any;
        expect(errEvent).toBeUndefined();

        const text = events
          .filter((e: any) => e.type === 'text_delta')
          .map((e: any) => e.delta ?? '')
          .join('');
        expect(text).toContain('served by the healthy fallback');
        expect(streamSimple).toHaveBeenCalled();
      }
    );
  });
});
