/**
 * Regression test for the 0.99.1 hardening (ADR-0019, plan
 * docs/plans/2026-09-30-router-0.99.1-hardening.md).
 *
 * Pi 0.99.1 composes each provider as builtin catalog + models.json +
 * extension overlay, and `modelRegistry.getAll()` returns models of ALL
 * types (chat, image, classifier) for a provider. The builtin openrouter
 * catalog alone ships 53 image models and 8 classifier models (jev family).
 *
 * The scan-union re-registration round-trips pi-known models before calling
 * registerProvider (whose `models` field replaces the composed list
 * wholesale — ADR-0005/0019). Its field allow-list was chat-only: no `type`,
 * no `output`, no `inputLimits`. Under 0.99.1 that does not merely risk a
 * wipe — a non-chat model that survives the union is re-registered AS A
 * CHAT MODEL (type lost), corrupting the chat list (e.g. an image model
 * becoming chat-selectable).
 *
 * The union must therefore preserve `type` and the non-chat fields through
 * the round-trip. On 0.87.1 hosts the spreads are conditional (fields
 * absent on their chat-only models), so behavior there is unchanged.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeNoOpScanCache, flushBackgroundScan } from './helpers/noop-scan-cache.ts';

const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

async function withIsolatedRouter(
  configOverride: Record<string, unknown>,
  scanModels: Array<Record<string, unknown>>,
  fn: (defaultExport: any, tmpDir: string) => Promise<void>
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-non-chat-preserve-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const dynBak = `${dynamicConfigPath}.non-chat-preserve-bak`;
  const cacheBak = `${scanCachePath}.non-chat-preserve-bak`;
  const hadDyn = fs.existsSync(dynamicConfigPath);
  const hadCache = fs.existsSync(scanCachePath);
  if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
  if (hadCache) fs.renameSync(scanCachePath, cacheBak);

  fs.writeFileSync(
    scanCachePath,
    JSON.stringify({
      available_models: scanModels,
      gdpval_scores: {},
      openrouter_pricing: {},
      // Numeric epoch ms (an ISO string is not a valid timestamp and made the
      // background scan regenerate and write into the next test).
      lastScanTimestamp: Date.now(),
      dynamic_config_expected: false,
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
  }
}

/** pi-known chat model the scan reports. */
const knownChat = {
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

/** pi-known image model (0.99.1 builtin-catalog shape) — never in the scan. */
const knownImage = {
  id: 'black-forest-labs/flux.2-flex',
  name: 'Black Forest Labs: FLUX.2 Flex',
  provider: 'mistral-zai',
  api: 'mistral-images',
  baseUrl: 'https://api.mistral.ai/v1',
  type: 'image',
  input: ['text', 'image'],
  output: ['image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  inputLimits: { images: { max: 4 } },
  promptCache: { type: 'openrouter' },
};

/** pi-known classifier model (0.99.1 builtin-catalog shape) — never in the scan. */
const knownClassifier = {
  id: 'typesafe/jev-1.13',
  name: 'TypeSafe: Jev 1.13',
  provider: 'mistral-zai',
  api: 'typesafe-system-one',
  baseUrl: 'https://api.mistral.ai/v1',
  type: 'classifier',
  input: ['text'],
  cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
};

describe('registerGroupModels union: non-chat model preservation under 0.99.1', () => {
  it('round-trips image and classifier models with their type intact when the scan adds a new chat model', async () => {
    await withIsolatedRouter(
      {
        free_models: [],
        providers: {
          'mistral-zai': { keys: [{ key: 'test-key' }] },
        },
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
      },
      // The scan reports the known chat model PLUS a new one — that forces
      // the union past the skip check and into the registerProvider call.
      [
        { id: 'zai-glm-5-2', provider: 'mistral-zai', cost_per_m: 0, capabilities: { reasoning: true } },
        { id: 'glm-5-2', provider: 'mistral-zai', cost_per_m: 0, capabilities: { reasoning: true } },
      ],
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

        // Under 0.99.1 getAll() returns models of ALL types for the
        // provider — chat, image, and classifier alike.
        const modelRegistry = {
          getAll: () => [knownChat, knownImage, knownClassifier],
          getAvailable: () => [knownChat],
          find: (provider: string, modelId: string) =>
            provider === 'mistral-zai' && modelId === 'zai-glm-5-2' ? knownChat : null,
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

        // The scan-new chat model registers (the union's purpose, unchanged).
        expect(ids).toContain('glm-5-2');
        // The scanned known chat model survives byte-for-byte (425/426 + 649
        // regressions; compat and every allow-listed field round-trip intact).
        expect(ids).toContain('zai-glm-5-2');
        const roundTrippedChat = registeredModels.find((m) => m.id === 'zai-glm-5-2');
        expect(roundTrippedChat).toEqual({
          id: 'zai-glm-5-2',
          name: 'mistral-zai/zai-glm-5-2',
          api: 'openai-completions',
          baseUrl: 'https://api.mistral.ai/v1',
          reasoning: true,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 8_000,
          compat: { supportsStore: false },
        });

        // The image model survives WITH its type — the pre-hardening allow-list
        // stripped `type`, re-registering it as a chat model.
        expect(ids).toContain('black-forest-labs/flux.2-flex');
        const roundTrippedImage = registeredModels.find(
          (m) => m.id === 'black-forest-labs/flux.2-flex'
        );
        expect(roundTrippedImage.type).toBe('image');
        expect(roundTrippedImage.output).toEqual(['image']);
        expect(roundTrippedImage.inputLimits).toEqual({ images: { max: 4 } });
        expect(roundTrippedImage.api).toBe('mistral-images');
        // Byte-for-byte: the round-trip emits EXACTLY the allow-listed fields
        // the model carries — no added explicit-undefined keys (the pre-fix
        // allow-list added reasoning: undefined to every non-chat model).
        expect(Object.keys(roundTrippedImage).sort()).toEqual(
          [
            'api',
            'baseUrl',
            'cost',
            'id',
            'input',
            'inputLimits',
            'name',
            'output',
            'promptCache',
            'type',
          ].sort()
        );

        // The classifier model survives WITH its type.
        expect(ids).toContain('typesafe/jev-1.13');
        const roundTrippedClassifier = registeredModels.find((m) => m.id === 'typesafe/jev-1.13');
        expect(roundTrippedClassifier.type).toBe('classifier');
        expect(roundTrippedClassifier.contextWindow).toBe(32_000);
      }
    );
  }, 30000);

  it('does not re-register at all when the scan reports no new models (non-chat models untouched)', async () => {
    await withIsolatedRouter(
      {
        free_models: [],
        providers: {
          'mistral-zai': { keys: [{ key: 'test-key' }] },
        },
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
      },
      // Only the known chat model — the skip check must fire, no
      // registerProvider call for the provider, image/classifier untouched.
      [{ id: 'zai-glm-5-2', provider: 'mistral-zai', cost_per_m: 0, capabilities: { reasoning: true } }],
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

        const modelRegistry = {
          getAll: () => [knownChat, knownImage, knownClassifier],
          getAvailable: () => [knownChat],
          find: (provider: string, modelId: string) =>
            provider === 'mistral-zai' && modelId === 'zai-glm-5-2' ? knownChat : null,
          getApiKeyForProvider: async () => null,
          runtime: { streamSimple: vi.fn() },
        };
        const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        const mistralZaiCalls = registerProviderCalls.filter((c) => c.name === 'mistral-zai');
        expect(mistralZaiCalls).toEqual([]);
      }
    );
  }, 30000);
});
