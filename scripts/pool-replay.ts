// Target layout of the 5-group plan (docs/plans/2026-10-25-category-group-mismatch.md,
// Step 2): the category → group mapping and the layout as a pure config transform.
//
// The replay driver that runs these against the decision log is NOT here yet.
// Its first run failed calibration: the scan cache does not carry the
// claude-bridge models the live router used (they come from Pi's runtime
// registry), so the pool it computed was not the pool of the decisions. See
// docs/research/2026-10-27-pool-replay.md. The driver waits for a pool source
// that matches the decision time.

import type { Config, Group } from '../src/types.ts';

const CATEGORY_TARGET: Record<string, string | null> = {
  simple: 'simple',
  code_simple: 'simple',
  standard: 'standard',
  code_complex: 'code_complex',
  design: 'design',
  planning: 'planning',
  continue: null,
};

/** Target group for a category (D4, D7); null when the category is not replayed. */
export function targetGroupFor(category: string): string | null {
  return Object.prototype.hasOwnProperty.call(CATEGORY_TARGET, category) ? CATEGORY_TARGET[category] : null;
}

/**
 * The five-group layout as a config transform (D2, D4, D5). Pure: the shipped
 * config is not mutated. Failover chains are cleared, so the replay compares
 * first choices only.
 *   standard    ← operational   (rename)
 *   simple      ← scout         (the equivalence note: identical lists)
 *   code_complex← tactical      (rename)
 *   planning    ← planning      (unchanged)
 *   design      ← planning, floor 1600 (D5)
 */
export function targetLayout(shipped: Config): Config {
  const g = shipped.model_groups as Record<string, Group>;
  const bare = (name: string): Group => ({ ...g[name], fallback_groups: [] });
  const model_groups: Record<string, Group> = {
    simple: bare('scout'),
    standard: bare('operational'),
    code_complex: bare('tactical'),
    planning: bare('planning'),
    design: { ...bare('planning'), min_gdpval: 1600 },
  };
  if (g.dynamic) model_groups.dynamic = g.dynamic;
  return { ...shipped, model_groups };
}


