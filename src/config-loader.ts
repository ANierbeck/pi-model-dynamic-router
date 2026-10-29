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
import { LAYA_DEFAULT_ENDPOINT } from './laya-classifier.ts';

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
    validateRemovedGroups(globalOverride, globalOverridePath);
    config = deepMergeConfig(config, globalOverride);
    sources.push(globalOverridePath);
  }

  // 3. Project-local override (<cwd>/.pi/router-config.json).
  const projectOverridePath = path.join(cwd, '.pi', 'router-config.json');
  const projectOverride = tryReadPartial(projectOverridePath, log);
  if (projectOverride) {
    validateRemovedGroups(projectOverride, projectOverridePath);
    config = deepMergeConfig(config, projectOverride);
    sources.push(projectOverridePath);
  }

  validateCategoryGroups(config);
  validateClassifierLaya(config);

  return { config, sources };
}

/**
 * Groups of the 13-group layout that the five-group layout removed or renamed
 * (docs/plans/2026-10-25-category-group-mismatch.md, D2/D4), mapped to the
 * group that took over their role. Decision D3: no read aliases in 2.0, so a
 * config still naming one is warned about, not translated. `complex` had no
 * direct successor; `standard` is the closest mid band.
 */
export const REMOVED_GROUPS: Readonly<Record<string, string>> = {
  trivial: 'simple',
  scout: 'simple',
  fallback: 'simple',
  operational: 'standard',
  tactical: 'code_complex',
  strategic: 'planning',
  complex: 'standard',
};

/**
 * Warn about every reference to a removed group left in a user/project layer
 * and drop it BEFORE the layer is merged: a `model_groups` entry (it would
 * otherwise be a stray method-less group while the value the owner meant for
 * the successor never applies), a `fallback_groups` entry, a
 * `delegation.expensive_groups` entry. Only override layers are checked — the
 * embedded defaults are the shipped config and own their group names. A list
 * that held only removed names is deleted so the embedded default stands (an
 * emptied `expensive_groups` would mean "check disabled" and silently turn the
 * expensive-model read block off). Warn, never throw — an outdated override
 * must not break routing. `category_groups` is covered by
 * validateCategoryGroups (unknown group).
 */
function validateRemovedGroups(layer: Partial<Config>, source: string): void {
  const hint = (name: string) => `moved to "${REMOVED_GROUPS[name]}" in the five-group layout`;
  const groups = layer.model_groups as Record<string, { fallback_groups?: string[] | null }> | undefined;
  if (groups && typeof groups === 'object') {
    for (const name of Object.keys(groups)) {
      if (Object.hasOwn(REMOVED_GROUPS, name)) {
        warnLog(`[router] ${source} model_groups: removed group "${name}" — ignored; ${hint(name)}, move the settings there`);
        delete groups[name];
      }
    }
    for (const [name, g] of Object.entries(groups)) {
      const chain = g?.fallback_groups;
      if (!Array.isArray(chain)) continue;
      const kept = chain.filter((t) => !Object.hasOwn(REMOVED_GROUPS, t));
      for (const t of chain) {
        if (Object.hasOwn(REMOVED_GROUPS, t)) warnLog(`[router] ${source} model_groups.${name}.fallback_groups: removed group "${t}" — dropped; ${hint(t)}`);
      }
      if (kept.length === chain.length) continue;
      if (kept.length > 0) g.fallback_groups = kept;
      else delete g.fallback_groups;
    }
  }
  const expensive = layer.delegation?.expensive_groups;
  if (layer.delegation && Array.isArray(expensive)) {
    const kept = expensive.filter((t) => !Object.hasOwn(REMOVED_GROUPS, t));
    for (const t of expensive) {
      if (Object.hasOwn(REMOVED_GROUPS, t)) warnLog(`[router] ${source} delegation.expensive_groups: removed group "${t}" — dropped; ${hint(t)}`);
    }
    if (kept.length === expensive.length) return;
    if (kept.length > 0) layer.delegation.expensive_groups = kept;
    else delete layer.delegation.expensive_groups;
  }
}

/**
 * Validate the opt-in Laya classifier stage (src/types.ts, ClassifierLayaConfig).
 *
 * Rules:
 * - `enabled: true` REQUIRES a pinned checkpoint reference (ADR-0025: the router
 *   never ships or infers a concrete model name).
 * - On `enabled: true` the remaining fields are filled with defaults so callers
 *   can read them without guards (endpoint, timeout_ms, confidence_threshold, mode).
 * - Validation is strict (throws) because an improperly configured classifier
 *   could change routing behavior; a typo in the user layer must fail loudly.
 *
 * Throws an Error on violation; otherwise mutates the config object in place by
 * inserting defaults. Exported for test access (called once during config load).
 */
export function validateClassifierLaya(config: Config): void {
  const c = config.classifier_laya;
  if (!c) return;
  if (c.enabled && !c.checkpoint) {
    throw new Error(
      `[router] classifier_laya: 'checkpoint' is required when enabled:true ` +
        `(set a pinned HF checkpoint ref — repo:revision — before enabling). The router ` +
        `never downloads weights and never ships a model name (ADR-0025).`
    );
  }
  if (c.enabled) {
    if (c.endpoint == null) c.endpoint = LAYA_DEFAULT_ENDPOINT;
    if (c.timeout_ms == null) c.timeout_ms = 1500;
    if (c.confidence_threshold == null) c.confidence_threshold = 0.8;
    if (!c.mode) c.mode = 'shadow';
  }
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
    if (!Object.hasOwn(CATEGORY_TO_GROUP, category)) {
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
