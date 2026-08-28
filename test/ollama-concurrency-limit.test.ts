/**
 * Integration test: the router must limit concurrent streams to LOCAL model
 * servers (ollama, lm-studio) to prevent OOM crashes. Each local stream
 * loads a full model into RAM (qwen3.8:27b-mlx ≈ 18GB, gemma4:12b ≈ 10GB);
 * parallel subagent fan-out can request N models at once and exhaust system
 * RAM → kernel panic / OOM kill. When `ollama_max_concurrent_streams` is
 * reached, extra local candidates are soft-failed (reason:
 * local_concurrency_limit) and driveStream falls over to the next candidate
 * (typically a cloud model).
 *
 * Reproduces the 2026-08-27 crash where 6 Ollama models were streamed in
 * parallel within 75ms (~55GB RAM demand).
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-local-conc-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const dynBak = `${dynamicConfigPath}.localconc-bak`;
  const cacheBak = `${scanCachePath}.localconc-bak`;
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

describe('driveStream: local-stream concurrency limit', () => {
  it('serializes ollama streams to the configured limit and soft-fails extras to the next candidate', async () => {
    await withIsolatedRouter(
      {
        free_models: [],
        providers: { openrouter: { free_models: [] } },
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        gdpval_builtin: {
          'ollama/big-model': 1000,
          'ollama/other-big-model': 950,
          'cloud/fallback-model': 900,
        },
        // Default 1: strictly serial local streams.
        ollama_max_concurrent_streams: 1,
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

        const bigModel = { provider: 'ollama', id: 'big-model', api: 'openai-completions', contextWindow: 1_000_000 };
        const otherBigModel = { provider: 'ollama', id: 'other-big-model', api: 'openai-completions', contextWindow: 1_000_000 };
        const cloudModel = { provider: 'cloud', id: 'fallback-model', api: 'openai-completions', contextWindow: 1_000_000 };
        const modelsByRef: Record<string, any> = {
          'ollama/big-model': bigModel,
          'ollama/other-big-model': otherBigModel,
          'cloud/fallback-model': cloudModel,
        };
        // Track how many ollama streams were ever open at once. Each stream
        // increments a counter on open and decrements on close; we capture
        // the high-water mark. With limit=1 the high-water must never exceed 1.
        let openOllamaStreams = 0;
        let maxConcurrentOllama = 0;
        const streamSimple = vi.fn((model: any) => {
          if (model.provider === 'ollama') {
            return (async function* () {
              openOllamaStreams++;
              maxConcurrentOllama = Math.max(maxConcurrentOllama, openOllamaStreams);
              try {
                yield { type: 'text_delta', delta: `ollama ${model.id} ok` };
                yield { type: 'done' };
              } finally {
                openOllamaStreams--;
              }
            })();
          }
          if (model.provider === 'cloud') {
            return (async function* () {
              yield { type: 'text_delta', delta: 'cloud fallback ok' };
              yield { type: 'done' };
            })();
          }
          return (async function* () {})();
        });
        const modelRegistry = {
          getAvailable: () => [bigModel, otherBigModel, cloudModel],
          find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
          getApiKeyForProvider: async () => null,
          runtime: { streamSimple },
        };
        const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        // Launch 3 groupStream calls in parallel (simulating subagent fan-out).
        // With limit=1, only 1 ollama stream should be open at any instant;
        // the other 2 ollama candidates must soft-fail and fall over to the
        // cloud fallback (or the other ollama model once the slot frees).
        const groupModel = { provider: 'standard', id: 'standard' };
        const context: any = { messages: [{ role: 'user', content: 'do the thing' }] };
        const streams = [0, 1, 2].map(() => defaultExport.groupStream(groupModel, context, {}));
        const allEvents = await Promise.all(streams.map(drainStream));

        // Every stream must have produced content (no hard errors).
        for (const events of allEvents) {
          const errEvent = events.find((e: any) => e.type === 'error') as any;
          expect(errEvent).toBeUndefined();
          const text = events
            .filter((e: any) => e.type === 'text_delta')
            .map((e: any) => e.delta ?? '')
            .join('');
          expect(text.length).toBeGreaterThan(0);
        }

        // The core assertion: the high-water mark of concurrent ollama
        // streams must not exceed the configured limit (1). If it does, the
        // semaphore is broken and parallel subagent fan-out can OOM the host.
        expect(maxConcurrentOllama).toBeLessThanOrEqual(1);
        expect(streamSimple).toHaveBeenCalled();
      }
    );
  }, 15000);
});
