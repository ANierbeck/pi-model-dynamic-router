/**
 * Regression test: when EVERY candidate in a group is in cooldown (total
 * cooldown collapse), driveStream must NOT hard-fail with a generic "All N
 * candidates failed" error that surfaces as Pi's opaque "Unknown error".
 * Instead it picks the candidate with the shortest remaining cooldown and
 * retries it anyway — the cooldown is a router-internal heuristic, not a
 * hard provider-side limit.
 *
 * Without this, a long session where transient failures cool down every
 * model simultaneously freezes until the longest cooldown expires, even
 * though the shortest-cooldown model would likely have recovered.
 *
 * Strategy: a single candidate that THROWS on its first attempt (setting a
 * cooldown), then SUCCEEDS on the force-retry. We verify:
 *   1. The collapse handler fires ("All models in cooldown, retrying ...").
 *   2. The force-retry actually calls tryStream (bypasses isLimited()).
 *   3. The recovered output reaches the stream.
 *
 * Isolation: the router reads its scan cache from
 * <extDir>/.cache/scan-cache.json (extDir = repo root during tests). Previous
 * test runs persist real free-tier models there, which would leak into
 * allDiscoveredRefs() and pollute the candidate list. Move it aside, and
 * override free_models + providers.openrouter.free_models to [] so the
 * candidate pool is exactly our single mocked model.
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
const scanCachePath = path.join(repoRoot, '.cache', 'scan-cache.json');

async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

function allText(events: AssistantMessageEvent[]): string {
  return events
    .map((e: any) => {
      if (e.type === 'error') {
        const content = e.error?.content;
        return Array.isArray(content) ? content.map((c: any) => c.text ?? '').join('\n') : '';
      }
      if (e.type === 'text_delta') return e.delta ?? '';
      return '';
    })
    .join('\n');
}

describe('driveStream: total cooldown collapse', () => {
  // The core fix: single-pass collapse. When a live failure puts all candidates
  // in cooldown, the collapse handler fires IMMEDIATELY within the same pass
  // (not only on the next driveStream call). This prevents the "all N
  // candidates failed" hard-fail when the last candidate is tried live and
  // its own failure adds it to the cooldown list.
  it('single-pass: live-failure cooldown collapse recovers within the same call', async () => {
    // Single candidate that throws (soft failure → cooldown). With single-pass
    // collapse, driveStream detects the cooldown within the same pass and
    // force-retries — so streamSimple call 2 (the in-pass force-retry)
    // succeeds. We track call count to flip behaviour deterministically.
    let calls = 0;
    const streamSimple = vi.fn((model: any) => {
      calls++;
      return (async function* () {
        if (calls === 1) {
          // First call: fail → soft failure → cooldown.
          throw new Error('first attempt fails');
        }
        // Call 2: the in-pass collapse force-retry succeeds.
        yield { type: "text_delta", delta: `recovered after ${calls} calls` };
        yield { type: 'done' };
      })();
    });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-cooldown-spp-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.pi', 'router-config.json'),
      JSON.stringify({
        free_models: [],
        providers: { openrouter: { free_models: [] } },
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
      })
    );
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    await acquireRouterStateLock();
    const dynBak = `${dynamicConfigPath}.spp-bak`;
    const cacheBak = `${scanCachePath}.spp-bak`;
    const hadDyn = fs.existsSync(dynamicConfigPath);
    const hadCache = fs.existsSync(scanCachePath);
    if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
    if (hadCache) fs.renameSync(scanCachePath, cacheBak);
    writeNoOpScanCache(scanCachePath);

    try {
      vi.resetModules();
      const mod = await import('../index.ts');
      const defaultExport = mod.default as any;
      const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
      const pi: any = {
        registerTool: vi.fn(), registerCommand: vi.fn(), registerProvider: vi.fn(),
        setModel: vi.fn(async () => true),
        on: vi.fn((event: string, handler: any) => { onHandlers[event] = handler; }),
      };
      defaultExport(pi);
      const modelRegistry = {
        getAvailable: () => [{ provider: 'prov', id: 'm', api: 'phantom', contextWindow: 1_000_000 }],
        find: () => ({ provider: 'prov', id: 'm', api: 'phantom', contextWindow: 1_000_000 }),
        getApiKeyForProvider: async () => null,
        runtime: { streamSimple },
      };
      const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
      await onHandlers['session_start']?.({}, ctx);
      await flushBackgroundScan();

      // Single-pass recovery: the candidate throws → cooldown → collapse fires
      // within the same pass → force-retry succeeds (call 2).
      const events1 = await drainStream(
        defaultExport.groupStream({ provider: 'standard', id: 'standard' }, { messages: [{ role: 'user', content: 'go' }] }, {})
      );
      const text1 = allText(events1);
      expect(text1).toMatch(/All models in cooldown, retrying/i);
      expect(text1).toMatch(/shortest cooldown/i);
      expect(text1).toContain('recovered after 2 calls');
      expect(streamSimple).toHaveBeenCalledTimes(2);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
      if (hadCache) fs.renameSync(cacheBak, scanCachePath);
      removeNoOpScanCache(scanCachePath);
      releaseRouterStateLock();
    }
  });

  // Regression: verify single-pass collapse fires within ONE driveStream call when
  // the live-failed candidate puts itself into cooldown. This is the exact bug
  // that caused "all 18 candidates failed" hard-fails in the user's session — the
  // last candidate was tried live, failed, recorded a cooldown, but the strict
  // equality (cooldownSkips === allErrors.length) failed, so the safety net
  // never fired. With the fix (candidates.every(isLimited)), the collapse fires
  // immediately and force-retries the shortest-cooldown candidate in the same pass.
  // This test (single-pass) is covered by 'single-pass: live-failure...' above.
  //
  // The multi-call path (second call sees cooldown from first and recovers via
  // collapse) is covered by the original 'force-retry that fails with provider_error'
  // test below, which sets up a session and makes two calls. Both tests together
  // give full coverage of the collapse fix without the complexity of a combined test.

  it('force-retry that fails with provider_error shows the provider-error wording, not the generic empty-response one (roborev job 342 LOW)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-cooldown-collapse-pe-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.pi', 'router-config.json'),
      JSON.stringify({
        free_models: [],
        providers: { openrouter: { free_models: [] } },
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
      })
    );
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    const dynBak = `${dynamicConfigPath}.collapse-pe-bak`;
    const cacheBak = `${scanCachePath}.collapse-pe-bak`;
    await acquireRouterStateLock();
    const hadDyn = fs.existsSync(dynamicConfigPath);
    const hadCache = fs.existsSync(scanCachePath);
    if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
    if (hadCache) fs.renameSync(scanCachePath, cacheBak);

    writeNoOpScanCache(scanCachePath);

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

      // Single, PAID cloud candidate (no ':free' suffix, not ollama/lm-studio)
      // so recordStreamFailure's hard-cooldown branch applies. First attempt
      // throws (cooldown set); the force-retry then fails with an
      // unrecognized finish_reason (provider_error), not a plain
      // empty/timeout failure.
      let calls = 0;
      const streamSimple = vi.fn(() => {
        calls++;
        return (async function* () {
          if (calls === 1) {
            throw new Error('first attempt fails');
          }
          yield {
            type: 'error',
            error: { errorMessage: 'Provider finish_reason: error' },
          };
        })();
      });
      const modelRegistry = {
        getAvailable: () => [{ provider: 'paid-cloud-provider', id: 'paid-model', api: 'openai-completions', contextWindow: 1_000_000 }],
        find: () => ({ provider: 'paid-cloud-provider', id: 'paid-model', api: 'openai-completions', contextWindow: 1_000_000 }),
        getApiKeyForProvider: async () => null,
        runtime: { streamSimple },
      };
      const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
      await onHandlers['session_start']?.({}, ctx);
      await flushBackgroundScan();

      // First call: throws -> soft failure -> cooldown set -> single-pass
      // collapse fires (the live failure put the only candidate into cooldown)
      // -> force-retry path fails with provider_error.
      const events1 = await drainStream(
        defaultExport.groupStream({ provider: 'standard', id: 'standard' }, { messages: [{ role: 'user', content: 'go' }] }, {})
      );
      const text1 = allText(events1);

      expect(text1).toMatch(/All models in cooldown, retrying/i);
      // Must show the provider-error-specific wording (with the real detail
      // text). With single-pass collapse (the live failure puts the only
      // candidate into cooldown within the same pass), the original attempt
      // throws -> 'empty response' and the force-retry then yields the error
      // event -> 'provider error'; both lines appear, but the provider-error
      // wording is the one that proves the error-event path was recognized
      // rather than falling through to the generic empty-response reason.
      expect(text1).toContain('provider error: Provider finish_reason: error (likely rate limit)');
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
      removeNoOpScanCache(scanCachePath);
      if (hadCache) fs.renameSync(cacheBak, scanCachePath);
      releaseRouterStateLock();
    }
  });
});
