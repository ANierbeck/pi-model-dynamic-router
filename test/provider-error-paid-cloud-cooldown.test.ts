/**
 * Regression test for roborev job 339 (LOW finding), revised 2026-09-27.
 *
 * driveStream's provider_error branch (unrecognized finish_reason from a
 * mid-stream error event, see test/provider-error-detection.test.ts) applies
 * to any candidate. A PAID cloud model hitting provider_error originally
 * fell through to the soft-backoff branch meant for local/free models; the
 * roborev-339 fix routed it into the hard-cooldown path ("likely rate
 * limit" + key rotation) for EVERY provider_error.
 *
 * The 2026-09-27 Mistral incident showed the flip side: every scanned
 * mistral/mistral-zai model answered with a bare "422 status code (no
 * body)" — a request-shaped client error, not a rate limit — and the
 * blanket escalation put each of them on a 24h hard cooldown, the direct
 * cause of the constant model hopping. isPaidCloudRateLimitFailure now
 * gates provider_error on the error TEXT (HTTP 429/402 or rate-limit
 * wording), so both halves of the original behavior stay pinned here:
 *
 *  - a bare/unrecognized provider error keeps the SOFT-backoff wording
 *    ("provider error: <detail>", no rate-limit framing, no reset time),
 *  - a provider error carrying HTTP 429 keeps the hard-cooldown treatment
 *    ("likely rate limit" + "(resets ...)" + key rotation) that the
 *    original test asserted.
 *
 * The wording is a direct, observable proxy for which escalation branch ran.
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-paid-provider-err-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const dynBak = `${dynamicConfigPath}.paid-provider-err-bak`;
  const cacheBak = `${scanCachePath}.paid-provider-err-bak`;
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

describe('driveStream: provider_error on a paid cloud model', () => {
  // Single PAID cloud candidate (no ':free' suffix, not ollama/lm-studio)
  // failing mid-stream with a provider_error whose TEXT decides which
  // escalation branch runs. Returns the joined router-info text so each
  // test below can pin the observable wording of its branch.
  async function runProviderErrorScenario(errorMessage: string): Promise<string> {
    let routerInfoText = '';
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
              error: { errorMessage },
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
        routerInfoText = events
          .filter((e: any) => e.type === 'text_delta')
          .map((e: any) => e.delta ?? '')
          .join('');
      }
    );
    return routerInfoText;
  }

  it('bare/unrecognized provider error → soft-backoff wording, no hard-cooldown framing', async () => {
    const text = await runProviderErrorScenario('Provider finish_reason: error');
    // Soft branch: the plain provider-error detail is shown ...
    expect(text).toContain('provider error: Provider finish_reason: error');
    // ... WITHOUT the hard-cooldown framing and without a reset time.
    expect(text).not.toContain('likely rate limit');
    expect(text).not.toMatch(/\(resets .+\)/);
  });

  it('provider error carrying HTTP 429 → hard-cooldown ("likely rate limit") treatment', async () => {
    const text = await runProviderErrorScenario('429 too many requests');
    expect(text).toContain('likely rate limit');
    // No provider-announced reset time in the raw text — the router's own
    // cooldown end is shown, worded as OUR backoff (not a fabricated
    // provider "resets", 2026-10-03 honesty fix).
    expect(text).toMatch(/\(backing off [0-9hms ]+, until \d{2}:\d{2}\)/);
  });
});
