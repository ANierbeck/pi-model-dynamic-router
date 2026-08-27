/**
 * Regression test: a candidate that tryStream() skips (returns null instead
 * of throwing — e.g. "not registered in Pi's model registry", "no API key")
 * must still count as a failure.
 *
 * Bug: driveStream's `if (!target) { ...; continue; }` branch recorded the
 * skip reason for the error message but never called recordSoftFailure().
 * A structurally-broken candidate (never becomes usable mid-session) was
 * therefore retried from scratch on every single request forever — no
 * cooldown, no model-health malus. In one long-running session this produced
 * over a million identical "not registered" log lines in ~17h.
 *
 * This test reproduces the skip path (registry lists the model but find()
 * can't resolve it — the same inconsistency real free-tier models hit when
 * their provider has no active key) and asserts the second attempt is
 * short-circuited by the cooldown recorded on the first.
 *
 * A project-local override config (free_models: [], standard.fallback_groups:
 * []) isolates the group to exactly one candidate, so the assertion doesn't
 * depend on the router's real free-model list or fallback cascade depth.
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
const dynamicConfigBackupPath = `${dynamicConfigPath}.skip-malus-test-bak`;
const scanCachePath = path.join(repoRoot, '.cache', 'scan-cache.json');

async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

// Collects every bit of text the router pushed to the stream — the final
// error event's content, plus any "> [router] ..." info lines pushed along
// the way — so assertions aren't limited to whichever group ends the cascade.
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

describe('driveStream: skipped (not-thrown) candidates accrue a malus', () => {
  it('a second attempt on a structurally-unusable candidate is short-circuited by cooldown', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-skip-malus-'));
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

      // Listed as "available" (so it becomes a candidate) but unresolvable via
      // find() — the exact inconsistency tryStream's "not registered" guard
      // exists for.
      const phantomModel = { provider: 'phantom-provider', id: 'claude-sonnet-4-6', api: 'phantom-api' };
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

      const events1 = await drainStream(defaultExport.groupStream(groupModel, context, {}));
      const text1 = allText(events1);
      expect(text1).toContain('not registered in Pi');

      // A second, independent turn. Without the fix, tryStream is re-entered
      // for the phantom ref every time — "not registered" would appear again
      // here too, forever. With the fix, the cooldown recorded on attempt 1
      // short-circuits attempt 2 via isLimited() before tryStream ever runs.
      // (A cooldown-skip deliberately does not call recordSoftFailure again —
      // that would double-count the same underlying failure — so the streak
      // itself stays at 1; the cooldown persisting is the actual proof here.)
      const events2 = await drainStream(defaultExport.groupStream(groupModel, context, {}));
      const text2 = allText(events2);
      expect(text2).toContain('still in cooldown');
      expect(text2).not.toContain('not registered in Pi');
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      removeNoOpScanCache(scanCachePath);

      if (fs.existsSync(dynamicConfigBackupPath)) fs.renameSync(dynamicConfigBackupPath, dynamicConfigPath);
      releaseRouterStateLock();
    }
  });
});
