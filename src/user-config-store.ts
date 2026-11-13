// src/user-config-store.ts
// The user layer's writer for `/router config` (plan 2026-10-06, D1/D2/D5).
//
// The command persists personal preferences ONLY into the global user file
// <agentDir>/router-config.user.json — never into the shipped
// router-config.json (an npm update overwrites it) and never the layered
// runtime config (final v1.6.0 review I1: persisting the layered state
// clobbers the other layers). Writes are therefore DELTAS applied to the
// user file's own parsed content.
//
// Also home of the read-only "origin view" (readConfigLayers): the three
// layer files read directly, so the display can say WHERE a rule comes from
// — the merged runtime config cannot (it is a union, ADR-0009).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { piAgentDir } from './config-loader.ts';
import type { ExcludeRules } from './types.ts';
import { isPlainObject, textOf } from './utils.ts';

const USER_CONFIG_FILE = 'router-config.user.json';

/** What a caller may change. Arrays are SET-replaced in the user file itself. */
export interface UserConfigDelta {
  exclude?: { models?: string[]; providers?: string[] };
  /** Cache-aware compaction (Phase 5b): only the master switch is
   * command-settable; the thresholds stay hand-edited config. */
  context_budget?: { enabled?: boolean };
  /** Per-integration switch (`/router config integration`): merged into the named block, other keys kept. */
  integrations?: Record<string, { enabled?: boolean; mode?: string }>;
}

export interface UserConfigStore {
  /** The user file as parsed. `config` is undefined when absent or unusable; `error` says why when unusable. */
  read(): { config: Record<string, unknown> | undefined; error?: string };
  applyDelta(delta: UserConfigDelta): { ok: true; written: string } | { ok: false; error: string };
}

// One or more `/`-separated segments of ref characters; `*` is the glob
// wildcard. Rejects empty input, whitespace, a leading or trailing `/` and
// `//`. A bare provider ("openrouter") is a plausible pattern too.
const PATTERN_RE = /^[A-Za-z0-9._*:-]+(\/[A-Za-z0-9._*:-]+)*$/;

/** Returns an error message for an implausible exclude pattern, or undefined when it is fine. */
export function validateExcludePattern(pattern: string): string | undefined {
  if (PATTERN_RE.test(pattern)) return undefined;
  return `"${pattern}" is not a model ref or glob (expected provider, provider/model or a * pattern, no spaces).`;
}

const PROVIDER_RE = /^[A-Za-z0-9._*:-]+$/;

/** Returns an error message for an implausible provider name (one segment, no slash), or undefined when it is fine. */
export function validateExcludeProvider(name: string): string | undefined {
  if (PROVIDER_RE.test(name)) return undefined;
  return `"${name}" is not a provider name (expected a single name without "/" or spaces).`;
}

function userConfigPath(agentDir: string): string {
  return path.join(agentDir, USER_CONFIG_FILE);
}

/**
 * Parse a JSON file that must hold an object. Missing file → config undefined
 * without an error; unreadable, unparseable or non-object → an error.
 */
function readObjectFile(file: string): {
  config: Record<string, unknown> | undefined;
  error?: string;
} {
  if (!fs.existsSync(file)) return { config: undefined };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { config: undefined, error: `${file} is not a JSON object` };
    }
    return { config: parsed as Record<string, unknown> };
  } catch (err) {
    return {
      config: undefined,
      error: `${file} is unreadable: ${err instanceof Error ? err.message : textOf(err)}`,
    };
  }
}

const LOCK_WAIT_MS = 1500;
const LOCK_STALE_MS = 10_000;

/**
 * Take the write lock: a lock file created exclusively. Waits briefly for a
 * live holder; a lock older than LOCK_STALE_MS belongs to a crashed writer
 * and is taken over. Returns false when the lock is still held after the wait.
 */
function acquireWriteLock(lock: string): boolean {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(lock, { force: true });
        continue;
      }
    } catch {
      continue; // the holder released it between the two calls
    }
    if (Date.now() >= deadline) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}

function releaseWriteLock(lock: string): void {
  fs.rmSync(lock, { force: true });
}

/**
 * A section the delta writes into must be an object or absent: replacing any
 * other shape would silently drop the user's data (review of PR #152).
 */
function badSection(
  config: Record<string, unknown>,
  keys: string[],
  file: string
): string | undefined {
  for (const key of keys) {
    const value = config[key];
    if (
      value !== undefined &&
      (typeof value !== 'object' || value === null || Array.isArray(value))
    ) {
      return `Not written — "${key}" in ${file} is not an object; fix or remove it first.`;
    }
  }
  return undefined;
}

/**
 * The per-integration blocks the delta merges into (`integrations.<name>`) must
 * be objects or absent, for the same reason as `badSection`: the write merges
 * into the block, so a string there would be replaced silently. Release review
 * 2026-11-13 (Config/CLI): the top-level check alone did not cover this.
 */
function badIntegrationBlock(
  config: Record<string, unknown>,
  delta: UserConfigDelta,
  file: string
): string | undefined {
  const existing = config.integrations;
  if (!delta.integrations || typeof existing !== 'object' || existing === null) return undefined;
  for (const name of Object.keys(delta.integrations)) {
    const block = (existing as Record<string, unknown>)[name];
    if (
      block !== undefined &&
      (typeof block !== 'object' || block === null || Array.isArray(block))
    ) {
      return `Not written — "integrations.${name}" in ${file} is not an object; fix or remove it first.`;
    }
  }
  return undefined;
}

export function openUserConfigStore(opts: { agentDir?: string } = {}): UserConfigStore {
  const file = userConfigPath(opts.agentDir ?? piAgentDir());
  return {
    read: () => readObjectFile(file),

    applyDelta(delta): { ok: true; written: string } | { ok: false; error: string } {
      for (const pattern of delta.exclude?.models ?? []) {
        const problem = validateExcludePattern(pattern);
        if (problem) return { ok: false, error: problem };
      }

      for (const name of delta.exclude?.providers ?? []) {
        const problem = validateExcludeProvider(name);
        if (problem) return { ok: false, error: problem };
      }

      // Read-merge-write under a lock file: a second router writing at the same
      // time must not make this read stale (review of PR #152).
      let locked: boolean;
      try {
        locked = acquireWriteLock(`${file}.lock`);
      } catch (err) {
        return { ok: false, error: `Not written — ${textOf(err)}` };
      }
      if (!locked) {
        return {
          ok: false,
          error: `Not written — another router is writing ${file}; try again in a moment.`,
        };
      }
      try {
        // Refuse when the existing file is unusable: writing a delta-only stub
        // would replace the user's other settings. Losing one edit is the
        // lesser harm (same logic as update_model_metrics, review I1).
        const existing = readObjectFile(file);
        if (existing.error) {
          return { ok: false, error: `Not written — ${existing.error}; fix or remove it first.` };
        }

        const next: Record<string, unknown> = { ...(existing.config ?? {}) };
        const touched = [
          delta.exclude && 'exclude',
          delta.context_budget && 'context_budget',
          delta.integrations && 'integrations',
        ].filter((key): key is string => Boolean(key));
        const problem = badSection(next, touched, file) ?? badIntegrationBlock(next, delta, file);
        if (problem) return { ok: false, error: problem };
        if (delta.exclude?.models || delta.exclude?.providers) {
          const exclude =
            next.exclude && typeof next.exclude === 'object' && !Array.isArray(next.exclude)
              ? { ...(next.exclude as Record<string, unknown>) }
              : {};
          if (delta.exclude.models) exclude.models = delta.exclude.models;
          if (delta.exclude.providers) exclude.providers = delta.exclude.providers;
          next.exclude = exclude;
        }
        if (delta.context_budget) {
          const budget =
            next.context_budget &&
            typeof next.context_budget === 'object' &&
            !Array.isArray(next.context_budget)
              ? { ...(next.context_budget as Record<string, unknown>) }
              : {};
          Object.assign(budget, delta.context_budget);
          next.context_budget = budget;
        }
        if (delta.integrations) {
          const blocks =
            next.integrations &&
            typeof next.integrations === 'object' &&
            !Array.isArray(next.integrations)
              ? { ...(next.integrations as Record<string, unknown>) }
              : {};
          for (const [name, patch] of Object.entries(delta.integrations)) {
            const current = blocks[name];
            const kept =
              current && typeof current === 'object' && !Array.isArray(current)
                ? (current as Record<string, unknown>)
                : {};
            blocks[name] = { ...kept, ...patch };
          }
          next.integrations = blocks;
        }

        const tmp = `${file}.tmp-${process.pid}`;
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          // Keep the oldest pre-command state: only the first write creates the backup.
          if (existing.config && !fs.existsSync(`${file}.bak`))
            fs.copyFileSync(file, `${file}.bak`);
          fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
          fs.renameSync(tmp, file);
        } catch (err) {
          fs.rmSync(tmp, { force: true });
          return {
            ok: false,
            error: `Not written — ${err instanceof Error ? err.message : textOf(err)}`,
          };
        }
        return { ok: true, written: file };
      } finally {
        releaseWriteLock(`${file}.lock`);
      }
    },
  };
}

export type ConfigOrigin = 'shipped' | 'user' | 'project';

export interface ConfigLayerView {
  origin: ConfigOrigin;
  path: string;
  present: boolean;
  /** Set when the file exists but cannot be used (the loader ignores it too). */
  error?: string;
  exclude: ExcludeRules;
  /** The layer's `integrations` object, when it has one (override check of `/router config integration`). */
  integrations?: Record<string, unknown>;
}

/**
 * The three config layers, read straight from their files (shipped →
 * user → project, the loader's order), each with its own exclude rules.
 * Read-only: for display and un-exclude origin lookups only.
 */
export function readConfigLayers(opts: {
  extDir: string;
  cwd: string;
  agentDir?: string;
}): ConfigLayerView[] {
  const sources: Array<[ConfigOrigin, string]> = [
    ['shipped', path.join(opts.extDir, 'router-config.json')],
    ['user', userConfigPath(opts.agentDir ?? piAgentDir())],
    ['project', path.join(opts.cwd, '.pi', 'router-config.json')],
  ];
  return sources.map(([origin, file]) => {
    const present = fs.existsSync(file);
    const { config, error } = readObjectFile(file);
    const rules = config?.exclude;
    return {
      origin,
      path: file,
      present,
      ...(error ? { error } : {}),
      exclude: rules && typeof rules === 'object' && !Array.isArray(rules) ? rules : {},
      ...(isPlainObject(config?.integrations) ? { integrations: config.integrations } : {}),
    };
  });
}
