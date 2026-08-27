/**
 * Regression test: reasoning models (those advertising a `reasoning`/
 * `thinking` capability) get a longer first-token timeout than instant chat
 * models. Without this, an overloaded reasoning provider (e.g. Mistral
 * serving glm-5-2) gets aborted mid-thought by the 30s empty-response
 * timeout, producing a false "empty response" and a soft-failure cooldown.
 * The router then re-picks the same model on the next turn (it's still the
 * best-ranked) and the timeout fires again — a silent infinite loop that
 * looks like "model never succeeds" even though the model was just slow.
 *
 * This test sets up one reasoning and one non-reasoning model, streams a
 * first token AFTER the short (non-reasoning) timeout would have fired but
 * BEFORE the long (reasoning) timeout, and asserts:
 *   1. The reasoning model's stream completes successfully (not aborted).
 *   2. The non-reasoning model's stream, given the same delay, would be
 *      aborted (sanity — proves the shorter timeout still applies).
 *
 * To keep the test fast, both timeouts are scaled down via a tiny config
 * override (empty_response_timeout_ms: 100, reasoning_*: 5000). The delay
 * of 500ms is > 100ms (short timeout fires) but < 5000ms (long doesn't).
 */
import { describe, it, expect, vi } from 'vitest';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireRouterStateLock, releaseRouterStateLock } from './helpers/router-state-lock.ts';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dynamicConfigPath = path.join(repoRoot, 'router-config.dynamic.json');
const scanCachePath = path.join(repoRoot, '.cache', 'scan-cache.json');

async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

function textDeltaText(events: AssistantMessageEvent[]): string {
  return events
    .filter((e: any) => e.type === 'text_delta')
    .map((e: any) => e.delta ?? '')
    .join('');
}

describe('driveStream: reasoning models get a longer first-token timeout', () => {
  it('a reasoning model emitting its first token after the short timeout still succeeds', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-reasoning-timeout-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.pi', 'router-config.json'),
      JSON.stringify({
        free_models: [],
        providers: { openrouter: { free_models: [] } },
        // Scale timeouts down so the test is fast. Short = 100ms, long = 5000ms.
        empty_response_timeout_ms: 100,
        reasoning_empty_response_timeout_ms: 5000,
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
      })
    );
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    const dynBak = `${dynamicConfigPath}.reasoning-bak`;
    const cacheBak = `${scanCachePath}.reasoning-bak`;
    // Held until the finally block restores both shared files — see
    // router-state-lock.ts for why this must span the whole test.
    await acquireRouterStateLock();
    const hadDyn = fs.existsSync(dynamicConfigPath);
    const hadCache = fs.existsSync(scanCachePath);
    if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
    if (hadCache) fs.renameSync(scanCachePath, cacheBak);

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

      // A reasoning model. It waits 500ms before emitting its first token —
      // longer than the short (100ms) timeout, shorter than the long (5000ms)
      // one. If the wrong timeout is used, this stream is aborted as an
      // "empty response" and the test fails.
      const reasoningModel = {
        provider: 'mistral-zai',
        id: 'glm-5-2',
        api: 'openai-completions',
        contextWindow: 1_000_000,
        reasoning: true, // pi-ai's Model.reasoning is a boolean, not a ThinkingLevel string
      };
      const streamSimple = vi.fn((model: any) => {
        return (async function* () {
          await new Promise((r) => setTimeout(r, 500));
          yield { type: 'text_delta', delta: `thought for a while, then answered` };
          yield { type: 'done' };
        })();
      });
      const modelRegistry = {
        getAvailable: () => [reasoningModel],
        find: () => reasoningModel,
        getApiKeyForProvider: async () => 'fake-key',
        runtime: { streamSimple },
      };
      const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
      await onHandlers['session_start']?.({}, ctx);

      const events = await drainStream(
        defaultExport.groupStream(
          { provider: 'standard', id: 'standard' },
          { messages: [{ role: 'user', content: 'think hard' }] },
          {}
        )
      );

      // The reasoning model must NOT have been aborted by the short timeout.
      expect(textDeltaText(events)).toContain('thought for a while, then answered');
      expect(streamSimple).toHaveBeenCalledTimes(1);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
      if (hadCache) fs.renameSync(cacheBak, scanCachePath);
    }
  });

  it('a non-reasoning model emitting its first token after the short timeout is aborted', async () => {
    // Sanity: the short timeout must still apply to non-reasoning models.
    // Otherwise we've just made every model wait forever.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-non-reasoning-timeout-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.pi', 'router-config.json'),
      JSON.stringify({
        free_models: [],
        providers: { openrouter: { free_models: [] } },
        empty_response_timeout_ms: 100,
        reasoning_empty_response_timeout_ms: 5000,
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
      })
    );
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    const dynBak = `${dynamicConfigPath}.non-reasoning-bak`;
    const cacheBak = `${scanCachePath}.non-reasoning-bak`;
    // Held until the finally block restores both shared files — see
    // router-state-lock.ts for why this must span the whole test. (This test
    // was missing the acquire despite calling releaseRouterStateLock() in its
    // finally block — the move-aside/restore below raced unprotected against
    // every other test file that touches the same two shared paths.)
    await acquireRouterStateLock();
    const hadDyn = fs.existsSync(dynamicConfigPath);
    const hadCache = fs.existsSync(scanCachePath);
    if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
    if (hadCache) fs.renameSync(scanCachePath, cacheBak);

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

      // A NON-reasoning model (no `reasoning`/`thinking` field). Same 500ms
      // delay before first token. The short (100ms) timeout must fire and
      // abort this stream as an empty response.
      const chatModel = {
        provider: 'mistral',
        id: 'mistral-small-latest',
        api: 'openai-completions',
        contextWindow: 1_000_000,
      };
      const streamSimple = vi.fn((model: any) => {
        return (async function* () {
          await new Promise((r) => setTimeout(r, 500));
          yield { type: 'text_delta', delta: `should never reach here` };
          yield { type: 'done' };
        })();
      });
      const modelRegistry = {
        getAvailable: () => [chatModel],
        find: () => chatModel,
        getApiKeyForProvider: async () => 'fake-key',
        runtime: { streamSimple },
      };
      const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
      await onHandlers['session_start']?.({}, ctx);

      const events = await drainStream(
        defaultExport.groupStream(
          { provider: 'standard', id: 'standard' },
          { messages: [{ role: 'user', content: 'hi' }] },
          {}
        )
      );

      // The non-reasoning model's late first token must have been detected as
      // a soft failure (empty_timeout). consumeWithDetection doesn't hard-abort
      // the stream (iterPromise keeps running in the background), so a late
      // token CAN leak into the proxy — but the overall stream must end in an
      // error event, not a clean completion, because driveStream records a
      // soft failure and has no other candidate to fall back to (single-candidate
      // group, no fallback). So: assert an error event was emitted.
      const hasError = events.some((e: any) => e.type === 'error');
      expect(hasError).toBe(true);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
      if (hadCache) fs.renameSync(cacheBak, scanCachePath);
      releaseRouterStateLock();
    }
  });
});
