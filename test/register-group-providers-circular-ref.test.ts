/**
 * Regression test: registerGroupProviders() must NOT register virtual models
 * that cause circular references in /router output.
 *
 * Symptom (2026-09-10): /router showed trivial/trivial, simple/simple as
 * top models for their own groups — a circular reference caused by:
 *   1. registerGroupProviders() registered a virtual model with id=groupName
 *      (e.g. 'trivial') for each group
 *   2. Pi's registry picked up these virtual models
 *   3. allDiscoveredRefs() included them
 *   4. resolve('trivial') selected 'trivial/trivial' as the top candidate
 *      (because it was the only model matching the group's filters)
 *
 * Fix: registerGroupProviders() now registers virtual group providers
 * WITHOUT any models (models: []). The streamSimple hook (groupStream) is
 * still invoked correctly by Pi without needing registered models.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireRouterStateLock, releaseRouterStateLock, writeNoOpScanCache, removeNoOpScanCache } from './helpers/router-state-lock.ts';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dynamicConfigPath = path.join(repoRoot, 'router-config.dynamic.json');
const dynamicConfigBackupPath = `${dynamicConfigPath}.circular-ref-test-bak`;
const scanCachePath = path.join(repoRoot, '.cache', 'scan-cache.json');

describe('registerGroupProviders(): no circular reference via virtual models', () => {
  it('registers virtual group providers with NO models (prevents circular ref)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-circular-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.pi', 'router-config.json'),
      JSON.stringify({
        free_models: [],
        model_groups: {
          trivial: { method: 'min_cost_if_all_priced', max_cost: 0, fallback_groups: [] },
          simple: { method: 'min_cost_if_all_priced', max_cost: 0.01, fallback_groups: [] },
          standard: { method: 'tiered', min_gdpval: 500, fallback_groups: [] },
        },
      })
    );
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    await acquireRouterStateLock();
    if (fs.existsSync(dynamicConfigPath)) fs.renameSync(dynamicConfigPath, dynamicConfigBackupPath);

    writeNoOpScanCache(scanCachePath);
    try {
      vi.resetModules();
      const mod = await import('../index.ts');
      const defaultExport = mod.default as any;

      const registerProvider = vi.fn();
      const pi: any = {
        registerTool: vi.fn(),
        registerCommand: vi.fn(),
        registerProvider,
        setModel: vi.fn(async () => true),
        on: vi.fn(),
      };
      defaultExport(pi);

      // Every group should register with models: [] (no virtual models)
      for (const groupName of ['trivial', 'simple', 'standard']) {
        const groupCall = registerProvider.mock.calls.find((call: any[]) => call[0] === groupName);
        expect(groupCall, `Group ${groupName} should be registered`).toBeDefined();
        const models = groupCall![1].models;
        expect(models, `Group ${groupName} should have NO models to prevent circular ref`).toEqual([]);
      }
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      removeNoOpScanCache(scanCachePath);

      if (fs.existsSync(dynamicConfigBackupPath)) fs.renameSync(dynamicConfigBackupPath, dynamicConfigPath);
      releaseRouterStateLock();
    }
  });
});
