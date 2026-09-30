/**
 * End-to-end regression for the 2026-09-27 Mistral incident.
 *
 * Every router-scanned mistral/mistral-zai model answered with a bare
 * "422 status code (no body)" (request-shaped client error from the
 * OpenAI-compatible transport — Le Platform rejects pi-ai's payload for
 * these models). isPaidCloudRateLimitFailure blanket-escalated provider_error
 * on paid cloud models into the hard-cooldown ladder, so each failing
 * attempt put the model on a 24h cooldown with a "likely rate limit
 * (resets ...)" narration. Within minutes the whole mistral block was
 * locked out and the chain hopped to unrelated models — the "constant
 * model hopping" symptom.
 *
 * The detection fix gates provider_error on the error TEXT: a bare 422
 * (no HTTP 429/402, no rate-limit wording) now records only the SHORT
 * soft backoff and narrates a plain provider error — no "likely rate
 * limit", no reset time, no hard cooldown. Unit coverage of the gate
 * lives in test/detection.test.ts; this file pins the full driveStream
 * behavior with the exact production error text.
 */
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-422-soft-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const dynBak = `${dynamicConfigPath}.422-soft-bak`;
  const cacheBak = `${scanCachePath}.422-soft-bak`;
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

describe('driveStream: bare 422 on a paid cloud model is a soft failure, not a rate limit', () => {
  it('production text "422 status code (no body)": soft 30s backoff, plain provider-error wording, collapse force-retry still works', async () => {
    await withIsolatedRouter(
      {
        free_models: [],
        providers: { openrouter: { free_models: [] } },
        rate_limit_wait_max_ms: 0,
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

        // PAID cloud model (no ':free' suffix, not ollama/lm-studio) failing
        // with the exact production error text from the 2026-09-27 incident.
        const paidModel = {
          provider: 'paid-cloud-provider',
          id: 'paid-model',
          api: 'openai-completions',
          contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        };
        const modelsByRef: Record<string, any> = {
          'paid-cloud-provider/paid-model': paidModel,
        };
        const streamSimple = vi.fn(() => {
          return (async function* () {
            yield {
              type: 'error',
              error: { errorMessage: '422 status code (no body)' },
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

        // The failure is narrated as a plain provider error with its detail …
        expect(routerInfoText).toContain('provider error: 422 status code (no body)');
        // … NOT as a rate limit: no hard-cooldown framing, no reset time.
        expect(routerInfoText).not.toContain('likely rate limit');
        expect(routerInfoText).not.toMatch(/\(resets .+\)/);
        // Only the SHORT soft backoff was recorded, so the single-pass
        // cooldown-collapse force-retries within this call (original attempt
        // + force-retry) instead of waiting out a hard ladder tier.
        expect(streamSimple).toHaveBeenCalledTimes(2);
        expect(routerInfoText).toMatch(/All models in cooldown[^\n]*\(shortest cooldown, 30s\)/);
      }
    );
  }, 30000);
});
