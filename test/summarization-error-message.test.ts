/**
 * Regression test for the "Summarization failed: Unknown error" bug.
 *
 * pi-coding-agent's compaction/branch-summary path calls
 * `getSummarizationFailure(response, label)`, which reads *only*
 * `response.errorMessage` (never `content[0].text`):
 *
 *   return `${label} failed: ${response.errorMessage || "Unknown error"}`;
 *
 * Before this fix, driveStream's "all candidates failed" / "dynamic routing
 * failed" / catch-all error paths called `pushStreamError(proxy, detailText)`
 * without a third `errorMessage` argument, so `buildErrorAssistantMessage`
 * omitted the field entirely and the user always saw "Unknown error" even
 * though the router had a detailed, multi-line failure reason.
 *
 * The fix must NOT simply echo the raw failureList into errorMessage: pi-ai's
 * `isRetryableAssistantError` (used by `retryAssistantCall`, the wrapper
 * compaction/branch-summary calls use) treats any errorMessage matching its
 * RETRYABLE_PROVIDER_ERROR_PATTERN (timeout, rate.?limit, network.?error,
 * 5xx, ...) as transient and re-invokes the *entire* candidate cascade up to
 * maxRetries times. Since real failureList text routinely contains those
 * exact words (rate_limit_exceeded, empty_timeout, stall_timeout), echoing it
 * verbatim would turn an already multi-minute fallback cascade into a
 * multi-attempt retry storm — the likely cause of "pi hangs in working mode,
 * user has to Ctrl-C" reports during compaction.
 *
 * This test asserts both properties: errorMessage is non-empty (fixes
 * "Unknown error"), and it is classified as non-retryable by pi-ai's own
 * classifier (guards against the retry-storm regression).
 */
import { describe, it, expect, vi } from 'vitest';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import { isRetryableAssistantError } from '@earendil-works/pi-ai';
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-summ-err-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const dynBak = `${dynamicConfigPath}.summ-err-bak`;
  const cacheBak = `${scanCachePath}.summ-err-bak`;
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

describe('driveStream: all-candidates-failed errorMessage', () => {
  it('populates a non-empty, non-retryable errorMessage instead of leaving it undefined', async () => {
    await withIsolatedRouter(
      {
        free_models: [],
        providers: { openrouter: { free_models: [] } },
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        gdpval_builtin: { 'broken-model': 1000 },
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

        const brokenModel = {
          provider: 'broken-provider',
          id: 'broken-model',
          api: 'openai-completions',
          contextWindow: 1_000_000,
        };
        const modelsByRef: Record<string, any> = {
          'broken-provider/broken-model': brokenModel,
        };
        // Fails immediately with a raw provider error whose text contains
        // classic RETRYABLE_PROVIDER_ERROR_PATTERN trigger words
        // (rate_limit_exceeded contains "rate limit", the reason itself is
        // literally a timeout) — this is exactly the kind of text that must
        // NOT leak verbatim into the final errorMessage.
        const streamSimple = vi.fn(() => {
          return (async function* () {
            yield {
              type: 'error',
              error: { errorMessage: 'Provider finish_reason: error (rate_limit_exceeded, timeout)' },
            };
          })();
        });
        const modelRegistry = {
          getAvailable: () => [brokenModel],
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

        const errEvent = events.find((e: any) => e.type === 'error') as any;
        expect(errEvent).toBeDefined();
        const message = errEvent.error;

        // Fixes "Summarization failed: Unknown error" — getSummarizationFailure()
        // reads exactly this field.
        expect(message.errorMessage).toBeTruthy();
        expect(message.errorMessage).not.toBe('Unknown error');

        // Guards against the retry-storm regression: pi-ai's own classifier must
        // NOT consider this errorMessage transient, or compaction/branch-summary
        // callers would re-run the whole (already-exhausted) candidate cascade
        // up to maxRetries times instead of failing fast.
        expect(isRetryableAssistantError(message)).toBe(false);

        // The full diagnostic detail (including the trigger words) must still be
        // visible somewhere for debugging — in the chat-visible text, not thrown away.
        expect(message.content[0].text).toContain('rate_limit_exceeded');
      }
    );
  }, 15000);
});
