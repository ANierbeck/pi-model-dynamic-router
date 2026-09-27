// test/cache-session-reload.test.ts
// Review 2026-09-27: on session_start, load() handed the old cache object to a
// new DiscoveryManager, loadCache() re-read disk into a NEW object, and
// discoverKeys() then set `cache` back to the discovery manager's old one. The
// re-read was lost, and the next save overwrote what another Pi process had
// written in the meantime (e.g. a blocklist entry).

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('session_start re-reads the scan cache into the shared object', () => {
  it('sees a blocklist entry another process wrote between two sessions', async () => {
    const stateDir = process.env.PI_ROUTER_STATE_DIR!;
    const cachePath = path.join(stateDir, '.cache', 'scan-cache.json');
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        lastScanTimestamp: Date.now(),
        dynamic_config_expected: false,
        gdpval_scraped: true,
        models_cached: new Date().toISOString(),
        available_models: [{ id: 'model-a', provider: 'healthy-provider', cost_per_m: 0.1 }],
        gdpval_scores: { 'model-a': 800 },
      })
    );
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-cache-reload-'));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error('network disabled in test'))) as typeof fetch;
    try {
      vi.resetModules();
      const mod = await import('../index.ts');
      const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
      const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
      (mod.default as any)({
        registerTool: vi.fn(),
        registerCommand: vi.fn((name: string, def: any) => {
          commands[name] = def;
        }),
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
      const ctx = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn(), notify: vi.fn() } };

      await onHandlers['session_start']!({}, ctx);
      await new Promise((r) => setTimeout(r, 300)); // let the background scan settle

      // Another Pi process blocks a model and saves the shared cache file.
      const onDisk = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      const now = Date.now();
      onDisk.model_blocklist = {
        'other/blocked-model': { reason: 'decommissioned', code: 404, signature: 'x', first_seen: now, last_seen: now, occurrences: 1 },
      };
      fs.writeFileSync(cachePath, JSON.stringify(onDisk));

      await onHandlers['session_start']!({}, ctx);
      await commands['router']!.handler('blocklist', ctx);
      const shown = ctx.ui.notify.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(shown).toContain('other/blocked-model');
    } finally {
      cwdSpy.mockRestore();
      globalThis.fetch = originalFetch;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
