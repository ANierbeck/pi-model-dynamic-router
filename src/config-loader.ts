// src/config-loader.ts
// Layered configuration loading with deep merge.
//
// Config sources, applied in order (later wins):
//   1. Embedded defaults  — extDir/router-config.json (ships with the extension)
//   2. Global user config — ~/.pi/agent/router-config.user.json (user overrides;
//      $PI_CODING_AGENT_DIR/router-config.user.json when that is set)
//   3. Project config     — <cwd>/.pi/router-config.json (per-project overrides)
//
// Each override file is a PARTIAL config (a "patch"): it only needs to contain
// the keys the user wants to change. Deep merge combines them so nested objects
// (e.g. exclude, providers.openrouter) merge key-by-key rather than replacing
// the whole block.
//
// Arrays are REPLACED (not merged), with one exception: arrays directly under
// the top-level `exclude` block are UNIONED across layers (ADR-0009). An
// exclusion is a safety property — a user config listing its own
// exclude.models must not silently re-admit the bundled blocklist. Ordered
// lists (fallback_groups, group models) keep replace semantics.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import type { Config } from './types.ts';
import { CATEGORY_TO_GROUP } from './content-classifier.ts';
import { warnLog } from './logger.ts';

/**
 * Deep-merge two config objects. `override` wins; nested plain objects are
 * merged recursively; arrays and primitives are replaced — except arrays
 * under the top-level `exclude` block, which are unioned (base order first).
 */
export function deepMergeConfig(
  base: Config,
  override: Partial<Config>,
  path: readonly string[] = []
): Config {
  const result: Record<string, unknown> = { ...base };
  const inExclude = path.length === 1 && path[0] === 'exclude';
  for (const [key, val] of Object.entries(override)) {
    if (inExclude && Array.isArray(val) && Array.isArray(result[key])) {
      result[key] = [...new Set([...(result[key] as unknown[]), ...val])];
    } else if (
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      // Both are plain objects → recurse.
      result[key] = deepMergeConfig(result[key] as Config, val as Partial<Config>, [...path, key]);
    } else {
      // Primitive, array, or type mismatch → replace.
      result[key] = val;
    }
  }
  return result as unknown as Config;
}

interface ConfigLoadResult {
  config: Config;
  sources: string[]; // paths that contributed (for logging)
}

/**
 * Pi's agent directory: follows Pi's own PI_CODING_AGENT_DIR (e.g. a separate
 * work profile in ~/.pi-work/agent) and defaults to ~/.pi/agent. A leading ~
 * is expanded like Pi's getAgentDir() does, because node:fs never expands it
 * and a value set without a shell (.env file, programmatic setter) would
 * otherwise silently hide Pi's auth file and the user config. Resolved per
 * call so a profile switch or a test stub is always observed.
 */
export function piAgentDir(): string {
  const dir = process.env.PI_CODING_AGENT_DIR;
  if (!dir) return path.join(homedir(), '.pi', 'agent');
  if (dir === '~') return homedir();
  if (dir.startsWith('~/')) return path.join(homedir(), dir.slice(2));
  return dir;
}

/**
 * Load the effective config by deep-merging embedded defaults with optional
 * global and project-local override files.
 *
 * @param extDir    - extension directory (holds the embedded router-config.json)
 * @param cwd       - current working directory (for .pi/router-config.json)
 * @param log       - optional logger function for info messages
 */
export function loadLayeredConfig(
  extDir: string,
  cwd: string,
  log?: (msg: string, extra?: unknown) => void
): ConfigLoadResult {
  const sources: string[] = [];

  // 1. Embedded defaults (always present).
  const defaultPath = path.join(extDir, 'router-config.json');
  let config: Config = JSON.parse(fs.readFileSync(defaultPath, 'utf-8'));
  sources.push(defaultPath);

  // 2. Global user override (<agent dir>/router-config.user.json).
  const globalOverridePath = path.join(piAgentDir(), 'router-config.user.json');
  const globalOverride = tryReadPartial(globalOverridePath, log);
  if (globalOverride) {
    config = deepMergeConfig(config, globalOverride);
    sources.push(globalOverridePath);
  }

  // 3. Project-local override (<cwd>/.pi/router-config.json).
  const projectOverridePath = path.join(cwd, '.pi', 'router-config.json');
  const projectOverride = tryReadPartial(projectOverridePath, log);
  if (projectOverride) {
    config = deepMergeConfig(config, projectOverride);
    sources.push(projectOverridePath);
  }

  validateCategoryGroups(config);

  return { config, sources };
}

/**
 * Task-type-balancing Phase 3: validate the user's `category_groups`
 * mapping (category → group) after the layered merge. Unknown categories
 * (not in the built-in CATEGORY_TO_GROUP) and unknown groups (not in
 * `model_groups`) are rejected with a WARNING naming the offending entry;
 * the offending entry is dropped, the rest of the mapping still applies.
 * Warn, never throw — a typo in a user override must not break routing.
 */
function validateCategoryGroups(config: Config): void {
  const mapping = config.category_groups;
  if (!mapping || typeof mapping !== 'object') return;
  for (const [category, group] of Object.entries(mapping)) {
    if (!(category in CATEGORY_TO_GROUP)) {
      warnLog(`[router] category_groups: unknown category "${category}" — entry ignored (known: ${Object.keys(CATEGORY_TO_GROUP).join(', ')})`);
      delete mapping[category];
      continue;
    }
    if (typeof group !== 'string' || !config.model_groups[group]) {
      warnLog(`[router] category_groups: unknown group "${String(group)}" for category "${category}" — entry ignored (known groups: ${Object.keys(config.model_groups).join(', ')})`);
      delete mapping[category];
    }
  }
}

/**
 * Read a partial config file, returning undefined if missing or unparseable.
 * Errors are logged but not thrown (a broken override should not crash the router).
 */
function tryReadPartial(
  filePath: string,
  log?: (msg: string, extra?: unknown) => void
): Partial<Config> | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Partial<Config>;
    }
    log?.(`[router] Override config at ${filePath} is not a JSON object, ignoring`);
    return undefined;
  } catch (err) {
    log?.(
      `[router] Failed to read override config ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}
