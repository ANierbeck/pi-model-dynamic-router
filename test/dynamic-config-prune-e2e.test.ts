// test/dynamic-config-prune-e2e.test.ts
// End-to-end companion of dynamic-config-prune.test.ts: the real
// session_start (load() resync) → scan → generateDynamicConfig path must
// (1) prune what the remembered static contribution says a static layer
// dropped, (2) keep the scan-added / learned entries, (3) persist the current
// contribution in the regenerated file for the next round.

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function waitFor(check: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

describe('regeneration prunes static-removed merge-key entries', () => {
  it('drops the remembered sentinel + free_models, keeps the learned entry, re-records the contribution', async () => {
    const stateDir = process.env.PI_ROUTER_STATE_DIR!;
    const dynamicPath = path.join(stateDir, 'router-config.dynamic.json');
    const cachePath = path.join(stateDir, '.cache', 'scan-cache.json');
    const previousDynamic = {
      _dynamic: {
        generated_at: '2026-09-26T16:50:23.212Z',
        static_contributions: {
          providers: { openrouter: ['billing', 'free_models'] },
          model_metrics: { 'removed/sentinel': ['cost_per_m'] },
          gdpval_builtin: {},
        },
      },
      model_groups: { standard: { method: 'best', models: ['healthy-provider/model-a'] } },
      providers: { openrouter: { billing: 'pay_per_token', free_models: ['openrouter/old:free'] } },
      model_metrics: {
        'removed/sentinel': { cost_per_m: 5e-7 },
        'learned/model': { throughput_tps: 42 },
      },
    };
    fs.writeFileSync(dynamicPath, JSON.stringify(previousDynamic));
    // lastScanTimestamp 0 = expired cache, so the scan regenerates the file.
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        lastScanTimestamp: 0,
        gdpval_scraped: true,
        models_cached: new Date().toISOString(),
        available_models: [{ id: 'model-a', provider: 'healthy-provider', cost_per_m: 0.1 }],
        gdpval_scores: { 'model-a': 800 },
      })
    );
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-dyn-prune-'));
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

      const regenerated = () => {
        const d = JSON.parse(fs.readFileSync(dynamicPath, 'utf-8'));
        return d._dynamic.generated_at !== previousDynamic._dynamic.generated_at ? d : null;
      };
      expect(await waitFor(() => regenerated() !== null)).toBe(true);
      const onDisk = regenerated();
      expect(onDisk.model_metrics['removed/sentinel']).toBeUndefined();
      expect(onDisk.model_metrics['learned/model']).toEqual({ throughput_tps: 42 });
      expect(onDisk.providers.openrouter?.free_models).toBeUndefined();
      // The write site persists the CURRENT static contribution.
      expect(Object.keys(onDisk._dynamic.static_contributions).sort()).toEqual(['gdpval_builtin', 'model_metrics', 'providers']);
      expect(onDisk._dynamic.static_contributions.model_metrics['removed/sentinel']).toBeUndefined();
    } finally {
      cwdSpy.mockRestore();
      globalThis.fetch = originalFetch;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(dynamicPath, { force: true });
    }
  });
});
