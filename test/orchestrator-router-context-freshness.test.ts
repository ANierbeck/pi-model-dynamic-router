/**
 * Regression test for the "running in circles" / self-contradictory
 * "still in cooldown (0s remaining)" bug (2026-09-02).
 *
 * buildOrchestratorContext() (index.ts) captures `router`, `rateLimitManager`,
 * and `cacheManager` as PLAIN object properties, evaluated once when the
 * StreamOrchestrator is constructed — unlike `cfg`/`cache`/`activeGroup` in
 * the same object literal, which are getters that always read the current
 * module-level binding. But `load()` REASSIGNS all three (`router = new
 * Router(...)`, `rateLimitManager = new RateLimitManager(...)`, `cacheManager
 * = new CacheManager(...)`) on every session_start AND on every
 * resolve_model_group/update_model_metrics tool call and /router
 * slash-command invocation — session_start alone runs load() a second time
 * (module setup runs load() once already, before StreamOrchestrator is even
 * constructed), immediately orphaning ctx.router in every session.
 *
 * Symptom: ctx.isLimited(ref) is a function closure that always reads the
 * CURRENT `rateLimitManager` variable, so it correctly reports a ref as
 * rate-limited. But ctx.router.limitSecs(ref) reads the STALE, orphaned
 * Router's private Map — which never received that cooldown (or any cooldown
 * recorded after the staleness set in) — and always returns 0. Logged as the
 * self-contradictory "skipped, still in cooldown (0s remaining)". The same
 * staleness also broke the total-cooldown-collapse force-retry logic (ranks
 * candidates by ctx.router.limitSecs to retry the LEAST-cooled-down one),
 * contributing to an observed "running in circles" failure loop.
 *
 * Fix: router/rateLimitManager/cacheManager are now getters in
 * buildOrchestratorContext, matching the existing cfg/cache/activeGroup
 * pattern, so they always resolve the live module-level binding.
 *
 * This test exercises the total-cooldown-collapse force-retry branch
 * specifically (stream-orchestrator.ts ~line 680), since a single-candidate
 * group has nothing else to fall through to — driveStream force-retries the
 * one candidate it has rather than reporting a plain "still in cooldown"
 * skip. That branch calls the exact same ctx.router.limitSecs() that was
 * reading the stale Map.
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-ctx-freshness-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const dynBak = `${dynamicConfigPath}.ctx-freshness-bak`;
  const cacheBak = `${scanCachePath}.ctx-freshness-bak`;
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

describe('StreamOrchestrator context freshness: router/rateLimitManager/cacheManager', () => {
  it('ctx.router.limitSecs() reports the real remaining cooldown after session_start reassigns router (not 0)', async () => {
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
        // Module setup runs load() once here (site #1) and constructs
        // StreamOrchestrator, capturing whatever `router` is at this point.
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
        // Always fails with a hard-cooldown-worthy provider error (mirrors
        // test/provider-error-paid-cloud-cooldown.test.ts).
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
        // session_start calls load() a SECOND time (site #2) — this is what
        // reassigns router/rateLimitManager/cacheManager to new instances
        // AFTER StreamOrchestrator already captured the old ones. Every real
        // session hits this on its very first session_start.
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        const groupModel = { provider: 'standard', id: 'standard' };
        const context: any = { messages: [{ role: 'user', content: 'do the thing' }] };

        // First call: the model fails and gets a hard cooldown recorded
        // against it (backoff_minutes[0] = 1 minute = 60s).
        await drainStream(defaultExport.groupStream(groupModel, context, {}));
        expect(streamSimple).toHaveBeenCalledTimes(1);

        // Second call, same single candidate: with only one candidate in the
        // group, driveStream's "total cooldown collapse" logic force-retries
        // it anyway (nothing else to try) rather than reporting a plain skip
        // — this is the SAME ctx.router.limitSecs() call site (stream-
        // orchestrator.ts's total-cooldown-collapse branch) that ranks
        // candidates by remaining cooldown to pick the least-limited one. A
        // stale ctx.router would report "0s" there too, since its limits Map
        // never received this cooldown.
        const secondEvents = await drainStream(defaultExport.groupStream(groupModel, context, {}));
        expect(streamSimple).toHaveBeenCalledTimes(2);

        const secondRouterInfoText = secondEvents
          .filter((e: any) => e.type === 'text_delta')
          .map((e: any) => (e as any).delta ?? '')
          .join('');

        expect(secondRouterInfoText).toContain('cooldown');
        const match = secondRouterInfoText.match(/(\d+)s\)/);
        expect(match).not.toBeNull();
        // The bug reported an unconditional 0, so explicitly rule that out
        // in addition to the >30 bound below.
        expect(match![1]).not.toBe('0');
        const remainingSecs = Number(match![1]);
        // Should be close to the full 60s hard cooldown, not 0 and not the
        // full window elapsed already (a handful of seconds of test overhead
        // is fine).
        expect(remainingSecs).toBeGreaterThan(30);
        expect(remainingSecs).toBeLessThanOrEqual(60);
      }
    );
  }, 15000);
});
