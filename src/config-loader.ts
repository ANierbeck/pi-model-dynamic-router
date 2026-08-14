// src/config-loader.ts
// Layered configuration loading with deep merge.
//
// Config sources, applied in order (later wins):
//   1. Embedded defaults  — extDir/router-config.json (ships with the extension)
//   2. Global user config — ~/.pi/agent/router-config.user.json (user overrides)
//   3. Project config     — <cwd>/.pi/router-config.json (per-project overrides)
//
// Each override file is a PARTIAL config (a "patch"): it only needs to contain
// the keys the user wants to change. Deep merge combines them so nested objects
// (e.g. exclude, providers.openrouter) merge key-by-key rather than replacing
// the whole block.
//
// Arrays are REPLACED (not merged) — e.g. exclude.models = [...] overrides the
// default list entirely. This is the least surprising behaviour for lists.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import type { Config } from './types.ts';

/**
 * Deep-merge two config objects. `override` wins; nested plain objects are
 * merged recursively; arrays and primitives are replaced.
 */
export function deepMergeConfig(base: Config, override: Partial<Config>): Config {
  const result: Record<string, unknown> = { ...base };
  for (const [key, val] of Object.entries(override)) {
    if (
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      // Both are plain objects → recurse.
      result[key] = deepMergeConfig(result[key] as Config, val as Partial<Config>);
    } else {
      // Primitive, array, or type mismatch → replace.
      result[key] = val;
    }
  }
  return result as unknown as Config;
}

export interface ConfigLoadResult {
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
  let config: Config = JSON.parse(fs.readFileSync(defaultPath, 'utf-8'));
  sources.push(defaultPath);

  // 2. Global user override (~/.pi/agent/router-config.user.json).
  const globalOverridePath = path.join(homedir(), '.pi', 'agent', 'router-config.user.json');
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

  return { config, sources };
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
