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

import type { ExcludeRules, Config, Cache } from './types.ts';
import { PROVIDER_MAP } from './providers.ts';
import { isFreeModelRef } from './metrics.ts';

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
      // Delegates to isFreeModelRef (pure helper, single source of truth in
      // metrics.ts) so exclude.ts and billingTier() can never disagree on
      // "free". Passes the ctx's own cfg/cache — NOT global module state.
      if (!isFreeModelRef(ref, ctx.cfg.providers, ctx.cache.available_models)) return true;
    }
  }

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
