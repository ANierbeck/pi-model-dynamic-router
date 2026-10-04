// test/dynamic-config-missing-regen.test.ts
// Live 2026-09-26: dist/ was recreated with the scan cache (lastScanTimestamp
// 2026-09-20, valid for 30 days) but without router-config.dynamic.json.
// generateDynamicConfig early-returned on the valid cache, so the router ran
// on the static config with no persisted group lists until the cache expired.

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function waitFor(check: () => boolean, ms = 3_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

async function startRouterWithCache(
  extraCache: Record<string, unknown>,
  existingDynamic?: unknown,
  projectConfig?: Record<string, unknown>
) {
  const stateDir = process.env.PI_ROUTER_STATE_DIR!;
  const dynamicPath = path.join(stateDir, 'router-config.dynamic.json');
  const cachePath = path.join(stateDir, '.cache', 'scan-cache.json');
  fs.rmSync(dynamicPath, { force: true });
  if (existingDynamic) fs.writeFileSync(dynamicPath, JSON.stringify(existingDynamic));
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      lastScanTimestamp: Date.now(),
      gdpval_scraped: true,
      models_cached: new Date().toISOString(),
      available_models: [{ id: 'model-a', provider: 'healthy-provider', cost_per_m: 0.1 }],
      gdpval_scores: { 'model-a': 800 },
      ...extraCache,
    })
  );
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-dyn-missing-'));
  if (projectConfig) {
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(projectConfig));
  }
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error('network disabled in test'))) as typeof fetch;
  try {
    vi.resetModules();
    const mod = await import('../index.ts');
    const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
    (mod.default as any)({
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerProvider: vi.fn(),
      setModel: vi.fn(async () => true),
      on: vi.fn((event: string, handler: any) => {
        onHandlers[event] = handler;
      }),
    });
    const model = { provider: 'healthy-provider', id: 'model-a', api: 'openai-completions', contextWindow: 128_000,
      cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 } };
    const modelRegistry = {
      getAvailable: () => [model],
      find: (p: string, id: string) => (p === model.provider && id === model.id ? model : null),
      getApiKeyForProvider: async () => 'k',
      runtime: { streamSimple: vi.fn() },
    };
    await onHandlers['session_start']?.({}, { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } });
    return { dynamicPath, cleanup: () => {
      cwdSpy.mockRestore();
      globalThis.fetch = originalFetch;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(dynamicPath, { force: true });
    } };
  } catch (e) {
    cwdSpy.mockRestore();
    globalThis.fetch = originalFetch;
    throw e;
  }
}

describe('valid scan cache but missing router-config.dynamic.json', () => {
  it('regenerates the dynamic config on session_start', async () => {
    const { dynamicPath, cleanup } = await startRouterWithCache({});
    try {
      expect(await waitFor(() => fs.existsSync(dynamicPath))).toBe(true);
      expect(JSON.parse(fs.readFileSync(dynamicPath, 'utf-8'))._dynamic).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it('leaves a fixture cache marked dynamic_config_expected: false alone', async () => {
    const { dynamicPath, cleanup } = await startRouterWithCache({ dynamic_config_expected: false });
    try {
      expect(await waitFor(() => fs.existsSync(dynamicPath), 500)).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe('scan sanity: a collapsed scan must not overwrite a good snapshot', () => {
  it('keeps a 37-model snapshot when a new scan finds only one usable model', async () => {
    const good = {
      _dynamic: { generated_at: '2026-09-26T16:50:23.212Z', model_count: 37 },
      model_groups: { standard: { method: 'best', models: ['healthy-provider/model-a'] } },
    };
    // lastScanTimestamp 0 = expired cache, so generateDynamicConfig runs.
    const { dynamicPath, cleanup } = await startRouterWithCache({ lastScanTimestamp: 0 }, good);
    try {
      await new Promise((r) => setTimeout(r, 500));
      const onDisk = JSON.parse(fs.readFileSync(dynamicPath, 'utf-8'));
      expect(onDisk._dynamic.model_count).toBe(37);
      expect(onDisk._dynamic.generated_at).toBe('2026-09-26T16:50:23.212Z');
      const cacheOnDisk = JSON.parse(
        fs.readFileSync(path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json'), 'utf-8')
      );
      expect(cacheOnDisk.scan_sanity_refusal).toMatchObject({ previous: 37 });
      expect(cacheOnDisk.scan_sanity_refusal.survivors).toBeLessThan(37 / 2);
    } finally {
      cleanup();
    }
  });

  const GOOD = {
    _dynamic: { generated_at: '2026-09-26T16:50:23.212Z', model_count: 37 },
    model_groups: { standard: { method: 'best', models: ['healthy-provider/model-a'] } },
  };
  const cachePath = () => path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');
  const readCache = () => JSON.parse(fs.readFileSync(cachePath(), 'utf-8'));

  async function firstRefusal(): Promise<{ survivors: number; previous: number; at: number }> {
    const first = await startRouterWithCache({ lastScanTimestamp: 0 }, GOOD);
    try {
      expect(await waitFor(() => !!readCache().scan_sanity_refusal)).toBe(true);
      // Let this instance's background scan finish before the next router
      // starts: both write the same state dir.
      await new Promise((r) => setTimeout(r, 500));
      return readCache().scan_sanity_refusal;
    } finally {
      first.cleanup();
    }
  }

  it('a settled scan with the same smaller result accepts it (real shrink, review 2026-09-27)', async () => {
    const refusal = await firstRefusal();
    const { dynamicPath, cleanup } = await startRouterWithCache(
      { lastScanTimestamp: 0, scan_sanity_refusal: refusal }, GOOD, { scan_settle_ms: 0 }
    );
    try {
      expect(await waitFor(() => JSON.parse(fs.readFileSync(dynamicPath, 'utf-8'))._dynamic.model_count === refusal.survivors)).toBe(true);
      expect(readCache().scan_sanity_refusal).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('a repeated start-up result is not accepted: an unsettled scan never confirms a shrink', async () => {
    const refusal = await firstRefusal();
    const { dynamicPath, cleanup } = await startRouterWithCache({ lastScanTimestamp: 0, scan_sanity_refusal: refusal }, GOOD);
    try {
      await new Promise((r) => setTimeout(r, 500));
      expect(JSON.parse(fs.readFileSync(dynamicPath, 'utf-8'))._dynamic.model_count).toBe(37);
    } finally {
      cleanup();
    }
  });

  // CI-load budgets: waitFor polls every 25ms and exits as soon as the
  // condition holds, so generous budgets cost nothing on a healthy run —
  // but the 1s refusal budget was too tight on a loaded CI runner (PR #18,
  // run 37205616141: the spawn + scan_settle_ms 300 + runner jitter exceeded
  // it; locally 5/5 green, the audit-documented intermittent was this test).
  // The per-test timeout is raised to match the worst-case wait budget.
  it('after a start-up refusal, one settled re-check in the same session accepts a real shrink', async () => {
    const { dynamicPath, cleanup } = await startRouterWithCache({ lastScanTimestamp: 0 }, GOOD, { scan_settle_ms: 300 });
    try {
      expect(await waitFor(() => !!readCache().scan_sanity_refusal, 10_000)).toBe(true);
      expect(await waitFor(() => JSON.parse(fs.readFileSync(dynamicPath, 'utf-8'))._dynamic.model_count < 37, 10_000)).toBe(true);
    } finally {
      cleanup();
    }
  }, 25_000);

  it('ignores a refusal older than 24 h', async () => {
    const refusal = await firstRefusal();
    const stale = { ...refusal, at: Date.now() - 25 * 60 * 60_000 };
    const { dynamicPath, cleanup } = await startRouterWithCache(
      { lastScanTimestamp: 0, scan_sanity_refusal: stale }, GOOD, { scan_settle_ms: 0 }
    );
    try {
      await new Promise((r) => setTimeout(r, 500));
      expect(JSON.parse(fs.readFileSync(dynamicPath, 'utf-8'))._dynamic.model_count).toBe(37);
      expect(readCache().scan_sanity_refusal.at).toBeGreaterThan(stale.at);
    } finally {
      cleanup();
    }
  });
});
