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
import type { Config } from './types.ts';
import { CATEGORY_TO_GROUP } from './content-classifier.ts';
import { warnLog } from './logger.ts';
import { LAYA_SPEC } from './laya-classifier.ts';
import { forgetWarnOnce, jsonKey, validateIntegration, warnOnceFor } from './integration.ts';
import { KNOWN_TOP_LEVEL_KEYS, closestKey, unknownTopLevelKeys } from './config-schema.ts';
import { deleteLeaf, isRecord, textOf } from './utils.ts';
import { CONFIG_KEYS, suggestClassifierKey, unknownClassifierKeys } from './config-keys.ts';
import { piAgentDir } from './agent-dir.ts';

// Re-exported: callers import it from here since before the move to agent-dir.ts.
export { piAgentDir };

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
  let config: Config = JSON.parse(fs.readFileSync(defaultPath, 'utf-8')) as Config;
  sources.push(defaultPath);

  // 2. Global user override (<agent dir>/router-config.user.json).
  const globalOverridePath = path.join(piAgentDir(), 'router-config.user.json');
  const globalOverride = tryReadPartial(globalOverridePath, log);
  if (globalOverride) {
    validateRemovedGroups(globalOverride, globalOverridePath);
    migrateClassifierLayer(globalOverride, globalOverridePath);
    validateRenamedTopLevelKeys(globalOverride, globalOverridePath);
    warnUnknownKeys(globalOverride, globalOverridePath);
    config = deepMergeConfig(config, globalOverride);
    sources.push(globalOverridePath);
  } else {
    forgetGoneClassifierWarnings(globalOverridePath, new Set());
  }

  // 3. Project-local override (<cwd>/.pi/router-config.json).
  const projectOverridePath = path.join(cwd, '.pi', 'router-config.json');
  const projectOverride = tryReadPartial(projectOverridePath, log);
  if (projectOverride) {
    validateRemovedGroups(projectOverride, projectOverridePath);
    migrateClassifierLayer(projectOverride, projectOverridePath);
    validateRenamedTopLevelKeys(projectOverride, projectOverridePath);
    warnUnknownKeys(projectOverride, projectOverridePath);
    config = deepMergeConfig(config, projectOverride);
    sources.push(projectOverridePath);
  } else {
    forgetGoneClassifierWarnings(projectOverridePath, new Set());
  }

  validateCategoryGroups(config);
  validateClassifierLaya(config);

  return { config, sources };
}

/**
 * Top-level config keys renamed in 2.0, mapped to where they went. Owner
 * decision 2026-11-08 (plan 2026-11-08-optional-integrations-config.md,
 * decision 1): no read alias, so the old key is dropped, not translated — but
 * never silently: a config that still names it would otherwise lose the
 * setting and sit at the shipped default (Laya off) without a word. Same shape
 * as REMOVED_GROUPS and RENAMED_CLASSIFIER_KEYS.
 */
const RENAMED_TOP_LEVEL_KEYS: Readonly<Record<string, string>> = {
  classifier_laya: 'integrations.laya',
};

function validateRenamedTopLevelKeys(layer: Partial<Config>, source: string): void {
  const bag = layer as Record<string, unknown>;
  for (const [oldKey, newKey] of Object.entries(RENAMED_TOP_LEVEL_KEYS)) {
    const onceKey = `${source}:renamed:${oldKey}`;
    if (!Object.hasOwn(bag, oldKey)) {
      forgetWarnOnce(onceKey);
      continue;
    }
    warnOnceFor(
      onceKey,
      `[router] ${source} ${oldKey}: renamed to "${newKey}" in 2.0 — ignored; move the block to keep the setting`
    );
    delete bag[oldKey];
  }
}

/**
 * Warn once per file about top-level keys `Config` does not know (a typo such
 * as `classifer` for `classifier` would otherwise be merged and silently
 * ignored), naming the closest known key when one is close enough. Only override layers are checked; the shipped defaults
 * own their keys. Warn, never throw — the layer is still merged.
 */
function warnUnknownKeys(layer: Partial<Config>, source: string): void {
  const unknown = unknownTopLevelKeys(layer);
  if (unknown.length === 0) {
    forgetWarnOnce(`${source}:unknown`);
    return;
  }
  const known = Object.keys(KNOWN_TOP_LEVEL_KEYS);
  const described = unknown.map((k) => {
    const near = closestKey(k, known);
    return near ? `${jsonKey(k)} (did you mean "${near}"?)` : jsonKey(k);
  });
  warnOnceFor(
    `${source}:unknown`,
    `[router] ${source}: unknown config key(s) ${described.join(', ')} — ignored`
  );
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
  const hint = (name: string): string =>
    `moved to "${REMOVED_GROUPS[name]}" in the five-group layout`;
  const groups = layer.model_groups as
    | Record<string, { fallback_groups?: string[] | null }>
    | undefined;
  if (groups && typeof groups === 'object') {
    for (const name of Object.keys(groups)) {
      if (Object.hasOwn(REMOVED_GROUPS, name)) {
        warnLog(
          `[router] ${source} model_groups: removed group "${name}" — ignored; ${hint(name)}, move the settings there`
        );
        delete groups[name];
      }
    }
    for (const [name, g] of Object.entries(groups)) {
      const chain = g?.fallback_groups;
      if (!Array.isArray(chain)) continue;
      const kept = chain.filter((t) => !Object.hasOwn(REMOVED_GROUPS, t));
      for (const t of chain) {
        if (Object.hasOwn(REMOVED_GROUPS, t))
          warnLog(
            `[router] ${source} model_groups.${name}.fallback_groups: removed group "${t}" — dropped; ${hint(t)}`
          );
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
      if (Object.hasOwn(REMOVED_GROUPS, t))
        warnLog(
          `[router] ${source} delegation.expensive_groups: removed group "${t}" — dropped; ${hint(t)}`
        );
    }
    if (kept.length === expensive.length) return;
    if (kept.length > 0) layer.delegation.expensive_groups = kept;
    else delete layer.delegation.expensive_groups;
  }
}

/** Per layer file: the migration warnings the last load gave (see migrateClassifierLayer). */
const classifierMigrationWarned = new Map<string, Set<string>>();

/**
 * Pre-2.0 classifier keys, read for one release (plan
 * docs/plans/2026-11-14-config-surface-and-ui.md, decision 2). They sat on the
 * `dynamic` model group (`classifier_cloud_chain` and its older spelling,
 * `classifier_model`, …) and as the top-level `classifier_log` block; the table
 * in src/config-keys.ts gives each its new path in the `classifier` block. The
 * value moves to the new path in the same layer, with a warning that names both
 * spellings. A value the layer already sets at the new path wins; the old one
 * is then only reported. Two old names for one path are resolved in the
 * table's `legacy` order, not the file's key order: before 2.0
 * `classifier_cloud_chain` decided and the older spelling was dropped, so
 * `classifier_cloud_chain` still wins.
 *
 * This replaces the "no read alias" rule of 2026-10-25 (Decision V2) for these
 * keys: a silently dropped cloud switch would turn the cloud chain off without
 * a word, and a translated one keeps the owner's setting.
 *
 * Keys on a group other than `dynamic` are dropped with a warning, as before
 * (only the dynamic group ever read them), and so is a dotted `classifier_log.*`
 * name found as a group key (it belongs at the top level). Unknown keys inside the block, or
 * inside the old `classifier_log` block, are reported once as typos and
 * removed. Each warning is given once per layer file until the problem is gone
 * (the warnOnceFor pattern of the sibling validators): the config is reloaded
 * on every command. Mutates the layer in place.
 */
function migrateClassifierLayer(layer: Partial<Config>, source: string): void {
  const bag = layer as Record<string, unknown>;
  const warned = new Set<string>();
  const warn = (problem: string, message: string): void => {
    const key = `${source}:classifier:${problem}`;
    warned.add(key);
    warnOnceFor(key, message);
  };
  // Map order is table order: CONFIG_KEYS, then each entry's `legacy` order.
  const legacyToPath = new Map<string, string>();
  for (const spec of CONFIG_KEYS) {
    for (const old of spec.legacy ?? []) legacyToPath.set(old, spec.path);
  }
  /** New path -> the old name that set it in this layer. */
  const setBy = new Map<string, string>();

  const assign = (dottedPath: string, value: unknown, oldName: string): void => {
    const parts = dottedPath.split('.');
    if (!isRecord(bag.classifier)) bag.classifier = {};
    let node = bag.classifier as Record<string, unknown>;
    for (const part of parts.slice(1, -1)) {
      if (!isRecord(node[part])) node[part] = {};
      node = node[part] as Record<string, unknown>;
    }
    const leaf = parts[parts.length - 1];
    const winner = setBy.get(dottedPath);
    if (winner !== undefined) {
      warn(
        oldName,
        `[router] ${source} ${oldName}: renamed to "${dottedPath}" — ${winner} sets it too and wins, so this value is ignored`
      );
      return;
    }
    if (node[leaf] !== undefined) {
      warn(
        oldName,
        `[router] ${source} ${oldName}: renamed to "${dottedPath}" — the classifier block already sets it, so the old value is ignored`
      );
      return;
    }
    node[leaf] = value;
    setBy.set(dottedPath, oldName);
    warn(
      oldName,
      `[router] ${source} ${oldName}: renamed to "${dottedPath}" — read for one release; move it to keep the setting`
    );
  };

  // 1. Bare names on model groups: only `dynamic` ever read them.
  const groups = layer.model_groups as Record<string, Record<string, unknown>> | undefined;
  if (isRecord(groups)) {
    for (const [name, g] of Object.entries(groups)) {
      if (!isRecord(g)) continue;
      for (const [old, newPath] of legacyToPath) {
        if (!Object.hasOwn(g, old)) continue;
        const value = g[old];
        delete g[old];
        if (old.includes('.')) {
          // A `classifier_log.*` name was a top-level block, never a group key.
          warn(
            `model_groups.${name}.${old}`,
            `[router] ${source} model_groups.${name}.${old}: ignored — it belongs at the top level as "${newPath}"`
          );
        } else if (name === 'dynamic') {
          assign(newPath, value, `model_groups.dynamic.${old}`);
        } else {
          warn(
            `model_groups.${name}.${old}`,
            `[router] ${source} model_groups.${name}.${old}: ignored — the classifier settings are read from the "classifier" block (${newPath})`
          );
        }
      }
    }
  }

  // 2. The top-level classifier_log block moves to classifier.log, key by key.
  // A key the table does not know is a typo: reported once and dropped.
  if (isRecord(bag.classifier_log)) {
    const oldLog = bag.classifier_log;
    delete bag.classifier_log;
    for (const [k, v] of Object.entries(oldLog)) {
      const oldName = `classifier_log.${k}`;
      const newPath = legacyToPath.get(oldName);
      if (newPath) {
        assign(newPath, v, oldName);
        continue;
      }
      const near = suggestClassifierKey(`log.${k}`);
      warn(
        oldName,
        `[router] ${source} ${oldName}: unknown key — ignored${near ? `; did you mean "classifier.${near}"?` : ''}`
      );
    }
  }

  // 3. Typos inside the block are reported and removed, so they cannot take effect.
  if (isRecord(bag.classifier)) {
    for (const rel of unknownClassifierKeys(bag.classifier)) {
      const near = suggestClassifierKey(rel);
      warn(
        `classifier.${rel}`,
        `[router] ${source} classifier.${rel}: unknown key — ignored${near ? `; did you mean "classifier.${near}"?` : ''}`
      );
      deleteLeaf(bag.classifier, rel);
    }
  }

  forgetGoneClassifierWarnings(source, warned);
}

/**
 * A migration problem that is gone is forgotten, so it is reported again if it
 * returns. Also called with an empty set when the layer file is missing or
 * unparseable: its old warnings no longer describe anything.
 */
function forgetGoneClassifierWarnings(source: string, stillWarned: Set<string>): void {
  for (const key of classifierMigrationWarned.get(source) ?? []) {
    if (!stillWarned.has(key)) forgetWarnOnce(key);
  }
  classifierMigrationWarned.set(source, stillWarned);
}

/**
 * Validate the opt-in Laya classifier stage (src/types.ts, ClassifierLayaConfig).
 *
 * Rules:
 * - `enabled: true` REQUIRES a pinned checkpoint reference (ADR-0025: the router
 *   never ships or infers a concrete model name).
 * - `endpoint` must be loopback (127.0.0.0/8, localhost, ::1): the documented
 *   privacy promise is that prompt text never leaves the machine, so a remote
 *   endpoint is rejected, not merely discouraged (merge review 2026-11-01).
 * - On `enabled: true` the remaining fields are filled with defaults so callers
 *   can read them without guards (endpoint, timeout_ms, confidence_threshold, mode);
 *   wrong-typed fields fall back to their defaults with a warning.
 *
 * Fail-safe, never loud: this runs at extension start and mid-turn from tools,
 * so an invalid user-layer block disables the stage (enabled:false) with a
 * warning instead of throwing and taking the whole router down (merge review
 * 2026-11-01; previously a missing checkpoint threw).
 *
 * Mutates the config object in place. Exported for test access (called once
 * during config load).
 */
export function validateClassifierLaya(config: Config): void {
  const c = config.integrations?.laya;
  if (!c || typeof c !== 'object') return;
  // Runs for a disabled or enabled-less block too: the typo check must see it.
  validateIntegration(LAYA_SPEC, c as Record<string, unknown>);
  if (c.enabled) c.confidence_threshold ??= 0.8;
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
      warnLog(
        `[router] category_groups: unknown category "${category}" — entry ignored (known: ${Object.keys(CATEGORY_TO_GROUP).join(', ')})`
      );
      delete mapping[category];
      continue;
    }
    if (typeof group !== 'string' || !config.model_groups[group]) {
      warnLog(
        `[router] category_groups: unknown group "${String(group)}" for category "${category}" — entry ignored (known groups: ${Object.keys(config.model_groups).join(', ')})`
      );
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
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    log?.(`[router] Override config at ${filePath} is not a JSON object, ignoring`);
    return undefined;
  } catch (err) {
    log?.(
      `[router] Failed to read override config ${filePath}: ${err instanceof Error ? err.message : textOf(err)}`
    );
    return undefined;
  }
}
