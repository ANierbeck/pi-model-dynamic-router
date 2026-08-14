// src/exclude.ts
// Global model exclusion rules — personalized support/no-support list.
//
// Lets a user opt out of:
//   - whole providers          (exclude.providers: ["openrouter"])
//   - specific model patterns  (exclude.models: ["*fable*", "openrouter/*"])
//   - paid models from a provider while keeping its free tier
//     (exclude.paid_models_from: ["openrouter"])
//
// Applied in generateDynamicConfig BEFORE per-group filtering, so excluded
// models never enter any group's candidate list.

import type { ExcludeRules, Config, Cache } from './types.js';
import { PROVIDER_MAP } from './providers.js';

export interface ExcludeContext {
  rules: ExcludeRules;
  cfg: Config;
  cache: Cache;
}

/**
 * Build a fast matcher for a glob pattern. "*" matches any run of chars.
 * Returns a function that tests a model ref.
 */
function globMatcher(pattern: string): (ref: string) => boolean {
  // Escape regex specials, then turn * into ".*"
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*') +
      '$',
    'i'
  );
  return (ref: string) => re.test(ref);
}

/**
 * Returns true if the model ref should be EXCLUDED by the global rules.
 *
 * @param ref - full model ref, e.g. "openrouter/anthropic/claude-opus-5"
 * @param ctx - exclude context (rules + config + cache)
 */
export function isExcluded(ref: string, ctx: ExcludeContext): boolean {
  const rules = ctx.rules ?? {};
  const { cfg, cache } = ctx;

  // 1. Provider exclusion: drop if the ref's provider matches.
  if (rules.providers?.length) {
    const prov = ref.split('/')[0];
    for (const p of rules.providers) {
      if (prov === p) return true;
      // also support glob on provider
      if (p.includes('*') && globMatcher(p)(prov)) return true;
    }
  }

  // 2. Model pattern exclusion.
  if (rules.models?.length) {
    for (const pattern of rules.models) {
      if (globMatcher(pattern)(ref)) return true;
    }
  }

  // 3. paid_models_from: exclude paid (non-free) models from listed providers.
  if (rules.paid_models_from?.length) {
    const prov = ref.split('/')[0];
    if (rules.paid_models_from.includes(prov)) {
      // A model is "free" if it's in the provider's free_models list, OR its
      // ref contains ":free", OR its discovered cost_per_m is 0.
      if (!isFreeModel(ref, prov, cfg, cache)) return true;
    }
  }

  return false;
}

/**
 * Determine if a model ref is "free" (cost = 0) for the paid_models_from rule.
 * Mirrors the isFreeModel logic in generateDynamicConfig.
 */
function isFreeModel(ref: string, prov: string, cfg: Config, cache: Cache): boolean {
  // Explicit :free tag in the ref
  if (ref.includes(':free')) return true;

  // Listed in the provider's free_models config
  const provConfig = cfg.providers?.[prov];
  if (provConfig?.free_models) {
    const freeSet = new Set(provConfig.free_models);
    if (freeSet.has(ref)) return true;
    // Also check the non-prefixed form
    const bare = ref.includes('/') ? ref.split('/').slice(1).join('/') : ref;
    if (freeSet.has(bare)) return true;
    // And the "provider/bare" normalized form
    if (freeSet.has(`${prov}/${bare}`)) return true;
  }

  // Discovered cost_per_m == 0
  const discovered = (cache.available_models ?? []).find(
    (m) => m.provider === prov && (m.id === ref.slice(prov.length + 1) || `${m.provider}/${m.id}` === ref)
  );
  if (discovered && discovered.cost_per_m === 0) return true;

  return false;
}

/**
 * Filter a list of model refs, removing all excluded ones.
 * Convenience wrapper around isExcluded.
 */
export function applyExcludes(
  refs: string[],
  ctx: ExcludeContext
): { kept: string[]; excluded: string[] } {
  const kept: string[] = [];
  const excluded: string[] = [];
  for (const ref of refs) {
    if (isExcluded(ref, ctx)) excluded.push(ref);
    else kept.push(ref);
  }
  return { kept, excluded };
}
