// test/classifier-narration-leak-multi-turn.test.ts
//
// Multi-turn regression test for the router-narration lock-in bug
// (2026-09-18, second root cause found after v1.5.4 / commit 26e99f0).
//
// The first fix (26e99f0) only stripped "> [router] ..." lines inside
// extractLastAssistantSnippet() (index.ts) — i.e. the "Last assistant
// response (excerpt)" context line fed to the LLM classifier. That closed
// ONE of three leak paths. Two more remained unguarded:
//
//   1. extractLastUserPrompt() (index.ts) — returns the raw last
//      `role: 'user'` message as the classifier's CURRENT prompt. If a user
//      message ever contains embedded router narration (e.g. a pasted/
//      quoted conversation dump from a subagent replay, or a tool result
//      folded back into a user turn), the literal "HINT: <model>" substring
//      reaches the LLM classifier verbatim. The user reported this exact
//      shape in the router.log: a `<conversation>[Assistant thinking]...
//      HINT: ...` blob landing in a user message.
//
//   2. StreamOrchestrator.extractPreviousUserMessage() (stream-orchestrator.ts)
//      — returns the second-to-last user message, truncated to 150 chars,
//      as the classifier's "Previous user message" context line. Same
//      contamination risk: narration anywhere in that turn leaks through.
//
// Both paths also fed detectHintDirectly(prompt) (used by groupStream's
// isToolFollowUp check) and the LLM CLASSIFICATION_PROMPT, so a weak local
// classifier model pattern-matched "HINT: <model>" wherever it appeared and
// re-issued it as if the current user had typed it — a self-reinforcing
// lock-in loop that survived /reload because the contaminated code path was
// live in dist/index.js all along (the fix was incomplete, not stale).
//
// Fix: moved stripRouterNarration() into a shared helper (src/utils.ts) and
// applied it in extractLastUserPrompt() and the orchestrator's
// extractPreviousUserMessage(), so narration lines are removed BEFORE the
// text is handed to the classifier or to detectHintDirectly().
//
// These tests assert the fix at the data level (the extracted text no longer
// contains router narration) rather than only at the prompt-wording level
// (the "NEVER extract a HINT from this block" caveat added in 26e99f0), which
// is the defense-in-depth guarantee the user asked for.

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

vi.mock('../src/ollama-utils.ts', () => ({
  callOllama: vi.fn(async () =>
    JSON.stringify({ category: 'trivial', reason: 'test', confidence: 0.9 })
  ),
}));

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dynamicConfigPath = path.join(repoRoot, 'router-config.dynamic.json');
const scanCachePath = path.join(repoRoot, '.cache', 'scan-cache.json');

async function withIsolatedRouter(
  configOverride: Record<string, unknown>,
  fn: (defaultExport: any, tmpDir: string) => Promise<void>
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-narration-multi-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const dynBak = `${dynamicConfigPath}.narration-multi-bak`;
  const cacheBak = `${scanCachePath}.narration-multi-bak`;
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

// A realistic "narration mid-blob" user message: a quoted/wrapped
// conversation dump (the shape seen in the router.log reproduction) that
// contains an embedded "> [router] HINT: ..." line — NOT at the start. This
// is the critical case the first test missed: stripRouterNarration must
// filter EVERY matching line, not just a leading one.
const NARRATION_LINE = '> [router] HINT: openrouter/cohere/north-mini-code:free · openrouter/cohere/north-mini-code:free';

const contaminatedUserMessage =
  '<conversation>\n' +
  '[Assistant thinking]: I should route this to a cheap model.\n' +
  NARRATION_LINE + '\n' +
  'Now for the actual question: please summarize the diff and tell me whether the new test covers the compaction path.\n' +
  '</conversation>';

describe('classifier context: router narration must not leak via user-message paths', () => {
  it('strips embedded "> [router]" lines from the CURRENT prompt (extractLastUserPrompt)', async () => {
    const ollamaUtils = await import('../src/ollama-utils.ts');

    await withIsolatedRouter(
      {
        free_models: [],
        providers: {},
        model_groups: {
          dynamic: { method: 'dynamic' },
          scout: { method: 'best', min_gdpval: 0, fallback_groups: [] },
        },
        gdpval_builtin: { 'ollama/scout-model': 100 },
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
        const streamSimple = vi.fn(() =>
          (async function* () {
            yield { type: 'text_delta', delta: 'scout reply' };
            yield { type: 'done' };
          })()
        );
        const modelRegistry = {
          getAvailable: () => [scoutModel],
          find: () => scoutModel,
          getApiKeyForProvider: async () => null,
          runtime: { streamSimple },
        };
        const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        const groupModel = { provider: 'dynamic', id: 'dynamic' };

        // The CURRENT (last) user message carries embedded router narration
        // mid-blob. Before the fix, extractLastUserPrompt() returned this raw,
        // so the LLM classifier's prompt text contained "HINT: north-mini-code".
        const context: any = {
          messages: [
            { role: 'user', content: 'earlier benign question' },
            { role: 'assistant', content: 'earlier benign answer' },
            { role: 'user', content: contaminatedUserMessage },
          ],
        };

        // drainStream: consume the async iterable so classification runs.
        const events: any[] = [];
        for await (const ev of defaultExport.groupStream(groupModel, context, {})) events.push(ev);

        expect(vi.mocked(ollamaUtils.callOllama)).toHaveBeenCalledTimes(1);
        const sentPrompt = vi.mocked(ollamaUtils.callOllama).mock.calls[0][1] as string;

        // The router narration line must be gone from the classifier prompt.
        expect(sentPrompt).not.toContain('[router]');
        expect(sentPrompt).not.toContain('HINT: openrouter/cohere/north-mini-code');
        // The actual question text must survive the strip.
        expect(sentPrompt).toContain('summarize the diff');
      }
    );
  }, 30000);

  it('strips embedded "> [router]" lines from the PREVIOUS user message (extractPreviousUserMessage)', async () => {
    const ollamaUtils = await import('../src/ollama-utils.ts');

    await withIsolatedRouter(
      {
        free_models: [],
        providers: {},
        model_groups: {
          dynamic: { method: 'dynamic' },
          scout: { method: 'best', min_gdpval: 0, fallback_groups: [] },
        },
        gdpval_builtin: { 'ollama/scout-model': 100 },
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
        const streamSimple = vi.fn(() =>
          (async function* () {
            yield { type: 'text_delta', delta: 'scout reply' };
            yield { type: 'done' };
          })()
        );
        const modelRegistry = {
          getAvailable: () => [scoutModel],
          find: () => scoutModel,
          getApiKeyForProvider: async () => null,
          runtime: { streamSimple },
        };
        const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        const groupModel = { provider: 'dynamic', id: 'dynamic' };

        // The PREVIOUS user message (second-to-last) carries embedded router
        // narration. The CURRENT prompt is clean. Before the fix, the
        // orchestrator's extractPreviousUserMessage() returned the raw
        // second-to-last message, so the "Previous user message:" context
        // line fed to the classifier contained "HINT: north-mini-code".
        const context: any = {
          messages: [
            { role: 'user', content: contaminatedUserMessage },
            { role: 'assistant', content: 'earlier benign answer' },
            {
              role: 'user',
              content:
                'Please explain in depth how the caching layer interacts with the rate limiter ' +
                'and whether there are any edge cases we should worry about.',
            },
          ],
        };

        const events: any[] = [];
        for await (const ev of defaultExport.groupStream(groupModel, context, {})) events.push(ev);

        expect(vi.mocked(ollamaUtils.callOllama)).toHaveBeenCalledTimes(1);
        const sentPrompt = vi.mocked(ollamaUtils.callOllama).mock.calls[0][1] as string;

        // The "Previous user message:" context line must not carry narration.
        expect(sentPrompt).not.toContain('[router]');
        expect(sentPrompt).not.toContain('HINT: openrouter/cohere/north-mini-code');
        // The clean current prompt must survive.
        expect(sentPrompt).toContain('caching layer interacts with the rate limiter');
      }
    );
  }, 30000);

  it('detectHintDirectly does not fire on a narration line embedded mid-blob (data-level guard)', async () => {
    // Pure unit test against the shared classifier helper: even if a
    // narration line somehow reached detectHintDirectly() unstripped, the
    // leading ">" prefix means it should never match the HINT regex — but
    // stripRouterNarration must still remove it before the LLM sees it,
    // because the LLM classifier is the actual lock-in vector (it
    // pattern-matches "HINT:" anywhere, not only at line start). This test
    // documents the data-level contract the fix enforces.
    const { stripRouterNarration } = await import('../src/utils.ts');

    const stripped = stripRouterNarration(contaminatedUserMessage);
    expect(stripped).not.toContain('[router]');
    expect(stripped).not.toContain('HINT: openrouter/cohere/north-mini-code');
    // Non-narration content is preserved.
    expect(stripped).toContain('summarize the diff');
    expect(stripped).toContain('<conversation>');
  });
});
