/**
 * Regression test for roborev job 345 (HIGH finding).
 *
 * pi-ai's AssistantMessageEvent contract has a stream terminate with
 * `{type:'error', reason:'aborted'|'error', error}` for BOTH a genuine
 * provider fault AND a user/agent-initiated cancellation (e.g. Ctrl-C
 * mid-generation) — the underlying provider's stream() implementation sets
 * `stopReason: signal?.aborted ? "aborted" : "error"` itself.
 *
 * Before this fix, consumeWithDetection's error-event handling only checked
 * the error text for rate-limit/overflow patterns and otherwise fell through
 * to `providerErrorDetected = true` — including for a plain user abort. On a
 * paid cloud model that got escalated to a HARD cooldown + key rotation with
 * a "likely rate limit" message, even though nothing was wrong with the
 * provider; the user simply cancelled.
 *
 * Fix: an error event with `reason === 'aborted'` is forwarded to the caller
 * as-is (preserving the real `stopReason: 'aborted'` message pi-ai's own
 * abort handling expects) and short-circuits driveStream with no cooldown
 * recorded against the model and no further candidates tried.
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-abort-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const dynBak = `${dynamicConfigPath}.abort-bak`;
  const cacheBak = `${scanCachePath}.abort-bak`;
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

describe('driveStream: user-abort error events', () => {
  it('forwards the real aborted event and does not escalate a paid cloud model to a rate-limit cooldown', async () => {
    await withIsolatedRouter(
      {
        free_models: [],
        providers: { openrouter: { free_models: [] } },
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        gdpval_builtin: { 'paid-model': 1000 },
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

        const paidModel = {
          provider: 'paid-cloud-provider',
          id: 'paid-model',
          api: 'openai-completions',
          contextWindow: 1_000_000,
        };
        const modelsByRef: Record<string, any> = {
          'paid-cloud-provider/paid-model': paidModel,
        };
        // Exact shape a real provider produces on a user/agent-initiated
        // cancellation (e.g. Ctrl-C): stopReason 'aborted', not 'error'.
        const streamSimple = vi.fn(() => {
          return (async function* () {
            yield {
              type: 'error',
              reason: 'aborted',
              error: {
                role: 'assistant',
                content: [],
                stopReason: 'aborted',
                errorMessage: undefined,
              },
            };
          })();
        });
        const modelRegistry = {
          getAvailable: () => [paidModel],
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

        // The real aborted event must reach the caller, not a synthesized
        // "provider_error"/"rate limit" message.
        const errEvent = events.find((e: any) => e.type === 'error') as any;
        expect(errEvent).toBeDefined();
        expect(errEvent.reason).toBe('aborted');
        expect(errEvent.error.stopReason).toBe('aborted');

        // Must NOT contain any rate-limit/provider-error framing — that would
        // mean the abort got misclassified and escalated.
        const allEventText = JSON.stringify(events);
        expect(allEventText).not.toContain('likely rate limit');
        expect(allEventText).not.toContain('provider_error');

        // Only one candidate exists; the router must not have tried it again
        // (which would happen if the abort were treated as a soft/hard
        // failure worth a fallback retry).
        expect(streamSimple).toHaveBeenCalledTimes(1);
      }
    );
  }, 15000);
});
