/**
 * Integration test: the dynamic classifier's short-prompt momentum
 * ('yes', 'do it', 'mach das', ...) must inherit the PREVIOUS turn's
 * resolved category instead of re-classifying from near-zero signal.
 *
 * classifyPrompt() already implemented this logic (see
 * ClassificationContext.lastCategory in src/content-classifier.ts), but the
 * real call site in index.ts never populated `lastCategory` (or
 * `previousUserMessage`) — both fields existed on the type and were read by
 * the classifier, yet the only caller left them undefined, so momentum
 * never actually triggered outside of hand-written unit tests that set
 * `lastCategory` directly. This test drives two turns through the real
 * `groupStream()`/dynamic-group path and asserts the LLM classifier is only
 * called once — on the second, short turn it must be skipped entirely.
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

vi.mock('../src/ollama-utils.ts', () => ({
  callOllama: vi.fn(async () =>
    JSON.stringify({ category: 'code_complex', reason: 'complex refactor', confidence: 0.9 })
  ),
}));

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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-dyn-momentum-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const dynBak = `${dynamicConfigPath}.dynmomentum-bak`;
  const cacheBak = `${scanCachePath}.dynmomentum-bak`;
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

describe('dynamic classifier: short-prompt momentum wiring (index.ts -> classifyPrompt)', () => {
  it('classifies turn 1 via the LLM, then skips the LLM on a short turn-2 follow-up by inheriting lastCategory', async () => {
    const ollamaUtils = await import('../src/ollama-utils.ts');

    await withIsolatedRouter(
      {
        free_models: [],
        providers: {},
        model_groups: {
          dynamic: { method: 'dynamic' },
          tactical: { method: 'best', min_gdpval: 0, fallback_groups: [] },
        },
        gdpval_builtin: {
          'ollama/tactical-model': 1000,
        },
      },
      async (defaultExport, tmpDir) => {
        vi.mocked(ollamaUtils.callOllama).mockClear();

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
        defaultExport(pi);

        const tacticalModel = {
          provider: 'ollama',
          id: 'tactical-model',
          api: 'openai-completions',
          contextWindow: 1_000_000,
        };
        const modelsByRef: Record<string, any> = { 'ollama/tactical-model': tacticalModel };
        const streamSimple = vi.fn(() =>
          (async function* () {
            yield { type: 'text_delta', delta: 'tactical model reply' };
            yield { type: 'done' };
          })()
        );
        const modelRegistry = {
          getAvailable: () => [tacticalModel],
          find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
          getApiKeyForProvider: async () => null,
          runtime: { streamSimple },
        };
        const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        const groupModel = { provider: 'dynamic', id: 'dynamic' };

        // Turn 1: a long, complex-sounding prompt — must go through the LLM
        // classifier (mocked to return 'code_complex').
        const turn1Context: any = {
          messages: [
            {
              role: 'user',
              content:
                'Please refactor the router module into smaller files, extract the ' +
                'rate-limit logic into its own class, and add regression tests.',
            },
          ],
        };
        const turn1Events = await drainStream(defaultExport.groupStream(groupModel, turn1Context, {}));
        const turn1Text = turn1Events
          .filter((e: any) => e.type === 'text_delta')
          .map((e: any) => e.delta ?? '')
          .join('');
        expect(turn1Text).toContain('tactical model reply');
        expect(vi.mocked(ollamaUtils.callOllama)).toHaveBeenCalledTimes(1);

        // Turn 2: a short follow-up ("yes go ahead", 3 words) with no HINT.
        // Before the fix, index.ts never passed lastCategory into
        // classifyPrompt's context, so this would ALSO hit the LLM. After
        // the fix, the classifier's short-prompt-momentum branch fires and
        // the LLM must NOT be called again.
        const turn2Context: any = {
          messages: [
            ...turn1Context.messages,
            { role: 'assistant', content: 'tactical model reply' },
            { role: 'user', content: 'yes go ahead' },
          ],
        };
        const turn2Events = await drainStream(defaultExport.groupStream(groupModel, turn2Context, {}));
        const turn2Text = turn2Events
          .filter((e: any) => e.type === 'text_delta')
          .map((e: any) => e.delta ?? '')
          .join('');
        expect(turn2Text).toContain('tactical model reply');

        // The core assertion: still only ONE LLM call total across both
        // turns — proving lastCategory was carried from turn 1 into turn 2.
        expect(vi.mocked(ollamaUtils.callOllama)).toHaveBeenCalledTimes(1);

        // Turn 3: another long prompt (so momentum does NOT apply and the
        // LLM is called again) — proves previousUserMessage is now also
        // wired: the classifier's prompt to the LLM must contain turn 2's
        // user message ("yes go ahead"), which extractPreviousUserMessage()
        // pulls from context.messages. Before the fix, previousUserMessage
        // was never populated by index.ts, so the context block was always
        // empty for this call site.
        const turn3Context: any = {
          messages: [
            ...turn2Context.messages,
            { role: 'assistant', content: 'tactical model reply' },
            {
              role: 'user',
              content:
                'Now also add integration tests covering the new error paths in that module.',
            },
          ],
        };
        await drainStream(defaultExport.groupStream(groupModel, turn3Context, {}));
        expect(vi.mocked(ollamaUtils.callOllama)).toHaveBeenCalledTimes(2);
        const turn3Prompt = vi.mocked(ollamaUtils.callOllama).mock.calls[1]?.[1] as string;
        expect(turn3Prompt).toContain('yes go ahead');
      }
    );
  }, 15000);
});
