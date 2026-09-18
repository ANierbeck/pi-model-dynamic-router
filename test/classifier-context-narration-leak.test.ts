// test/classifier-context-narration-leak.test.ts
//
// Regression test for the router-narration classifier lock-in bug
// (2026-09-18): pushRouterInfo/pushRouterInfoLogged (src/stream-driver.ts)
// prepend lines like "> [router] HINT: mistral/foo · mistral/foo\n\n" to the
// assistant's VISIBLE response before the model's real text. Those lines end
// up stored in context.messages as part of the assistant turn. On the next
// turn, extractLastAssistantSnippet() (index.ts) used to hand the classifier
// this raw router narration instead of the model's actual answer — and
// because the narration can itself contain the literal substring
// "HINT: <model>", the classifier's own HINT-detection instructions then
// misread the router's diagnostic output as a fresh user-issued HINT,
// routing back to whatever model was last narrated and creating a
// self-reinforcing lock-in loop. Observed in production: a session got
// stuck on openrouter/cohere/north-mini-code:free /
// openrouter/inclusionai/ling-3.0-flash-vl:free for many consecutive turns.
//
// Fix: extractLastAssistantSnippet() (index.ts) strips any line matching
// /^>\s*\[router\]/ before taking its 150-char snippet, so the classifier's
// "Last assistant response (excerpt)" context line only ever contains the
// model's real prior answer.

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
    JSON.stringify({ category: 'trivial', reason: 'test', confidence: 0.9 })
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-narration-leak-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const dynBak = `${dynamicConfigPath}.narration-leak-bak`;
  const cacheBak = `${scanCachePath}.narration-leak-bak`;
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

describe('classifier context: router narration must not leak into lastAssistantSnippet', () => {
  it('strips "> [router] ..." lines before building the classifier prompt', async () => {
    const ollamaUtils = await import('../src/ollama-utils.ts');

    await withIsolatedRouter(
      {
        free_models: [],
        providers: {},
        model_groups: {
          dynamic: { method: 'dynamic' },
          scout: { method: 'best', min_gdpval: 0, fallback_groups: [] },
        },
        gdpval_builtin: {
          'ollama/scout-model': 100,
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

        const scoutModel = {
          provider: 'ollama',
          id: 'scout-model',
          api: 'openai-completions',
          contextWindow: 100_000,
        };
        const modelsByRef: Record<string, any> = { 'ollama/scout-model': scoutModel };
        const streamSimple = vi.fn(() =>
          (async function* () {
            yield { type: 'text_delta', delta: 'scout model reply' };
            yield { type: 'done' };
          })()
        );
        const modelRegistry = {
          getAvailable: () => [scoutModel],
          find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
          getApiKeyForProvider: async () => null,
          runtime: { streamSimple },
        };
        const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        const groupModel = { provider: 'dynamic', id: 'dynamic' };

        // Simulates a prior turn where the router injected its own routing
        // narration ("> [router] HINT: ... · ...") ahead of the model's real
        // answer — exactly what pushRouterInfoLogged() produces in
        // driveStream() when `label` contains "HINT: <model>". A long
        // current prompt (so short-prompt momentum doesn't short-circuit
        // classification and the LLM classifier actually runs).
        const context: any = {
          messages: [
            { role: 'user', content: 'first question' },
            {
              role: 'assistant',
              content:
                '> [router] HINT: mistral/foo · mistral/foo\n\n' +
                'Here is the actual helpful answer from the model, describing the fix in detail.',
            },
            {
              role: 'user',
              content:
                'Please explain in depth how the caching layer interacts with the rate limiter ' +
                'and whether there are any edge cases we should worry about.',
            },
          ],
        };

        await drainStream(defaultExport.groupStream(groupModel, context, {}));

        expect(vi.mocked(ollamaUtils.callOllama)).toHaveBeenCalledTimes(1);
        const sentPrompt = vi.mocked(ollamaUtils.callOllama).mock.calls[0][1] as string;
        expect(sentPrompt).not.toContain('[router]');
        expect(sentPrompt).not.toContain('HINT: mistral/foo');
        expect(sentPrompt).toContain('Here is the actual helpful answer');
      }
    );
  }, 30000);
});
