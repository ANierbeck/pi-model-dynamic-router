/**
 * Regression test for roborev job 425/426 (HIGH finding) on the F4 fix
 * (2026-09-02 architecture review): registerGroupModels' Ü1 guard used to
 * skip registering a WHOLE provider if pi already knew ANY one of its
 * models. The fix made it skip only the individual models pi already knows,
 * registering the rest — but the first version of that fix called
 * `pi.registerProvider(provId, { models: newModels })` with ONLY the new
 * models.
 *
 * Per pi's own docs (node_modules/@earendil-works/pi-coding-agent/docs/
 * custom-provider.md: "When models is provided, it replaces all existing
 * models for that provider") and this repo's own CLAUDE.md rule #6,
 * `registerProvider`'s `models` field REPLACES the provider's entire model
 * list — it does not merge. Calling it with only the new models therefore
 * silently DELETED pi's existing registration for the models it already
 * knew (compat flags included) — the exact destructive overwrite Ü1 exists
 * to prevent, reintroduced for the very provider (mistral-zai) the fix was
 * written to unblock.
 *
 * Fix: round-trip pi's own already-known Model objects (preserving their
 * compat flags) and pass the UNION of those plus the new models, so the
 * registerProvider call is a true add, not a replace.
 */
import { describe, it, expect, vi } from 'vitest';
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

async function withIsolatedRouter(
  configOverride: Record<string, unknown>,
  fn: (defaultExport: any, tmpDir: string) => Promise<void>
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-merge-not-replace-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const dynBak = `${dynamicConfigPath}.merge-not-replace-bak`;
  const cacheBak = `${scanCachePath}.merge-not-replace-bak`;
  await acquireRouterStateLock();
  const hadDyn = fs.existsSync(dynamicConfigPath);
  const hadCache = fs.existsSync(scanCachePath);
  if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
  if (hadCache) fs.renameSync(scanCachePath, cacheBak);

  // Seed the scan cache with two mistral-zai models: one pi already knows
  // (zai-glm-5-2, with a compat flag pi's models.json protects) and one it
  // doesn't (glm-5-2, the scored variant F4 is about making visible).
  fs.writeFileSync(
    scanCachePath,
    JSON.stringify({
      available_models: [
        { id: 'zai-glm-5-2', provider: 'mistral-zai', cost_per_m: 0, capabilities: { reasoning: true } },
        { id: 'glm-5-2', provider: 'mistral-zai', cost_per_m: 0, capabilities: { reasoning: true } },
      ],
      gdpval_scores: { 'glm-5-2': 1497 },
      openrouter_pricing: {},
      lastScanTimestamp: new Date().toISOString(),
    })
  );

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

describe('registerGroupModels: mixed known/unknown models for one provider', () => {
  it('registers the UNION of pi-known and newly-discovered models, not just the new ones', async () => {
    await withIsolatedRouter(
      {
        free_models: [],
        providers: {
          'mistral-zai': { keys: [{ key: 'test-key' }] },
        },
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
      },
      async (defaultExport, tmpDir) => {
        const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
        const registerProviderCalls: any[] = [];
        const pi: any = {
          registerTool: vi.fn(),
          registerCommand: vi.fn(),
          registerProvider: vi.fn((name: string, opts: any) => {
            registerProviderCalls.push({ name, opts });
          }),
          setModel: vi.fn(async () => true),
          on: vi.fn((event: string, handler: any) => {
            onHandlers[event] = handler;
          }),
        };
        defaultExport(pi);

        // pi already knows zai-glm-5-2 (e.g. via models.json), with a compat
        // flag that must survive any re-registration. It does NOT know
        // glm-5-2 (the scored variant).
        const knownModel = {
          id: 'zai-glm-5-2',
          name: 'mistral-zai/zai-glm-5-2',
          provider: 'mistral-zai',
          api: 'openai-completions',
          baseUrl: 'https://api.mistral.ai/v1',
          reasoning: true,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 8_000,
          compat: { supportsStore: false },
        };
        const modelRegistry = {
          getAvailable: () => [knownModel],
          find: (provider: string, modelId: string) =>
            provider === 'mistral-zai' && modelId === 'zai-glm-5-2' ? knownModel : null,
          getApiKeyForProvider: async () => null,
          runtime: { streamSimple: vi.fn() },
        };
        const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        const mistralZaiCalls = registerProviderCalls.filter((c) => c.name === 'mistral-zai');
        expect(mistralZaiCalls.length).toBeGreaterThan(0);

        const registeredModels = mistralZaiCalls[0].opts.models as any[];
        const ids = registeredModels.map((m) => m.id);

        // The new, scored model must be present (the actual F4 goal).
        expect(ids).toContain('glm-5-2');
        // The already-known model must ALSO still be present — proving this
        // is a true add, not a destructive replace.
        expect(ids).toContain('zai-glm-5-2');
        // And its compat flags must have survived the round-trip.
        const roundTripped = registeredModels.find((m) => m.id === 'zai-glm-5-2');
        expect(roundTripped.compat).toEqual({ supportsStore: false });
      }
    );
  }, 15000);
});
