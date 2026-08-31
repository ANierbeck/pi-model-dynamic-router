/**
 * Regression test for roborev job 339 (LOW finding).
 *
 * driveStream's provider_error branch (unrecognized finish_reason from a
 * mid-stream error event, see test/provider-error-detection.test.ts) is not
 * restricted to free/local models — the code path applies to any candidate.
 * Before this fix, a PAID cloud model hitting provider_error fell through to
 * the "local model soft failure — short backoff only" branch (meant for
 * local/free models) instead of the hard-cooldown-with-key-rotation path
 * every other paid-cloud failure gets. That mismatch was silent: the
 * escalation helper (recordStreamFailure) had its own independent copy of the
 * gating predicate that hadn't been updated either, so even fixing the
 * caller's branch alone would have left the actual cooldown tier unchanged.
 *
 * This test asserts the user-facing wording for a paid (non-free, non-local)
 * cloud provider hitting provider_error matches the hard-cooldown branch
 * ("likely rate limit"), not the generic soft-failure wording used for
 * local/free models ("provider error: ..." with no rate-limit framing) —
 * the wording is a direct, observable proxy for which escalation branch ran.
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-paid-provider-err-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const dynBak = `${dynamicConfigPath}.paid-provider-err-bak`;
  const cacheBak = `${scanCachePath}.paid-provider-err-bak`;
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

describe('driveStream: provider_error on a paid cloud model', () => {
  it('gets the hard-cooldown ("likely rate limit") treatment, not the local/free soft-backoff wording', async () => {
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

        // No ":free" suffix and not ollama/lm-studio — a paid cloud model.
        const paidModel = {
          provider: 'paid-cloud-provider',
          id: 'paid-model',
          api: 'openai-completions',
          contextWindow: 1_000_000,
        };
        const modelsByRef: Record<string, any> = {
          'paid-cloud-provider/paid-model': paidModel,
        };
        const streamSimple = vi.fn(() => {
          return (async function* () {
            yield {
              type: 'error',
              error: { errorMessage: 'Provider finish_reason: error' },
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

        const routerInfoText = events
          .filter((e: any) => e.type === 'text_delta')
          .map((e: any) => e.delta ?? '')
          .join('');

        expect(streamSimple).toHaveBeenCalled();
        // Hard-cooldown wording, proving the paid-cloud branch (not the
        // local/free soft-backoff branch) handled this failure.
        expect(routerInfoText).toContain('likely rate limit');
        // The local/free branch's plain wording must NOT appear instead.
        expect(routerInfoText).not.toContain('provider error: Provider finish_reason: error\n');
      }
    );
  }, 15000);
});
