// src/config-keys.ts
// The description table for the user-facing configuration (plan
// docs/plans/2026-11-14-config-surface-and-ui.md, Phase 1). One entry per key
// the router reads from the user layer: its dotted path, type, allowed values,
// shipped default, one-line meaning, pre-2.0 names still read with a warning,
// how the router may change it, and whether the wizard offers it.
//
// The loader (config-loader.ts), the typo check, `/router config` (Phases 2–4)
// and the generated reference (Phase 5, docs/config-reference.md) all read this
// table. A key that is not in the table is not a setting the router documents;
// unknown keys inside the covered blocks are reported, not applied.
//
// Scope: classifier.*, exclude.*, context_budget.enabled, integrations.laya.*
// (plan "Scope"). Top-level keys outside this table (providers, model_groups,
// delegation, …) stay file-only and are governed by KNOWN_TOP_LEVEL_KEYS in
// config-schema.ts until their own plan.

import { closestKey } from './config-schema.ts';
import { getLeaf } from './utils.ts';

/**
 * How the router may change a key:
 * - `set`: `/router config set|unset <path>` writes it (validated against the table);
 * - `alias`: an existing subcommand writes it (`alias` names the subcommand);
 * - `file-only`: hand-edited only, the command never writes it.
 */
export type SettableVia = 'set' | 'alias' | 'file-only';

export interface ConfigKeySpec {
  /** Dotted path in the config object, e.g. `classifier.cloud.enabled`. */
  readonly path: string;
  readonly kind: 'boolean' | 'string' | 'string-list' | 'number' | 'enum';
  /** Allowed values for an `enum`. */
  readonly values?: readonly string[];
  /**
   * The shipped value, or — when the shipped file does not set the key — the
   * code default, marked with a trailing ` (code default)`.
   */
  readonly shipped: string;
  /** One line for the reference and the wizard. */
  readonly meaning: string;
  /**
   * Pre-2.0 names still read for one release, with a warning. A name with a dot
   * is a path in the old layout (`classifier_log.enabled`, top-level); a bare
   * name is a key of the `dynamic` model group.
   */
  readonly legacy?: readonly string[];
  readonly via: SettableVia;
  /** For `via: 'alias'`: the subcommand that writes the key. */
  readonly alias?: string;
  /** Offered by the guided `/router config` menu (Phase 4). */
  readonly wizard?: boolean;
  /**
   * For model references: the shape a value must have. `provider-model` is
   * `provider/id`; `ollama-model` is `ollama/<name>`. Whether pi knows a
   * `provider-model` ref is checked by the command, not here (the table has no
   * registry); an `ollama-model` ref is checked for its shape only.
   */
  readonly ref?: 'provider-model' | 'ollama-model';
}

export const CONFIG_KEYS: readonly ConfigKeySpec[] = [
  {
    path: 'classifier.local.model',
    kind: 'string',
    shipped: 'unset, derived from the models Ollama reports (code default)',
    meaning:
      'Pinned local classifier model (`ollama/<name>:<tag>`). Unset: the scan probe derives it.',
    legacy: ['classifier_model'],
    via: 'set',
    ref: 'ollama-model',
  },
  {
    path: 'classifier.local.fallback',
    kind: 'string',
    shipped: 'unset, derived (code default)',
    meaning: 'Pinned second local classifier model, tried when the primary gives no answer.',
    legacy: ['classifier_fallback'],
    via: 'set',
    ref: 'ollama-model',
  },
  {
    path: 'classifier.cloud.enabled',
    kind: 'boolean',
    shipped: 'true (code default false)',
    meaning:
      'Use cloud models for classification when the local chain gives no answer. Off keeps prompt text on the machine.',
    legacy: ['classifier_cloud_chain', 'classifier_cloud_fallback'],
    via: 'set',
    wizard: true,
  },
  {
    path: 'classifier.cloud.model',
    kind: 'string',
    shipped: 'unset (code default)',
    meaning:
      'Pinned cloud classifier (`provider/id`), tried first, before the probe-verified list.',
    legacy: ['classifier_cloud_model'],
    via: 'set',
    ref: 'provider-model',
  },
  {
    path: 'classifier.cloud.candidates',
    kind: 'string-list',
    shipped: 'unset, automatic chain (code default)',
    meaning:
      'Ordered cloud candidates (`provider/id`). Replaces the automatic chain. Each entry must be a model pi knows.',
    legacy: ['classifier_cloud_candidates'],
    via: 'set',
    wizard: true,
    ref: 'provider-model',
  },
  {
    path: 'classifier.cloud.escalate_low_confidence',
    kind: 'boolean',
    shipped: 'false (code default)',
    meaning:
      'Send a local reply below the confidence gate (0.5) to the cloud chain once. Then prompt text leaves the machine.',
    legacy: ['classifier_escalate_low_confidence'],
    via: 'set',
  },
  {
    path: 'classifier.log.enabled',
    kind: 'boolean',
    shipped: 'true',
    meaning: 'Write the classifier decision log (`~/.pi/logs/classifier-decisions.jsonl`).',
    legacy: ['classifier_log.enabled'],
    via: 'set',
  },
  {
    path: 'classifier.log.store_text',
    kind: 'enum',
    values: ['none', 'snippet', 'full'],
    shipped: 'none',
    meaning: 'How much prompt text a decision record keeps. `full` keeps prompts; hand-edit only.',
    legacy: ['classifier_log.store_text'],
    via: 'file-only',
  },
  {
    path: 'classifier.log.max_bytes',
    kind: 'number',
    shipped: '20971520 (code default)',
    meaning: 'Rotation size of the decision log file in bytes.',
    legacy: ['classifier_log.max_bytes'],
    via: 'file-only',
  },
  {
    path: 'classifier.log.keep',
    kind: 'number',
    shipped: '3 (code default)',
    meaning: 'Number of decision log files kept, including the live one.',
    legacy: ['classifier_log.keep'],
    via: 'file-only',
  },
  {
    path: 'exclude.models',
    kind: 'string-list',
    shipped: '[]',
    meaning: 'Model refs or globs removed from routing.',
    via: 'alias',
    alias: 'config exclude | config unexclude',
  },
  {
    path: 'exclude.providers',
    kind: 'string-list',
    shipped: '[] (code default)',
    meaning: 'Providers removed from routing.',
    via: 'alias',
    alias: 'config exclude | config unexclude',
  },
  {
    path: 'context_budget.enabled',
    kind: 'boolean',
    shipped: 'false (code default)',
    meaning: 'Cache-aware auto-compaction. Only the switch is command-settable.',
    via: 'alias',
    alias: 'config compaction on|off',
  },
  {
    path: 'integrations.laya.enabled',
    kind: 'boolean',
    shipped: 'false',
    meaning: 'Use the local Laya classifier sidecar. Needs a checkpoint when on.',
    via: 'alias',
    alias: 'config integration laya on|off',
    wizard: true,
  },
  {
    path: 'integrations.laya.mode',
    kind: 'enum',
    values: ['active', 'shadow'],
    shipped: 'shadow (code default)',
    meaning: '`active` routes on Laya results; `shadow` only records them for comparison.',
    via: 'alias',
    alias: 'config integration laya active|shadow',
    wizard: true,
  },
  {
    path: 'integrations.laya.checkpoint',
    kind: 'string',
    shipped: 'unset (code default)',
    meaning: 'The model the sidecar is expected to serve, e.g. `router@1.0.0`. Required when on.',
    via: 'file-only',
  },
  {
    path: 'integrations.laya.endpoint',
    kind: 'string',
    shipped: 'http://127.0.0.1:8089 (code default)',
    meaning: 'Loopback endpoint of the Laya sidecar. Remote hosts are rejected.',
    via: 'file-only',
  },
  {
    path: 'integrations.laya.timeout_ms',
    kind: 'number',
    shipped: '1500 (code default)',
    meaning: 'Timeout for one Laya call in milliseconds.',
    via: 'file-only',
  },
  {
    path: 'integrations.laya.confidence_threshold',
    kind: 'number',
    shipped: '0.8 (code default)',
    meaning: 'Minimum Laya confidence for a result to enter the chain.',
    via: 'file-only',
  },
  {
    path: 'integrations.laya.compare_in_background',
    kind: 'boolean',
    shipped: 'false (code default)',
    meaning:
      'In active mode, still run the replaced chain detached and log it as a comparator record (ADR-0027).',
    via: 'file-only',
  },
  {
    path: 'integrations.laya.observe_momentum',
    kind: 'boolean',
    shipped: 'false (code default)',
    meaning: 'Log detached answers for short momentum prompts (can incur classifier spend).',
    via: 'file-only',
  },
];

const BY_PATH = new Map(CONFIG_KEYS.map((k) => [k.path, k]));

/** The table entry for a dotted path, or undefined when the key is not documented. */
export function configKey(dottedPath: string): ConfigKeySpec | undefined {
  return BY_PATH.get(dottedPath);
}

/**
 * Where a raw (not yet migrated) layer holds a key's pre-2.0 names, in table
 * order. A bare legacy name is a key of the `dynamic` model group; a dotted one
 * is a top-level path.
 */
export function legacyLayerPaths(dottedPath: string): string[] {
  const legacy = configKey(dottedPath)?.legacy ?? [];
  return legacy.map((old) => (old.includes('.') ? old : `model_groups.dynamic.${old}`));
}

/** Whether a raw config layer sets the key, under its path or a pre-2.0 name. */
export function layerSetsKey(layer: unknown, dottedPath: string): boolean {
  return [dottedPath, ...legacyLayerPaths(dottedPath)].some((p) => getLeaf(layer, p) !== undefined);
}

/**
 * Leaf paths of a plain object, relative to the object. Arrays are leaves;
 * an empty object has none.
 */
export function leafPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    leafPaths(v, prefix ? `${prefix}.${k}` : k)
  );
}

/**
 * Paths inside a `classifier` block (relative to `classifier`, e.g.
 * `cloud.enable`) that the table does not know. Empty when all are known.
 */
export function unknownClassifierKeys(block: unknown): string[] {
  const known = CONFIG_KEYS.filter((k) => k.path.startsWith('classifier.')).map((k) =>
    k.path.slice('classifier.'.length)
  );
  return leafPaths(block).filter((p) => !known.includes(p));
}

/** The known classifier path a typo most likely meant, or undefined. */
export function suggestClassifierKey(relativePath: string): string | undefined {
  const known = CONFIG_KEYS.filter((k) => k.path.startsWith('classifier.')).map((k) =>
    k.path.slice('classifier.'.length)
  );
  return closestKey(relativePath, known);
}

/**
 * The id after the first slash may hold more slashes: a pi ref splits at the
 * first slash (`<provider>/<vendor>/<model>` has the id `<vendor>/<model>`),
 * and Ollama names can be namespaced (`ollama/hf.co/<user>/<model>:<tag>`).
 */
const REF_SHAPE: Record<NonNullable<ConfigKeySpec['ref']>, { re: RegExp; expected: string }> = {
  'provider-model': { re: /^[A-Za-z0-9._-]+\/\S+$/, expected: 'provider/id' },
  'ollama-model': { re: /^ollama\/\S+$/, expected: 'ollama/<name>' },
};

/**
 * Why a value cannot be written to the key, or undefined when it can. Checks
 * the kind, the allowed words and the reference shape; never whether pi knows
 * a model (that needs the registry and is the command's job).
 */
export function configValueProblem(spec: ConfigKeySpec, value: unknown): string | undefined {
  const refProblem = (ref: unknown): string | undefined => {
    if (!spec.ref) return undefined;
    const shape = REF_SHAPE[spec.ref];
    if (typeof ref === 'string' && shape.re.test(ref)) return undefined;
    return `"${String(ref)}" is not a model reference (expected ${shape.expected})`;
  };
  switch (spec.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'the value must be on or off';
    case 'enum':
      return typeof value === 'string' && spec.values?.includes(value)
        ? undefined
        : `the value must be one of ${(spec.values ?? []).join(', ')}`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? undefined
        : 'the value must be a number of zero or more';
    case 'string':
      if (typeof value !== 'string' || value === '') return 'the value must not be empty';
      return refProblem(value);
    case 'string-list':
      if (!Array.isArray(value) || value.length === 0)
        return 'the value must be a non-empty list (use unset to clear it)';
      for (const entry of value) {
        const problem =
          typeof entry === 'string' ? refProblem(entry) : 'the list must hold strings';
        if (problem) return problem;
      }
      return undefined;
  }
}

/**
 * Turns the words typed after `/router config set <path>` into the value the
 * key takes: `on`/`off` for switches, a comma-separated list for lists. Returns
 * an error message (without a "Not written" prefix) when the words do not fit.
 */
export function parseConfigValue(
  spec: ConfigKeySpec,
  raw: string
): { value: unknown } | { error: string } {
  const text = raw.trim();
  let value: unknown;
  switch (spec.kind) {
    case 'boolean':
      if (text === 'on') value = true;
      else if (text === 'off') value = false;
      else return { error: `"${text}" is not on or off` };
      break;
    case 'number':
      value = Number(text);
      break;
    case 'string-list':
      value = text
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      break;
    default:
      value = text;
  }
  const problem = configValueProblem(spec, value);
  return problem ? { error: problem } : { value };
}
