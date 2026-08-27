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
import { acquireRouterStateLock, releaseRouterStateLock, writeNoOpScanCache, removeNoOpScanCache } from './helpers/router-state-lock.ts';

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
  it('retries the shortest-cooldown candidate instead of hard-failing', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-cooldown-collapse-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.pi', 'router-config.json'),
      JSON.stringify({
        free_models: [],
        providers: { openrouter: { free_models: [] } },
        // Empty fallback_groups so the cascade doesn't pull in other groups'
        // candidate pools — keeps the test to a single candidate.
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
      })
    );
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    const dynBak = `${dynamicConfigPath}.collapse-bak`;
    const cacheBak = `${scanCachePath}.collapse-bak`;
    // Held until the finally block restores both shared files — see
    // router-state-lock.ts for why this must span the whole test.
    await acquireRouterStateLock();
    const hadDyn = fs.existsSync(dynamicConfigPath);
    const hadCache = fs.existsSync(scanCachePath);
    if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
    if (hadCache) fs.renameSync(scanCachePath, cacheBak);

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

      // Single candidate. First attempt throws (driveStream records a soft
      // failure → cooldown). Second attempt (the force-retry) yields real
      // output. We track call count to flip behaviour deterministically.
      let calls = 0;
      const streamSimple = vi.fn((model: any) => {
        calls++;
        return (async function* () {
          if (calls === 1) {
            // First call: fail. Puts the model into cooldown.
            throw new Error('first attempt fails');
          }
          // Second call (the collapse force-retry): succeed.
          yield { type: "text_delta", delta: `recovered after ${calls} calls` };
          yield { type: 'done' };
        })();
      });
      const modelRegistry = {
        getAvailable: () => [{ provider: 'prov', id: 'm', api: 'phantom', contextWindow: 1_000_000 }],
        find: () => ({ provider: 'prov', id: 'm', api: 'phantom', contextWindow: 1_000_000 }),
        getApiKeyForProvider: async () => null,
        runtime: { streamSimple },
      };
      const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
      await onHandlers['session_start']?.({}, ctx);

      // First call: the candidate throws → soft failure → cooldown set. This
      // call ends with an error event (all candidates failed).
      const events1 = await drainStream(
        defaultExport.groupStream({ provider: 'standard', id: 'standard' }, { messages: [{ role: 'user', content: 'go' }] }, {})
      );
      expect(allText(events1)).toMatch(/first attempt fails|All .* candidate/i);

      // Second call: the candidate is now in cooldown. Without the collapse
      // handler this would hard-fail ("All N candidates failed ... still in
      // cooldown"). With it, driveStream picks the (only) candidate, bypasses
      // isLimited(), and retries — which succeeds.
      const events2 = await drainStream(
        defaultExport.groupStream({ provider: 'standard', id: 'standard' }, { messages: [{ role: 'user', content: 'go' }] }, {})
      );
      
      
      const text2 = allText(events2);

      expect(text2).toMatch(/All models in cooldown, retrying/i);
      expect(text2).toMatch(/shortest cooldown/i);
      expect(text2).toContain('recovered after 2 calls');
      // The force-retry actually called streamSimple (proving the
      // isLimited() guard was bypassed — otherwise we'd see only the
      // generic cooldown error and no recovery).
      expect(streamSimple).toHaveBeenCalledTimes(2);
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
