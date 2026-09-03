/**
 * Regression test: the "(resets HH:MM:SS)" suffix on a rate-limit router-info
 * message previously only appeared when parseResetAtMs successfully parsed a
 * reset time out of THIS specific failure's raw text. Many real rate-limit
 * messages (e.g. "Warning: [rate-limit] Claude five_hour rate limit hit" with
 * no date/time appended) carry no parseable reset time at all — the user was
 * left with a generic "rate limit/spend limit reached" message and no
 * indication of when the model would be available again, even though the
 * router itself set a concrete cooldown via the escalating backoff. Now
 * formatResetMsg falls back to the router's own computed cooldown_until so a
 * wall-clock time is always shown (unless the ref was key-rotated, in which
 * case no cooldown was applied to it at all).
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-reset-msg-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const dynBak = `${dynamicConfigPath}.reset-msg-bak`;
  const cacheBak = `${scanCachePath}.reset-msg-bak`;
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

describe('driveStream: rate-limit reset-time messaging fallback', () => {
  it('shows a computed "(resets ...)" wall-clock time even when the failure text has no parseable reset time', async () => {
    await withIsolatedRouter(
      {
        free_models: [],
        providers: { openrouter: { free_models: [] } },
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        gdpval_builtin: { 'rate-limited-model': 1000 },
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

        const model = {
          provider: 'some-provider',
          id: 'rate-limited-model',
          api: 'openai-completions',
          contextWindow: 1_000_000,
        };
        const modelsByRef: Record<string, any> = {
          'some-provider/rate-limited-model': model,
        };
        const streamSimple = vi.fn(() => {
          return (async function* () {
            // No date/time appended — matches neither parseResetAtMs format.
            yield {
              type: 'error',
              error: { errorMessage: 'Warning: [rate-limit] Claude five_hour rate limit hit' },
            };
          })();
        });
        const modelRegistry = {
          getAvailable: () => [model],
          find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
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

        expect(routerInfoText).toContain('rate limit/spend limit reached');
        // The fallback: even with no parseable reset time in the raw text,
        // the router's own computed cooldown must still be surfaced.
        expect(routerInfoText).toMatch(/\(resets .+\)/);
      }
    );
  }, 30000);

  // roborev job 388 LOW: formatResetMsg is called from 3 separate sites with
  // independently-wired ref/rotated arguments; the rate_limit_exceeded branch
  // above only exercises one of them. This covers the isPaidCloudRateLimitFailure
  // soft-failure branch (a PAID cloud model hitting provider_error, escalated
  // to the hard-cooldown "likely rate limit" wording).
  it('also shows a computed "(resets ...)" time on the paid-cloud provider_error branch', async () => {
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
          find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
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

        expect(routerInfoText).toContain('likely rate limit');
        expect(routerInfoText).toMatch(/\(resets .+\)/);
      }
    );
  }, 30000);
});
