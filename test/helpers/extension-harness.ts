// Shared set-up for tests that boot the extension with a mocked Pi
// ExtensionContext (hygiene Phase 4, docs/plans/2026-10-29-repo-hygiene.md).
//
// Before this helper, 15 test files repeated the same eleven lines: a handler
// map, an object with four `vi.fn()` registrars, a `setModel` stub and an
// `on` implementation that records handlers. The shape is Pi's, not ours, so
// it lives here once.

import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';

export type EventHandlers = Record<string, (ev: any, ctx: any) => any>;

export interface ExtensionContextHarness {
  /** The mocked ExtensionContext handed to the extension's default export. */
  ctx: any;
  /** The handlers the extension registered, keyed by event name. */
  onHandlers: EventHandlers;
}

/**
 * A mocked ExtensionContext with the registrars every router test needs.
 * No caller varies the shape today (all 15 pass nothing); a test that needs
 * `modelRegistry`, `cwd` or `ui` re-declares just that field on `ctx` — the
 * point of the helper is the registrar block, not a config surface.
 */
export function makeExtensionContext(): ExtensionContextHarness {
  const onHandlers: EventHandlers = {};
  const ctx: any = {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerProvider: vi.fn(),
    setModel: vi.fn(async () => true),
    on: vi.fn((event: string, handler: (ev: any, ctx: any) => any) => {
      onHandlers[event] = handler;
    }),
  };
  return { ctx, onHandlers };
}

/**
 * Park the router's state files for the duration of a test and put them back
 * afterwards. Returns the restore function; call it in a `finally`. What
 * parking protects is state an EARLIER test in the same file wrote —
 * test/setup/isolate-home.ts gives every test file its own state directory,
 * so no developer's live session state is at risk. A file that fails to park
 * or restore (read-only, concurrently removed) is skipped, not fatal: the
 * test still runs, at worst against the previous state.
 *
 * The 12-file duplicate this replaces parked `router-config.dynamic.json`
 * and the scan cache by hand, with three lines each, and restored them in a
 * `finally` — the same idiom, spelled slightly differently every time.
 */
export function parkStateFiles(paths: (string | undefined | null)[]): () => void {
  const suffix = '.test-park';
  const parked: [string, string][] = [];
  for (const p of paths) {
    if (!p) continue;
    try {
      // existsSync + rename: a missing file is not an error, and a test that
      // never created it must not fail on restore.
      if (existsSync(p)) {
        const bak = `${p}${suffix}`;
        renameSync(p, bak);
        parked.push([bak, p]);
      }
    } catch {
      // A read-only or concurrently removed file: skip it, the test still runs.
    }
  }
  return () => {
    for (const [bak, original] of parked) {
      try {
        renameSync(bak, original);
      } catch {
        // Best effort: the test already asserted what it needed.
      }
    }
  };
}

/**
 * The router's two state-file paths, derived from PI_ROUTER_STATE_DIR. 21
 * files spelled the same two `path.join(...)` lines out; the names are part of
 * the state layout, so they live here.
 */
export function routerStatePaths(): { dynamicConfigPath: string; scanCachePath: string } {
  const stateDir = process.env.PI_ROUTER_STATE_DIR!;
  return {
    dynamicConfigPath: join(stateDir, 'router-config.dynamic.json'),
    scanCachePath: join(stateDir, '.cache', 'scan-cache.json'),
  };
}

/** Collect every event of a stream into an array (11 files repeated this). */
export async function drainStream<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}
