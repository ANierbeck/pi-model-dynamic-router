/**
 * Regression test: registerGroupProviders() used to call resolve() for
 * EVERY group, including method:'dynamic' ones. resolve() always returns
 * null for dynamic groups by design (they're resolved per-prompt by the
 * classifier hook inside groupStream, not statically at registration time)
 * — so the dynamic group's virtual model entry in Pi's model picker showed
 * the misleading label "dynamic → none", as if no model were available at
 * all.
 *
 * Fix: dynamic-method groups get a label that reflects what they actually
 * do ("auto-classify") instead of the resolve() result.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireRouterStateLock, releaseRouterStateLock } from './helpers/router-state-lock.ts';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dynamicConfigPath = path.join(repoRoot, 'router-config.dynamic.json');
const dynamicConfigBackupPath = `${dynamicConfigPath}.label-test-bak`;

describe('registerGroupProviders(): dynamic-method group labeling', () => {
  it('labels the dynamic group "auto-classify" instead of the misleading "→ none"', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-label-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.pi', 'router-config.json'),
      JSON.stringify({
        free_models: [],
        model_groups: {
          standard: { fallback_groups: [], min_gdpval: 0 },
          dynamic: { method: 'dynamic', fallback_groups: [] },
        },
      })
    );
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    await acquireRouterStateLock();
    if (fs.existsSync(dynamicConfigPath)) fs.renameSync(dynamicConfigPath, dynamicConfigBackupPath);
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

      const dynamicCall = registerProvider.mock.calls.find((call: any[]) => call[0] === 'dynamic');
      expect(dynamicCall).toBeDefined();
      const models = dynamicCall![1].models;

      const mainEntry = models.find((m: any) => m.id === 'dynamic');
      expect(mainEntry.name).toBe('dynamic → auto-classify');
      expect(mainEntry.name).not.toContain('none');

      const staticFallbackEntry = models.find((m: any) => m.id === 'dynamic:use-static');
      expect(staticFallbackEntry).toBeDefined();
      expect(staticFallbackEntry.name).toBe('dynamic → auto-classify (static fallback allowed)');
      expect(staticFallbackEntry.name).not.toContain('none');

      // A non-dynamic group is unaffected: it still shows its resolved model
      // (or "none" if genuinely nothing resolved — that's the honest state
      // for a static group, unlike the dynamic group's classifier-at-runtime
      // design).
      const standardCall = registerProvider.mock.calls.find((call: any[]) => call[0] === 'standard');
      expect(standardCall).toBeDefined();
      const standardEntry = standardCall![1].models.find((m: any) => m.id === 'standard');
      expect(standardEntry.name).toMatch(/^standard → /);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (fs.existsSync(dynamicConfigBackupPath)) fs.renameSync(dynamicConfigBackupPath, dynamicConfigPath);
      releaseRouterStateLock();
    }
  });
});
