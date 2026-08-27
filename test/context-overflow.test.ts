/**
 * Regression test: when a conversation grew under a large-context model
 * (e.g. Gemini 2.5 Pro @ 1M tokens) and the user switches to a Dynamic
 * group, every candidate's context window is smaller than the accumulated
 * conversation. driveStream skips all of them BEFORE any request reaches a
 * provider — so no provider ever returns an overflow error, so Pi's native
 * compaction never fires, so the conversation never shrinks, so the session
 * freezes in an infinite skip loop on every turn.
 *
 * Fix: when ALL candidates fail ONLY because of context-window size, emit a
 * native-style overflow error (matching the Anthropic "prompt is too long"
 * pattern that @earendil-works/pi-ai/utils/overflow recognises). Pi detects
 * it and runs its own compaction with an appropriate model.
 *
 * The overflow short-circuit only fires once the fallback-group cascade is
 * exhausted: groups are filtered by min_gdpval/cost tier, not by context
 * window, so a lower-priority fallback group can legitimately contain a
 * model with more room than the current group's candidates.
 *
 * This test sets up a group whose only candidate has a small context window,
 * feeds it a conversation larger than that window, and asserts:
 *   1. The emitted error message contains the overflow pattern
 *      ("prompt is too long").
 *   2. The emitted AssistantMessage carries stopReason "error" + errorMessage
 *      (the fields Pi's isContextOverflow() inspects).
 *   3. No fallback cascade was walked (none is configured in this test).
 *
 * A third test (below) verifies the cascade actually gets first refusal when
 * one IS configured and contains a model with enough context.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireRouterStateLock, releaseRouterStateLock, writeNoOpScanCache, removeNoOpScanCache, flushBackgroundScan } from './helpers/router-state-lock.ts';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dynamicConfigPath = path.join(repoRoot, 'router-config.dynamic.json');
const dynamicConfigBackupPath = `${dynamicConfigPath}.overflow-test-bak`;
const scanCachePath = path.join(repoRoot, '.cache', 'scan-cache.json');

async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

describe('driveStream: context overflow triggers native compaction signal', () => {
  it('emits a native-style overflow error when all candidates skip on context window', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-overflow-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.pi', 'router-config.json'),
      JSON.stringify({
        free_models: [],
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
      })
    );
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    // Held until the finally block restores router-config.dynamic.json — see
    // router-state-lock.ts for why this must span the whole test.
    await acquireRouterStateLock();
    if (fs.existsSync(dynamicConfigPath)) fs.renameSync(dynamicConfigPath, dynamicConfigBackupPath);

    writeNoOpScanCache(scanCachePath); // make unawaited session_start scan() a no-op (root cause of the "No available models" CI flake)
    try {
      vi.resetModules();
      const mod = await import('../index.ts');
      const defaultExport = mod.default as any;

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

      // One candidate with a small context window (8K). The conversation
      // below is ~30K tokens — well over 8K, so driveStream's context-window
      // guard skips it immediately.
      const smallCtxModel = {
        provider: 'small-ctx-provider',
        id: 'claude-sonnet-4-6',
        api: 'small-api',
        contextWindow: 8_000,
      };
      const modelRegistry = {
        getAvailable: () => [smallCtxModel],
        find: () => smallCtxModel,
        getApiKeyForProvider: async () => null,
        runtime: { streamSimple: () => (async function* () {})() },
      };
      const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
      await onHandlers['session_start']?.({}, ctx);
      await flushBackgroundScan();

      // Build a ~30K-token conversation (120K chars / 4).
      const bigMessage = 'x '.repeat(60_000);
      const groupModel = { provider: 'standard', id: 'standard' };
      const context: any = {
        messages: [{ role: 'user', content: bigMessage }],
      };

      const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

      // Find the terminal error event.
      const errEvent = events.find((e: any) => e.type === 'error') as any;
      expect(errEvent).toBeDefined();
      const error = errEvent.error;

      // Must carry the fields Pi's isContextOverflow() checks.
      expect(error.stopReason).toBe('error');
      expect(typeof error.errorMessage).toBe('string');
      // Must match the Anthropic overflow pattern.
      expect(error.errorMessage).toMatch(/prompt is too long/i);
      expect(error.errorMessage).toContain('30000');

      // Must NOT have walked the fallback cascade (no other groups configured
      // anyway, but the info line would appear if it tried).
      const allText = events
        .map((e: any) => (e.type === 'text_delta' ? e.delta ?? '' : ''))
        .join('');
      expect(allText).not.toMatch(/trying \w+/i);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      removeNoOpScanCache(scanCachePath);

      if (fs.existsSync(dynamicConfigBackupPath)) fs.renameSync(dynamicConfigBackupPath, dynamicConfigPath);
      releaseRouterStateLock();
    }
  });

  it('walks the normal fallback cascade when candidates fail for non-overflow reasons', async () => {
    // Sanity: the overflow short-circuit must NOT fire when candidates fail
    // for other reasons (e.g. "not registered"). Otherwise we'd hide real
    // errors behind a compaction trigger.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-no-overflow-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.pi', 'router-config.json'),
      JSON.stringify({
        free_models: [],
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
      })
    );
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    // Held until the finally block restores router-config.dynamic.json — see
    // router-state-lock.ts for why this must span the whole test.
    await acquireRouterStateLock();
    if (fs.existsSync(dynamicConfigPath)) fs.renameSync(dynamicConfigPath, dynamicConfigBackupPath);

    writeNoOpScanCache(scanCachePath); // make unawaited session_start scan() a no-op (root cause of the "No available models" CI flake)
    try {
      vi.resetModules();
      const mod = await import('../index.ts');
      const defaultExport = mod.default as any;

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

      // Candidate is "available" but find() returns null — tryStream skips
      // with "not registered", NOT a context-window skip.
      const phantomModel = {
        provider: 'phantom-provider',
        id: 'claude-sonnet-4-6',
        api: 'phantom-api',
        contextWindow: 1_000_000,
      };
      const modelRegistry = {
        getAvailable: () => [phantomModel],
        find: () => null,
        getApiKeyForProvider: async () => null,
        runtime: { streamSimple: () => (async function* () {})() },
      };
      const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
      await onHandlers['session_start']?.({}, ctx);
      await flushBackgroundScan();

      const groupModel = { provider: 'standard', id: 'standard' };
      const context: any = { messages: [{ role: 'user', content: 'hello' }] };

      const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));
      const errEvent = events.find((e: any) => e.type === 'error') as any;
      const error = errEvent.error;

      // Must be the normal "All N candidates failed" error, NOT the overflow
      // signal.
      expect(error.errorMessage).toBeUndefined();
      const text = Array.isArray(error.content)
        ? error.content.map((c: any) => c.text ?? '').join('')
        : '';
      expect(text).toContain('All');
      expect(text).toContain('failed');
      expect(text).not.toMatch(/prompt is too long/i);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      removeNoOpScanCache(scanCachePath);

      if (fs.existsSync(dynamicConfigBackupPath)) fs.renameSync(dynamicConfigBackupPath, dynamicConfigPath);
      releaseRouterStateLock();
    }
  });

  it('tries a configured fallback group BEFORE emitting the overflow signal, and succeeds if it has enough context', async () => {
    // Groups are filtered by min_gdpval/cost tier, not by context window, so
    // a lower-priority fallback group can legitimately contain a
    // large-context model that the current group's (small-context) candidate
    // list doesn't have. The overflow short-circuit must not preempt that —
    // it may only fire once the cascade itself is exhausted.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-overflow-cascade-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.pi', 'router-config.json'),
      JSON.stringify({
        free_models: [],
        model_groups: {
          standard: { fallback_groups: ['big'] },
          big: { fallback_groups: [] },
        },
      })
    );
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    // Held until the finally block restores router-config.dynamic.json — see
    // router-state-lock.ts for why this must span the whole test.
    await acquireRouterStateLock();
    if (fs.existsSync(dynamicConfigPath)) fs.renameSync(dynamicConfigPath, dynamicConfigBackupPath);

    writeNoOpScanCache(scanCachePath); // make unawaited session_start scan() a no-op (root cause of the "No available models" CI flake)
    try {
      vi.resetModules();
      const mod = await import('../index.ts');
      const defaultExport = mod.default as any;

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

      // 'standard' group's only candidate is too small for the conversation.
      // 'big' group's only candidate has plenty of room.
      const smallCtxModel = {
        provider: 'small-ctx-provider',
        id: 'small-model',
        api: 'small-api',
        contextWindow: 8_000,
      };
      const bigCtxModel = {
        provider: 'big-ctx-provider',
        id: 'big-model',
        api: 'big-api',
        contextWindow: 1_000_000,
      };
      const modelsByRef: Record<string, any> = {
        'small-ctx-provider/small-model': smallCtxModel,
        'big-ctx-provider/big-model': bigCtxModel,
      };
      const streamSimple = vi.fn((model: any) => {
        if (model.id === 'big-model') {
          return (async function* () {
            yield { type: 'text_delta', delta: 'served by the big-context fallback' };
            yield { type: 'done' };
          })();
        }
        return (async function* () {})();
      });
      const modelRegistry = {
        getAvailable: () => [smallCtxModel, bigCtxModel],
        find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
        getApiKeyForProvider: async () => null,
        runtime: { streamSimple },
      };
      const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
      await onHandlers['session_start']?.({}, ctx);
      await flushBackgroundScan();

      // ~30K-token conversation — over the small model's 8K window, well under
      // the big model's 1M window.
      const bigMessage = 'x '.repeat(60_000);
      const groupModel = { provider: 'standard', id: 'standard' };
      const context: any = { messages: [{ role: 'user', content: bigMessage }] };

      const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

      // Must NOT have emitted the synthetic overflow signal — the cascade
      // found a model with enough room.
      const errEvent = events.find((e: any) => e.type === 'error') as any;
      expect(errEvent).toBeUndefined();

      const text = events
        .filter((e: any) => e.type === 'text_delta')
        .map((e: any) => e.delta ?? '')
        .join('');
      expect(text).toContain('served by the big-context fallback');
      expect(streamSimple).toHaveBeenCalled();
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      removeNoOpScanCache(scanCachePath);

      if (fs.existsSync(dynamicConfigBackupPath)) fs.renameSync(dynamicConfigBackupPath, dynamicConfigPath);
      releaseRouterStateLock();
    }
  });
});
