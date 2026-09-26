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

async function startRouterWithCache(extraCache: Record<string, unknown>, existingDynamic?: unknown) {
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
    } finally {
      cleanup();
    }
  });
});
