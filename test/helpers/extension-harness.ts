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
import { flushBackgroundScan } from './noop-scan-cache.ts';

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

export interface SessionCtxOptions {
  /** The model registry the session ctx hands to session_start. */

  modelRegistry: any;
  /** Working directory the session ctx reports. */
  cwd: string;
}

/**
 * The session_start ctx several files spelled out identically:
 * `{ modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } }`. The ui footer
 * is a fresh vi.fn() per call — a test that wants to assert on it declares
 * its own ui and passes it via overrides.
 */

export function makeSessionCtx(options: SessionCtxOptions & { ui?: any }): any {
  return {
    modelRegistry: options.modelRegistry,
    cwd: options.cwd,
    ui: options.ui ?? { setFooter: vi.fn() },
  };
}

/**
 * The per-test ExtensionContext with an observable registerProvider: the
 * default makeExtensionContext's registerProvider is a plain vi.fn(); tests
 * that assert on registration calls (or hook behavior into the registry) use
 * this variant and read registerProviderCalls.
 */
export interface ObservableExtensionContext extends ExtensionContextHarness {
  /** Every registerProvider call, as { name, opts }. */

  registerProviderCalls: { name: string; opts: any }[];
}

export function makeObservableExtensionContext(): ObservableExtensionContext {
  const onHandlers: EventHandlers = {};

  const registerProviderCalls: { name: string; opts: any }[] = [];

  const ctx: any = {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerProvider: vi.fn((name: string, opts: any) => {
      registerProviderCalls.push({ name, opts });
    }),
    setModel: vi.fn(async () => true),
    on: vi.fn((event: string, handler: (ev: any, ctx: any) => any) => {
      onHandlers[event] = handler;
    }),
  };
  return { ctx, onHandlers, registerProviderCalls };
}

/**
 * Park the router's state files for the duration of a test and put them back
 * afterwards. Returns the restore function; call it in a `finally`. What
 * parking protects is state an EARLIER test in the same file wrote —
 * test/setup/isolate-home.ts gives every test file its own state directory,
 * so no developer's live session state is at risk. A file that cannot be
 * PARKED throws (after putting back what was already parked): running on
 * would test against the previous test's state. A failing RESTORE is
 * best-effort and warns — the test has already asserted what it needed.
 *
 * The 12-file duplicate this replaces parked `router-config.dynamic.json`
 * and the scan cache by hand, with three lines each, and restored them in a
 * `finally` — the same idiom, spelled slightly differently every time.
 */
export function parkStateFiles(paths: (string | undefined | null)[]): () => void {
  const suffix = '.test-park';
  const parked: [string, string][] = [];
  const restore = (): void => {
    for (const [bak, original] of parked) {
      try {
        renameSync(bak, original);
      } catch (err) {
        // Best effort — the test already asserted what it needed, and throwing
        // from a `finally` would mask its real failure — but not silent: a
        // state file left behind as `.test-park` would otherwise be a mystery.
        console.warn(
          `parkStateFiles: cannot restore ${original} from ${bak}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  };
  for (const p of paths) {
    if (!p) continue;
    // existsSync + rename: a missing file is not an error, and a test that
    // never created it must not fail on restore.
    if (!existsSync(p)) continue;
    const bak = `${p}${suffix}`;
    try {
      renameSync(p, bak);
    } catch (err) {
      // A file that cannot be parked would leave the test running against the
      // previous test's state and passing for the wrong reason: put back what
      // was already parked and fail loudly.
      restore();
      throw new Error(
        `parkStateFiles: cannot park ${p}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
    parked.push([bak, p]);
  }
  return restore;
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

export interface PiCtxOverrides {
  /** Replaces the default plain vi.fn() registerCommand (which records into a map). */

  registerCommand?: any;
  /** Replaces the default plain vi.fn() registerProvider. */

  registerProvider?: any;
  /** Replaces the default plain vi.fn() registerTool. */

  registerTool?: any;
  /** Replaces the default setModel stub. */

  setModel?: any;
  /**
   * Handler storage: 'single' (default) keeps the LAST handler per event
   * (`onHandlers[event] = handler`); 'array' keeps EVERY handler
   * (`(onHandlers[event] ??= []).push(handler)`) for multi-handler events.
   */
  handlers?: 'single' | 'array';
}

/**
 * A per-test ExtensionContext in the most common inline shape (the pi object
 * built by hand in ~16 files): the four registrars + setModel + an `on` that
 * records into onHandlers. Variants (registerProvider hooks, multi-handler
 * events) go through `overrides`.
 */
export function makePiCtx(overrides: PiCtxOverrides = {}): {
  pi: any;
  onHandlers: Record<string, any>;
} {
  const { handlers = 'single' } = overrides;

  const onHandlers: Record<string, any> = {};

  const pi: any = {
    registerTool: overrides.registerTool ?? vi.fn(),
    registerCommand: overrides.registerCommand ?? vi.fn(),
    registerProvider: overrides.registerProvider ?? vi.fn(),
    setModel: overrides.setModel ?? vi.fn(async () => true),
    on: vi.fn((event: string, handler: (ev: any, ctx: any) => any) => {
      if (handlers === 'array') {
        (onHandlers[event] ??= []).push(handler);
      } else {
        onHandlers[event] = handler;
      }
    }),
  };
  return { pi, onHandlers };
}

/**
 * Fire session_start with the standard session ctx and flush the background
 * scan — the three lines ~13 files spelled out after building their ctx.
 */
export async function startSession(
  onHandlers: EventHandlers,
  options: SessionCtxOptions
): Promise<any> {
  const ctx: any = makeSessionCtx(options);
  await onHandlers['session_start']?.({}, ctx);
  await flushBackgroundScan();
  return ctx;
}
