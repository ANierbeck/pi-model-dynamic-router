// test/dynamic-config-stale-fingerprint.test.ts
// Merge review 2026-11-01 (Important 3a): load() accepted a persisted
// router-config.dynamic.json without checking its groups fingerprint, so a
// snapshot from an older group layout (e.g. the pre-five-group 13 groups
// incl. `tactical`) was loaded at startup and its virtual group providers were
// registered into Pi and used for routing until the background scan regenerated
// the file. Now a stored groups_fingerprint that does not match the current
// static model_groups makes load() ignore the snapshot and use the static
// config; the groups-drift check in dynamic-config-runner regenerates the
// snapshot on the next scan. Snapshots predating the fingerprint (undefined)
// stay accepted — the scan regenerates them once (self-healing, PR #68).

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function startRouter(existingDynamic: unknown) {
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
    })
  );
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-stale-fp-'));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error('network disabled in test'))) as typeof fetch;
  const registeredProviders: string[] = [];
  try {
    vi.resetModules();
    const mod = await import('../index.ts');
    const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
    (mod.default as any)({
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerProvider: vi.fn((id: string) => {
        registeredProviders.push(id);
      }),
      setModel: vi.fn(async () => true),
      on: vi.fn((event: string, handler: any) => {
        onHandlers[event] = handler;
      }),
    });
    const model = {
      provider: 'healthy-provider',
      id: 'model-a',
      api: 'openai-completions',
      contextWindow: 128_000,
      cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 },
    };
    const modelRegistry = {
      getAvailable: () => [model],
      find: (p: string, id: string) => (p === model.provider && id === model.id ? model : null),
      getApiKeyForProvider: async () => 'k',
      runtime: { streamSimple: vi.fn() },
    };
    await onHandlers['session_start']?.({}, { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } });
    return {
      registeredProviders,
      cleanup: () => {
        cwdSpy.mockRestore();
        globalThis.fetch = originalFetch;
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(dynamicPath, { force: true });
      },
    };
  } catch (e) {
    cwdSpy.mockRestore();
    globalThis.fetch = originalFetch;
    throw e;
  }
}

describe('stale groups fingerprint in the persisted dynamic config', () => {
  it('ignores a snapshot whose groups_fingerprint mismatches the static groups (no legacy group providers registered)', async () => {
    const legacy = {
      model_groups: { tactical: { method: 'best', min_gdpval: 600 }, scout: { method: 'best' } },
      _dynamic: { generated_at: 'OLD', groups_fingerprint: 'stale-fingerprint' },
    };
    const { registeredProviders, cleanup } = await startRouter(legacy);
    try {
      // Red-first: before the fix, load() accepted the stale snapshot and
      // registerGroupProviders registered the legacy virtual groups into Pi.
      expect(registeredProviders).not.toContain('tactical');
      expect(registeredProviders).not.toContain('scout');
      // the static (current five-group) layout is what gets registered
      expect(registeredProviders).toContain('planning');
    } finally {
      cleanup();
    }
  });

  it('still accepts a snapshot without a fingerprint (legacy file, self-healed by the scan)', async () => {
    const legacy = {
      model_groups: { tactical: { method: 'best' } },
      _dynamic: { generated_at: 'LEGACY' },
    };
    const { registeredProviders, cleanup } = await startRouter(legacy);
    try {
      expect(registeredProviders).toContain('tactical');
    } finally {
      cleanup();
    }
  });
});
