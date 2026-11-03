// Shared set-up for tests that boot the extension with a mocked Pi
// ExtensionContext (hygiene Phase 4, docs/plans/2026-10-29-repo-hygiene.md).
//
// Before this helper, 17 test files repeated the same eleven lines: a handler
// map, an object with four `vi.fn()` registrars, a `setModel` stub and an
// `on` implementation that records handlers. The shape is Pi's, not ours, so
// it lives here once. Everything a test needs to vary is an override.

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
 * `overrides` replaces or extends any field — pass `modelRegistry`, `cwd`,
 * `ui`, extra stubs, or a different `on` implementation.
 */
export function makeExtensionContext(overrides: Record<string, any> = {}): ExtensionContextHarness {
  const onHandlers: EventHandlers = {};
  const ctx: any = {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerProvider: vi.fn(),
    setModel: vi.fn(async () => true),
    on: vi.fn((event: string, handler: (ev: any, ctx: any) => any) => {
      onHandlers[event] = handler;
    }),
    ...overrides,
  };
  return { ctx, onHandlers };
}

/**
 * Park the router's real state files (a developer's live session state) for
 * the duration of a test and put them back afterwards. Returns the restore
 * function; call it in a `finally`.
 *
 * The 14-file duplicate this replaces parked `router-config.dynamic.json` and
 * the scan cache by hand, with three lines each, and restored them in a
 * `finally` — the same idiom, spelled slightly differently every time.
 */
export function parkStateFiles(paths: (string | undefined | null)[], suffix = '.test-park'): () => void {
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
 * The router's two state-file paths, derived from PI_ROUTER_STATE_DIR. Nine
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

/** Collect every event of a stream into an array (9 files repeated this). */
export async function drainStream<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}
