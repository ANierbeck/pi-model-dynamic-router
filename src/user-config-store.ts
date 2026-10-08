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

const USER_CONFIG_FILE = 'router-config.user.json';

/** What a caller may change. Arrays are SET-replaced in the user file itself. */
export interface UserConfigDelta {
  exclude?: { models?: string[]; providers?: string[] };
  /** Cache-aware compaction (Phase 5b): only the master switch is
   * command-settable; the thresholds stay hand-edited config. */
  context_budget?: { enabled?: boolean };
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
function readObjectFile(file: string): { config: Record<string, unknown> | undefined; error?: string } {
  if (!fs.existsSync(file)) return { config: undefined };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { config: undefined, error: `${file} is not a JSON object` };
    }
    return { config: parsed as Record<string, unknown> };
  } catch (err) {
    return { config: undefined, error: `${file} is unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function openUserConfigStore(opts: { agentDir?: string } = {}): UserConfigStore {
  const file = userConfigPath(opts.agentDir ?? piAgentDir());
  return {
    read: () => readObjectFile(file),

    applyDelta(delta) {
      for (const pattern of delta.exclude?.models ?? []) {
        const problem = validateExcludePattern(pattern);
        if (problem) return { ok: false, error: problem };
      }

      for (const name of delta.exclude?.providers ?? []) {
        const problem = validateExcludeProvider(name);
        if (problem) return { ok: false, error: problem };
      }

      // Refuse when the existing file is unusable: writing a delta-only stub
      // would replace the user's other settings. Losing one edit is the
      // lesser harm (same logic as update_model_metrics, review I1).
      const existing = readObjectFile(file);
      if (existing.error) {
        return { ok: false, error: `Not written — ${existing.error}; fix or remove it first.` };
      }

      const next: Record<string, unknown> = { ...(existing.config ?? {}) };
      if (delta.exclude?.models || delta.exclude?.providers) {
        const exclude = next.exclude && typeof next.exclude === 'object' && !Array.isArray(next.exclude)
          ? { ...(next.exclude as Record<string, unknown>) }
          : {};
        if (delta.exclude.models) exclude.models = delta.exclude.models;
        if (delta.exclude.providers) exclude.providers = delta.exclude.providers;
        next.exclude = exclude;
      }
      if (delta.context_budget) {
        const budget = next.context_budget && typeof next.context_budget === 'object' && !Array.isArray(next.context_budget)
          ? { ...(next.context_budget as Record<string, unknown>) }
          : {};
        Object.assign(budget, delta.context_budget);
        next.context_budget = budget;
      }

      const tmp = `${file}.tmp-${process.pid}`;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // Keep the oldest pre-command state: only the first write creates the backup.
        if (existing.config && !fs.existsSync(`${file}.bak`)) fs.copyFileSync(file, `${file}.bak`);
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
        fs.renameSync(tmp, file);
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        return { ok: false, error: `Not written — ${err instanceof Error ? err.message : String(err)}` };
      }
      return { ok: true, written: file };
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
}

/**
 * The three config layers, read straight from their files (shipped →
 * user → project, the loader's order), each with its own exclude rules.
 * Read-only: for display and un-exclude origin lookups only.
 */
export function readConfigLayers(opts: { extDir: string; cwd: string; agentDir?: string }): ConfigLayerView[] {
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
      exclude: rules && typeof rules === 'object' && !Array.isArray(rules) ? (rules as ExcludeRules) : {},
    };
  });
}
