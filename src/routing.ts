// src/routing.ts
// Routing logic for the pi-model-router

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type {
  Group,
  Config,
  Cache,
  RateLimit,
  Metrics,
  ModelWithLimits,
  GroupResolution,
} from './types.ts';
import { splitRef, stripProvider, norm, baseTokens } from './utils.ts';
import { PROVIDER_MAP } from './providers.ts';
import { getM, lookupGdp, getMatchedSlug, billingTier, effCost, costMux, lookupPrice, calculateScore } from './metrics.ts';
import { isExcluded } from './exclude.ts';
import { demoteUnhealthy } from './model-health.ts';
import { hasBudget } from './budget.ts';
import { getGroupForCategory } from './content-classifier.ts';

// ── Constants ────────────────────────────────────────────────────────────

const SUB_DISCOUNT = 0.5; // Subscription discount factor

// ── Shared group filters (A1 consolidation) ─────────────────────────────────

/**
 * Resolves the billing mode for a provider ref's provider: the per-provider
 * override in `cfg.providers[..].billing` wins over the PROVIDER_MAP default,
 * falling back to 'pay_per_token' when neither is known.
 */
function billingFor(cfg: Config, prov: string): string {
  return cfg.providers?.[prov]?.billing ?? PROVIDER_MAP[prov]?.billing ?? 'pay_per_token';
}

/**
 * Applies the method-independent group filters to a candidate list.
 *
 * This is the shared filter pipeline (A1) used by all three group-candidate
 * paths — {@link Router.resolveGroup} (live selection),
 * {@link Router.getTopModels} (display), and `generateDynamicConfig` in
 * index.ts (persisted config). It encodes ONLY the filters that must behave
 * identically across the three paths; method-specific sorting, health
 * demotion, budget filtering, rate-limit splitting, static-model
 * preservation, and persistence stay in their respective callers.
 *
 * Filter order (matters for correctness, not just performance):
 *   1. exclude_providers  — drop whole providers (group-level override)
 *   2. exclude_models     — drop exact model refs (group-level override)
 *   3. min_gdpval / min_gdpval_pct — quality gate (GDPval ≥ threshold)
 *   4. max_cost           — total cost cap; unknown-cost handling is
 *                           billing-aware (see INVARIANTS)
 *   5. max_cost_per_m     — per-million input-price cap
 *
 * INPUT CONTRACT: `refs` are provider/id strings; `g` is the group config;
 * `cfg` is the live Config (for per-provider billing overrides). `dedup` is
 * optional and, when true, runs {@link Router.dedupByModelIdentity} after the
 * filters — the live and display paths dedup, the persist path uses its own
 * token-signature dedup (which also preserves pinned static models), so it
 * passes `dedup: false` and handles dedup itself.
 *
 * OUTPUT CONTRACT: returns a NEW filtered array (does not mutate input).
 *
 * SIDE EFFECTS: none. Pure w.r.t. the in-memory metrics/cost lookups.
 *
 * INVARIANTS (must be preserved across all callers):
 *   - `max_cost` with unknown cost: included iff the provider is NOT
 *     pay_per_token (subscription/local = sunk cost), excluded for
 *     pay_per_token (genuinely unknown price). This is the live-path
 *     semantics; the display path historically diverged (dropped all
 *     unknowns) which made `/router` show models the live path would never
 *     pick — the consolidation fixes that divergence.
 *   - `max_cost_per_m` with unknown price: always excluded (neither path can
 *     make a good decision without a concrete price).
 *   - `min_gdpval` uses `lookupGdp(ref) ?? null`; a null score (unscored
 *     model) fails the quality gate, matching filterByQualityMin.
 */
export function applyGroupFilters(
  refs: string[],
  g: Group,
  cfg: Config,
  dedup: boolean = false,
  dedupFn?: (refs: string[]) => string[],
): string[] {
  let c = refs;

  // 1. exclude_providers
  if (g.exclude_providers?.length) {
    c = c.filter(ref => !g.exclude_providers!.includes(ref.split('/')[0]));
  }
  // 2. exclude_models
  if (g.exclude_models?.length) {
    c = c.filter(ref => !g.exclude_models!.includes(ref));
  }
  // 3. min_gdpval / min_gdpval_pct
  // min_gdpval <= 0 means "no quality gate" — pass everything through (matches
  // the historical filterByQualityMin guard against min <= 0). A null score
  // (unscored model) fails a STRICT positive threshold; this is the fix for
  // the 13/148-style collapse where unscored models leaked past the gate via
  // the old `return filtered.length ? filtered : refs` fallback.
  if (g.min_gdpval != null && g.min_gdpval > 0) {
    c = c.filter(ref => { const v = lookupGdp(ref); return v !== null && v >= g.min_gdpval!; });
  } else if (g.min_gdpval_pct != null && g.min_gdpval_pct > 0) {
    // delegate to the existing quality-pct filter for identical semantics
    // (compute max once; filterByQualityPct is on the Router instance, so
    // replicate the simple percentile gate here for the module function)
    const all = refs.map(r => lookupGdp(r)).filter((v): v is number => v !== null);
    if (all.length) {
      const max = Math.max(...all);
      const thresh = (g.min_gdpval_pct! / 100) * max;
      c = c.filter(ref => { const v = lookupGdp(ref); return v !== null && v >= thresh; });
    }
  }
  // 4. max_cost (billing-aware unknown handling)
  if (g.max_cost !== undefined) {
    c = c.filter(ref => {
      const cost = effCost(ref);
      if (cost === 'unknown') {
        // subscription/local = sunk cost → keep; pay_per_token → drop
        return billingFor(cfg, ref.split('/')[0]) !== 'pay_per_token';
      }
      return cost <= g.max_cost!;
    });
  }
  // 5. max_cost_per_m (unknown price → always drop)
  if (g.max_cost_per_m !== undefined) {
    c = c.filter(ref => {
      const price = lookupPrice(ref);
      if (!price || price.input === 'unknown' || price.output === 'unknown') return false;
      return price.input <= g.max_cost_per_m!;
    });
  }

  // Optional dedup (live + display paths); persist path handles its own.
  if (dedup && dedupFn) c = dedupFn(c);
  return c;
}

// ── Fallback-group cascade ────────────────────────────────────────────────

/**
 * Global fallback order used when a group has no (or exhausted) configured
 * `fallback_groups`. Coarsest tiers first, cheapest/local last.
 */
export const FALLBACK_GROUP_ORDER: readonly string[] = [
  'strategic', 'complex', 'operational', 'tactical', 'simple', 'trivial', 'scout', 'fallback',
];

/**
 * Resolves the next group to try when every candidate in `currentGroup` has
 * failed. Prefers the group's configured `fallback_groups` (from
 * router-config.json) over the global {@link FALLBACK_GROUP_ORDER} — this
 * allows per-group fallback chains like trivial → [scout, operational,
 * fallback] instead of always walking the hardcoded order. Falls through to
 * the global order when `fallback_groups` is unset, empty, or every entry
 * in it is either unknown or already visited.
 *
 * `visited` excludes groups already tried in this cascade. The auto-generated
 * `fallback_groups` lists are a full ordering over every group, which
 * routinely produces mutual references (e.g. tactical's first pick is
 * strategic, and strategic's first pick is tactical). Without skipping
 * already-visited groups, two groups that both fail recurse into each other
 * forever and blow the stack.
 */
export function getFallbackGroup(
  currentGroup: string,
  modelGroups: Record<string, Group>,
  visited: ReadonlySet<string>,
): string | null {
  const g = modelGroups[currentGroup];
  if (g?.fallback_groups?.length) {
    for (const fb of g.fallback_groups) {
      if (modelGroups[fb] && !visited.has(fb)) return fb;
    }
    // If no configured fallback groups exist in config, fall through to
    // the global order below.
  }
  const idx = FALLBACK_GROUP_ORDER.indexOf(currentGroup);
  if (idx === -1) return null;
  for (let i = idx + 1; i < FALLBACK_GROUP_ORDER.length; i++) {
    const group = FALLBACK_GROUP_ORDER[i];
    if (modelGroups[group] && !visited.has(group)) return group;
  }
  return null;
}

// ── Routing Logic ─────────────────────────────────────────────────────────

/**
 * Manages routing for model groups
 */
export class Router {
  private cfg: Config;
  private cache: Cache;
  private limits: Map<string, RateLimit>;
  private rrCounters: Record<string, number> = {};
  private activeGroup: string | null = null;
  private curModel: string = '';
  private lastDynamicModel: string = '';
  private lastDynamicCategory: string | undefined;
  private sessionCtx: ExtensionContext | null = null;

  constructor(cfg: Config, cache: Cache, limits: Map<string, RateLimit>) {
    this.cfg = cfg;
    this.cache = cache;
    this.limits = limits;
  }

  setSessionCtx(ctx: ExtensionContext | null): void {
    this.sessionCtx = ctx;
  }

  /**
   * Point the router at a new cache object.
   *
   * index.ts REPLACES its `cache` variable on every reload path (loadCache,
   * discoverKeys, saveCache) and notifies metrics and the rate-limit manager.
   * The router was never notified, so it kept reading the object it was
   * constructed with — discovered models, exclude lookups, dedup and health
   * data all silently went stale for the rest of the session. Every place
   * that reassigns index.ts's cache must call this.
   */
  updateCache(cache: Cache): void {
    this.cache = cache;
  }

  // ── Model Discovery ─────────────────────────────────────────────────────

  /**
   * Apply the global exclude rules to a list of refs. Delegates to
   * src/exclude.ts so the live /router table reflects the same filtering
   * as generateDynamicConfig.
   */
  private applyExcludes(refs: string[]): string[] {
    if (!this.cfg.exclude) return refs;
    return refs.filter((ref) => !isExcluded(ref, { rules: this.cfg.exclude!, cfg: this.cfg, cache: this.cache }));
  }

  /**
   * Returns all discovered model references
   */
  allDiscoveredRefs(): string[] {
    const refs = new Set<string>();
    
    // ALWAYS include models from Pi's model registry if available
    // This is the primary source of truth for available models
    if (this.sessionCtx?.modelRegistry) {
      for (const model of this.sessionCtx.modelRegistry.getAvailable()) {
        refs.add(`${model.provider}/${model.id}`);
      }
    } else if (this.cache.available_models) {
      // Fallback to cached models if no session context
      for (const m of this.cache.available_models) {
        refs.add(`${m.provider}/${m.id}`);
      }
    }
    
    // Also include free models from configuration (e.g., openrouter free tier)
    // These might not be in the registry but are available via the provider
    for (const [provId, provConfig] of Object.entries(this.cfg.providers ?? {})) {
      if (provConfig.free_models && Array.isArray(provConfig.free_models)) {
        for (const freeModel of provConfig.free_models) {
          refs.add(freeModel);
        }
      }
    }

    // Honour the user's explicit --models/enabledModels scoping (pi-ai 0.83.0+).
    // Without this, the router could route to a model the user deliberately
    // excluded from the session. Empty scopedModels means no scoping is
    // configured, so every discovered ref stays eligible.
    const scoped = this.sessionCtx?.scopedModels;
    if (scoped && scoped.length > 0) {
      const allowed = new Set(scoped.map((s) => `${s.model.provider}/${s.model.id}`));
      for (const ref of refs) {
        if (!allowed.has(ref)) refs.delete(ref);
      }
    }
    
    // Apply global exclude rules (paid OpenRouter models, *fable*, etc.)
    // so the live /router table matches generateDynamicConfig output.
    let result = [...refs];
    if (this.cfg.exclude) {
      result = this.applyExcludes(result);
    }
    return result;
  }

  // ── Filtering ─────────────────────────────────────────────────────────────

  /**
   * Filters models by budget availability (subscription providers)
   * Uses cached budget info for synchronous operation
   */
  filterByBudget(refs: string[]): string[] {
    // Delegate to the single source of truth in budget.ts.
    // Previously this duplicated hasModelBudget (index.ts) with identical logic;
    // both now go through hasBudget() so the rule lives in one place.
    if (!this.cache.budget_cache) return refs;
    return refs.filter((ref) =>
      hasBudget(ref, this.cfg.providers, this.cache.budget_cache)
    );
  }

  /**
   * Filters models by availability (not rate-limited)
   */
  filterAvailable(refs: string[], activeKeyIdx: Record<string, number> = {}): string[] {
    return refs.filter((r) => {
      if (this.isLimited(r)) return false;
      const prov = r.split('/')[0];
      const idx = activeKeyIdx[prov] ?? 0;
      if (
        this.cache.exhausted_keys?.[`${prov}:${idx}`] &&
        Date.now() < this.cache.exhausted_keys[`${prov}:${idx}`]
      ) {
        return false;
      }
      return true;
    });
  }

  /**
   * Filters models by GDPval percentile
   */
  filterByQualityPct(refs: string[], pct: number): string[] {
    if (!refs.length || pct <= 0) return refs;
    const gdps = refs.map((r) => getM(r).gdpval).sort((a, b) => a - b);
    const idx = Math.floor((pct / 100) * (gdps.length - 1));
    const threshold = gdps[idx];
    return refs.filter((r) => getM(r).gdpval >= threshold);
  }

  /**
   * Filters models by minimum GDPval
   */
  filterByQualityMin(refs: string[], min: number): string[] {
    if (!refs.length || min <= 0) return refs;
    const filtered = refs.filter((r) => getM(r).gdpval >= min);
    return filtered.length ? filtered : refs;
  }

  // ── Sorting ───────────────────────────────────────────────────────────────

  /**
   * Sorts models by various methods
   * For 'best', multi-metric scoring is used
   */
  sortBy(models: string[], method: string, taskType?: string): string[] {
    const s = [...models];
    if (method === 'min_latency')
      return s.sort((a, b) => getM(a).avg_latency_ms - getM(b).avg_latency_ms);
    if (method === 'max_throughput')
      return s.sort((a, b) => getM(b).throughput_tps - getM(a).throughput_tps);
    if (method === 'min_cost')
      return this.sortByMinCost(s);
    if (method === 'min_cost_if_all_priced')
      return this.sortByMinCostIfAllPriced(s);
    if (method === 'max_gdpval') 
      return s.sort((a, b) => getM(b).gdpval - getM(a).gdpval);
    if (method === 'best') {
      // Multi-metric scoring for 'best' method
      return s.sort((a, b) => {
        const scoreB = calculateScore(b, taskType, this.cfg);
        const scoreA = calculateScore(a, taskType, this.cfg);
        return scoreB - scoreA;
      });
    }
    if (method === 'billing_preference') return this.sortByBillingPreference(s);
    if (method === 'roundrobin') return s;
    return s;
  }

  /**
   * Sorts models by billing preference
   */
  sortByBillingPreference(refs: string[], billingPreference: 'default' | 'local_first' = 'default'): string[] {
    return [...refs].sort((a, b) => {
      const ta = billingTier(a),
        tb = billingTier(b);
      // "local_first" override: rank local models (tier 2) AHEAD of
      // subscription models (tier 1), but keep truly-free models (tier 0)
      // on top. payg (tier 3) stays last. Only affects this group's sort.
      const ra = billingPreference === 'local_first' ? (ta === 2 ? 0.5 : ta) : ta;
      const rb = billingPreference === 'local_first' ? (tb === 2 ? 0.5 : tb) : tb;
      if (ra !== rb) return ra - rb;
      // Within subscription tier, prefer lower rate-limit pressure first, then cost
      if (ta === 1) {
        const pa = this.limitSecs(a),
          pb = this.limitSecs(b);
        if (pa !== pb) return pa - pb;
      }
      const costA = effCost(a);
      const costB = effCost(b);
      // Handle 'unknown' costs - treat them as equal, fall through to gdpval tiebreaker
      if (costA !== 'unknown' || costB !== 'unknown') {
        if (costA === 'unknown') return 1; // unknown costs go to the end
        if (costB === 'unknown') return -1;
        if (costA !== costB) return costA - costB;
      }
      // Cost ties (e.g. all $0.0 subscription/local models) would otherwise fall
      // through to Array.sort's stable order, i.e. registry insertion order — not
      // a ranking. Prefer higher-quality models when cost cannot discriminate.
      return getM(b).gdpval - getM(a).gdpval;
    });
  }

  /**
   * Sorts models by minimum cost
   * Models with unknown costs are sorted to the end
   */
  sortByMinCost(refs: string[]): string[] {
    return [...refs].sort((a, b) => {
      const costA = effCost(a);
      const costB = effCost(b);
      
      // Handle 'unknown' costs - treat them as equal and sort by GDPval as tiebreaker
      if (costA === 'unknown' && costB === 'unknown') {
        return getM(b).gdpval - getM(a).gdpval;
      }
      if (costA === 'unknown') return 1; // unknown costs go to the end
      if (costB === 'unknown') return -1;
      
      // Both have known costs
      const diff = costA - costB;
      if (diff !== 0) return diff;
      // Tiebreaker: higher GDPval first
      return getM(b).gdpval - getM(a).gdpval;
    });
  }

  /**
   * Sorts models by minimum cost only if ALL models have known prices
   * Otherwise falls back to sorting by GDPval (best first)
   */
  sortByMinCostIfAllPriced(refs: string[]): string[] {
    const s = [...refs];
    
    // Check if all models have known costs
    const allPriced = s.every(ref => {
      const cost = effCost(ref);
      return cost !== 'unknown';
    });
    
    if (allPriced) {
      // All models have known costs - sort by cost
      return this.sortByMinCost(s);
    } else {
      // Not all models have known costs - fall back to GDPval
      return s.sort((a, b) => getM(b).gdpval - getM(a).gdpval);
    }
  }

  // ── Resolution ────────────────────────────────────────────────────────

  /**
   * Resolves a model group to a single selected model + ordered candidate list,
   * with cascading fallback to the group's `fallback_groups`.
   *
   * RESPONSIBILITY: the public entry point for "which model should answer this
   * prompt, for a named group". Handles the dynamic-group short-circuit (the
   * dynamic group is resolved at prompt time by the classifier hook, not here)
   * and the fallback cascade — but delegates the per-group candidate
   * building to {@link resolveGroup}.
   *
   * INPUT CONTRACT: `name` must be a key in `cfg.model_groups`. The group's
   * own `fallback_groups` (if any) are tried in order after the primary group
   * returns no usable candidates. Cycles in fallback_groups are the caller's
   * responsibility to prevent (auto-generated lists include every group, so
   * mutual references are common — resolved by the `visited` set in
   * driveStream, NOT here).
   *
   * OUTPUT CONTRACT: returns `{ selected, candidates }` for the FIRST group
   * (primary or fallback) that yields a non-empty candidate list, or `null` if
   * every group in the cascade is empty. `selected` is `candidates[0]`.
   *
   * SIDE EFFECTS: none directly. {@link resolveGroup} reads/writes rate-limit
   * state, budget cache, and model-health state via the shared modules.
   *
   * INVARIANTS:
   *   - `method: 'dynamic'` groups always return `null` here (never selected
   *     via this path).
   *   - A non-null result is always the primary group's result if the primary
   *     group had candidates; fallback groups are only consulted on empty.
   *
   * Uses multi-metric scoring for 'best' method (via resolveGroup).
   */
  resolve(name: string): GroupResolution | null {
    const g = this.cfg.model_groups[name];
    if (!g) return null;

    // Dynamic group is handled by the hook, not here
    if (g.method === 'dynamic') return null;

    // Try primary group first
    let result = this.resolveGroup(g, name);
    if (result) return result;

    // Cascading fallback to fallback_groups
    for (const fbGroupName of g.fallback_groups ?? []) {
      const fbGroup = this.cfg.model_groups[fbGroupName];
      if (!fbGroup) continue;
      const fbResult = this.resolveGroup(fbGroup, fbGroupName);
      if (fbResult) return fbResult;
    }

    return null;
  }

  /**
   * Deduplicate model refs that refer to the SAME underlying model.
   * Models that match the same GDPval slug (via LLM or slug-matcher) are
   * the same model — e.g. mistral-medium-2604, mistral-medium-latest, and
   * mistral-medium-3-5 are all the same model. Keep only the best one
   * (highest priority by current sort order = first occurrence).
   *
   * Also deduplicates cross-provider: if mistral-zai/glm-5-2 and
   * mistral/glm-5-2 both match slug glm-5-2, keep both (they're different
   * providers offering the same model — useful for failover).
   * Wait — actually for dedup we want to keep different PROVIDERS but
   * remove different VERSIONS of the same model from the same provider.
   */
  private dedupByModelIdentity(refs: string[]): string[] {
    const seen = new Map<string, string>(); // provider:slug → best ref
    const result: string[] = [];
    for (const ref of refs) {
      const slug = getMatchedSlug(ref);
      if (slug) {
        // Same slug + same provider = duplicate (different version of same model)
        const provider = ref.split('/')[0];
        const key = `${provider}:${slug}`;
        const existing = seen.get(key);
        if (existing) {
          // Already have this model — keep the BETTER variant.
          // Prefer versioned (e.g. mistral-medium-2604) over -latest,
          // because -latest is an alias that changes when a new version is
          // released, while the versioned ID stays reproducible.
          if (this.isBetterModelVariant(ref, existing)) {
            // Replace the existing entry with the better variant
            const idx = result.indexOf(existing);
            if (idx !== -1) result[idx] = ref;
            seen.set(key, ref);
          }
          continue;
        }
        seen.set(key, ref);
      }
      result.push(ref);
    }
    return result;
  }

  /**
   * Cluster candidates that resolve to the SAME GDPval slug so they end up
   * ADJACENT in the list, without changing the relative order of different
   * slugs (a slug's cluster is inserted at the position of its first, i.e.
   * best-ranked, occurrence).
   *
   * WHY: dedupByModelIdentity deliberately keeps cross-provider duplicates
   * of the same model (e.g. mistral/zai-glm-5-2, mistral-zai/zai-glm-5-2,
   * openrouter/z-ai/glm-5.2:free all match slug glm-5-2) — that's useful
   * variability, not noise. But nothing GUARANTEES those duplicates stay
   * adjacent after sorting/tie-breaking, so a failover walk isn't reliably
   * "try every provider of this model before moving to a different model".
   * This pass makes that guarantee explicit.
   *
   * ORDERING WITH HEALTH: must run BEFORE demoteUnhealthy, not after.
   * demoteUnhealthy partitions into healthy-first/unhealthy-last and
   * preserves order WITHIN each partition — so composing as
   * `demoteUnhealthy(coalesceBySlug(refs))` clusters same-slug entries
   * within each health partition separately. A persistently broken
   * candidate never jumps back to the front just because a healthy sibling
   * with the same slug ranks well; the reverse order would defeat health
   * tracking entirely.
   */
  private coalesceBySlug(refs: string[]): string[] {
    const order: string[] = [];
    const groups = new Map<string, string[]>();
    for (const ref of refs) {
      // Unmatched refs (no slug) each get their own singleton group, keyed
      // by the ref itself, so they pass through unchanged and unclustered.
      const key = getMatchedSlug(ref) ?? ref;
      let group = groups.get(key);
      if (!group) {
        group = [];
        groups.set(key, group);
        order.push(key);
      }
      group.push(ref);
    }
    const result: string[] = [];
    for (const key of order) result.push(...groups.get(key)!);
    return result;
  }

  /**
   * Determine if a model ref is a BETTER variant than another.
   * Used by dedupByModelIdentity to pick the best among duplicates.
   *
   * Preference order (highest first):
   * 1. Versioned (has a date or version number): mistral-medium-2604
   * 2. Explicit version name: mistral-medium-3.5
   * 3. -latest (alias, least preferred): mistral-medium-latest
   */
  private isBetterModelVariant(ref: string, than: string): boolean {
    const refModel = ref.split('/').pop() ?? ref;
    const thanModel = than.split('/').pop() ?? than;
    const refScore = this.modelVariantPreference(refModel);
    const thanScore = this.modelVariantPreference(thanModel);
    return refScore > thanScore;
  }

  /**
   * Score a model variant by preference (higher = better to keep).
   * 3 = versioned (date or number suffix), 2 = explicit version name, 1 = -latest
   */
  private modelVariantPreference(modelId: string): number {
    // -latest suffix = alias, least preferred (changes when new version released)
    if (/-(latest|preview)$/i.test(modelId)) return 1;
    // Date suffix (YYMM or YYYYMMDD) = versioned, most preferred (reproducible)
    if (/-(?:\d{4}|\d{6}|\d{8})$/i.test(modelId)) return 3;
    // Version number (e.g. -3.5, -3-5, -5-2) = explicit version name
    if (/[-.]\d/i.test(modelId)) return 2;
    // No version info = keep as-is (score 0)
    return 0;
  }

  /**
   * Builds the ordered candidate list for ONE group, applying the group's raw
   * cost constraints (max_cost / max_cost_per_m).
   *
   * RESPONSIBILITY: the per-group candidate builder used by the live selection
   * path ({@link resolve}). Builds the ordered candidate list for a single
   * group, applying exclude rules → min_gdpval floor → budget availability →
   * dedup by model identity → cost constraints → sort by the group's method.
   * One of the three group-candidate paths (A1) — the live selection path. The
   * display path ({@link getTopModels}) and the snapshot path
   * (generateDynamicConfig) are the other two. (A fourth path,
   * resolveGroupWithCostTier, was removed with the cost-tier system.)
   *
   * INPUT CONTRACT: `g` is a single group config. `g.models`, if present, is an
   * ALLOW-LIST (only those refs considered), NOT a priority list — this is the
   * opposite of generateDynamicConfig's use of `g.models`.
   *
   * OUTPUT CONTRACT: `{ selected, candidates }` ordered by `g.method`, or
   * `null` if no model fits. `selected` is `candidates[0]`.
   *
   * SIDE EFFECTS: reads rate-limit state, budget cache (via {@link filterBudget}),
   * and model-health (demoteUnhealthy). Does NOT mutate them.
   *
   * INVARIANTS:
   *   - Deduplicated by model identity (versioned variants win over -latest).
   *   - `max_cost` with unknown cost: included iff provider is NOT pay_per_token
   *     (subscription/local = sunk cost), excluded for pay_per_token (genuinely
   *     unknown price). This handling must be preserved on consolidation.
   *   - Unhealthy models demoted to the end, after healthy candidates.
   */
  private resolveGroup(g: Group, name: string): GroupResolution | null {
    // When a group has an explicit models list, use only those models.
    // Fall back to allDiscoveredRefs() for groups without an explicit list.
    // This matches getTopModels() behavior for consistency.
    let c: string[];
    if (g.models?.length) {
      c = this.allDiscoveredRefs().filter(ref => g.models!.includes(ref));
    } else {
      c = this.allDiscoveredRefs();
    }

    // Shared method-independent filters (A1): exclude_providers, exclude_models,
    // min_gdpval/pct, max_cost, max_cost_per_m. Unknown-cost handling is
    // billing-aware (subscription/local kept, payg dropped) — see
    // applyGroupFilters INVARIANTS.
    c = applyGroupFilters(c, g, this.cfg, false);

    // Filter by budget availability (subscription providers)
    // This ensures we only use models with remaining tokens in their window
    c = this.filterByBudget(c);

    // Deduplicate: remove models that are the SAME underlying model
    // (e.g. mistral-medium-2604 and mistral-medium-latest both match
    // slug mistral-medium-3-5 — keep only the first one)
    c = this.dedupByModelIdentity(c);

    // Sorting.
    //
    // Health demotion runs as part of ranking, BEFORE any top_k truncation.
    // Order matters: slicing first can leave a window that contains only
    // unhealthy models, and demoting within an already-broken subset merely
    // reorders it — the same failing model still ends up at rank 0, which is
    // exactly what health tracking exists to prevent.
    // Coalesce before demoteUnhealthy so same-slug variants are adjacent
    // and stay together when health demotion splits into healthy/unhealthy buckets.
    const rank = (refs: string[]): string[] => demoteUnhealthy(this.cache, this.coalesceBySlug(refs));

    if (g.method === 'best') {
      // Multi-metric scoring for 'best' method
      // taskType is the group name - only 'code' triggers code-specific weighting
      c = rank(this.sortBy(c, 'best', name));
    } else if (g.method === 'tiered') {
      // Quality-gated + billing preference
      c = rank(this.sortByBillingPreference(c, g.billing_preference));
    } else if (g.method === 'pipeline' && g.pipeline) {
      for (const step of g.pipeline) {
        c = rank(this.sortBy(c, step.method, name));
        if (step.top_k && step.top_k < c.length) c = c.slice(0, step.top_k);
      }
    } else if (g.method === 'roundrobin') {
      const i = (this.rrCounters[name] ?? 0) % c.length;
      this.rrCounters[name] = i + 1;
      c = rank([...c.slice(i), ...c.slice(0, i)]);
    } else if (g.method === 'min_cost_if_all_priced') {
      c = rank(this.sortBy(c, 'min_cost_if_all_priced', name));
      if (g.top_k && g.top_k < c.length) c = c.slice(0, g.top_k);
    } else {
      c = rank(this.sortBy(c, g.method, name));
      if (g.top_k && g.top_k < c.length) c = c.slice(0, g.top_k);
    }

    if (c.length === 0) return null;
    return { selected: c[0], candidates: c };
  }

  // ── Group Detection ─────────────────────────────────────────────────────

  /**
   * Detects the group for a model reference based on GDPval thresholds
   */
  detectGroup(ref: string): string | null {
    if (this.activeGroup) return this.activeGroup;
    
    // With dynamic model discovery, detect group based on GDPval thresholds
    const gdpval = lookupGdp(ref);
    
    // Check groups by GDPval threshold (highest first)
    const groupsByThreshold = Object.entries(this.cfg.model_groups)
      .filter(([_, g]) => g.method !== 'dynamic')
      .sort(([, a], [, b]) => (b.min_gdpval ?? 0) - (a.min_gdpval ?? 0));
    
    if (gdpval !== null) {
      for (const [name, g] of groupsByThreshold) {
        const minGdpval = g.min_gdpval ?? 0;
        if (gdpval >= minGdpval) {
          return name;
        }
      }
    }
    
    // Fallback: return lowest tier that has no min_gdpval requirement
    for (const name of ['scout', 'operational', 'tactical', 'strategic', 'fallback']) {
      const g = this.cfg.model_groups[name];
      if (g && (g.min_gdpval === undefined || g.min_gdpval === 0)) {
        return name;
      }
    }
    
    return null;
  }

  // ── Rate Limit ─────────────────────────────────────────────────────────────

  /**
   * Checks whether a reference is currently rate-limited
   */
  isLimited(ref: string): boolean {
    const limit = this.limits.get(ref);
    if (!limit) return false;
    if (Date.now() >= limit.cooldown_until) {
      this.limits.delete(ref);
      return false;
    }
    return true;
  }

  /**
   * Returns the remaining seconds of the rate limit
   */
  limitSecs(ref: string): number {
    const limit = this.limits.get(ref);
    return limit ? Math.max(0, Math.ceil((limit.cooldown_until - Date.now()) / 1000)) : 0;
  }

  // ── Top Models ────────────────────────────────────────────────────────────

  /**
   * Returns the top-N models for a group, for DISPLAY only (the `/router` table).
   *
   * RESPONSIBILITY: feed the `/router <group>` and `/router` overview UI.
   * This is NOT the live selection path — {@link resolveGroup} decides which
   * model actually answers a prompt. getTopModels exists to show the
   * user what WOULD be picked, in display order. It is the second of the three
   * group-candidate paths (A1) — the display path. It historically diverged from the live paths (it
   * missed dedup, billing_preference, and the unknown-cost handling) — those
   * were reconciled in earlier sessions, but the structural duplication
   * remains: it re-implements the filter+sort pipeline instead of calling the
   * live resolvers. Consolidation pending.
   *
   * INPUT CONTRACT: `groupName` is a group key; `n` is the display cap (top N).
   * `g.models` is IGNORED here (unlike the live paths) — the display always
   * reflects allDiscoveredRefs() filtered by the group's criteria, never a
   * pinned allow-list, so newly-discovered models show up immediately even
   * before generateDynamicConfig rewrites dynamic.json. This is intentional:
   * the display should be live, the persisted file may be stale.
   *
   * OUTPUT CONTRACT: returns `{ ref, limited, rank }[]` capped at `n`, empty
   * array on unknown group or dynamic group. `rank` is 0-based display rank.
   * Unlike the live resolvers, this NEVER returns null — an empty group shows
   * as an empty table.
   *
   * SIDE EFFECTS: reads rate-limit state (isLimited → marks `limited: true` in
   * the result, and splits available/limited into two buckets). Does NOT
   * mutate any state.
   *
   * INVARIANTS:
   *   - Available (non-limited) models come first, then limited ones, so the
   *     display highlights what's actually usable right now.
   *   - Deduplicated by model identity, same as the live paths (this was the
   *     bug fixed in an earlier session — display showed every alias as a
   *     separate row even though live selection had deduped).
   *   - `method: 'dynamic'` groups return `[]` (they're resolved at prompt
   *     time by the classifier, not enumerable as a static list).
   */
  getTopModels(groupName: string, n: number): ModelWithLimits[] {
    const g = this.cfg.model_groups[groupName];
    if (!g) return [];
    if (g.method === 'dynamic') return []; // resolved at prompt-time via classifier

    // Use all discovered models (from Pi's registry + free_models + cached)
    // Groups are filtered by min_gdpval and other criteria, not by explicit model lists.
    // This ensures /router reflects all available models dynamically.
    let c = this.allDiscoveredRefs();

    // Shared method-independent filters (A1): same pipeline as resolveGroup and
    // generateDynamicConfig. The display path previously diverged here — it
    // dropped ALL unknown-cost models, so `/router` showed models the live path
    // would keep (subscription/local = sunk cost). Now billing-aware, matching
    // the live resolver. Dedup runs here (display path dedups, like live).
    c = applyGroupFilters(c, g, this.cfg, true, (r) => this.dedupByModelIdentity(r));

    if (g.method === 'best') {
      c = this.sortBy(c, 'max_gdpval');
    } else if (g.method === 'tiered') {
      c = this.sortByBillingPreference(c, g.billing_preference);
    } else if (g.method === 'pipeline' && g.pipeline) {
      for (let i = 0; i < g.pipeline.length; i++) {
        const step = g.pipeline[i];
        // Demote before the step's top_k slice — see resolveGroup for why.
        c = demoteUnhealthy(this.cache, this.sortBy(c, step.method));
        const isLastStep = i === g.pipeline.length - 1;
        if (step.top_k && step.top_k < c.length && !isLastStep) c = c.slice(0, step.top_k);
      }
    } else if (g.method === 'min_cost_if_all_priced') {
      c = this.sortBy(c, 'min_cost_if_all_priced');
    } else {
      c = this.sortBy(c, g.method);
    }

    // Collapse cross-provider same-slug entries to ONE row (the best-ranked
    // variant). Users see "which models are available", not "which providers
    // offer which variant of which model" — the latter is noise when all
    // variants score identically. The routing/failover path (resolveGroup's
    // rank closure above) keeps all variants internally, so failover still
    // tries every provider in order before moving to the next model.

    // Collapse to ONE row per slug. Pick the best representative per cluster:
    // prefer a non-limited variant (model is actually usable via that provider)
    // over a limited one. When all variants of a slug are limited, any one
    // serves as the representative — it correctly lands in the limited bucket.
    c = this.coalesceBySlug(c);
    {
      // Map: slug key -> best representative ref (non-limited wins).
      const representative = new Map<string, string>();
      for (const ref of c) {
        const key = getMatchedSlug(ref) ?? ref;
        if (!representative.has(key)) {
          representative.set(key, ref); // first = best-ranked by score
        } else if (this.isLimited(representative.get(key)!) && !this.isLimited(ref)) {
          representative.set(key, ref); // swap in healthy sibling
        }
      }
      // Map each slug cluster to its representative, then dedupe to one per slug.
      const seen = new Set<string>();
      c = c
        .map((ref) => representative.get(getMatchedSlug(ref) ?? ref) ?? ref)
        .filter((ref) => {
          if (seen.has(ref)) return false;
          seen.add(ref);
          return true;
        });
    }
    const avail = demoteUnhealthy(this.cache, c.filter((ref) => !this.isLimited(ref)));
    const limited = c.filter((ref) => this.isLimited(ref));
    const ranked = [...avail, ...limited];
    return ranked.slice(0, n).map((ref, i) => ({ ref, limited: this.isLimited(ref), rank: i }));
  }

  // ── Getter ────────────────────────────────────────────────────────────────

  getActiveGroup(): string | null {
    return this.activeGroup;
  }

  getCurModel(): string {
    return this.curModel;
  }

  getLastDynamicModel(): string {
    return this.lastDynamicModel;
  }

  getLastDynamicCategory(): string | undefined {
    return this.lastDynamicCategory;
  }

  setActiveGroup(group: string | null): void {
    this.activeGroup = group;
  }

  setCurModel(model: string): void {
    this.curModel = model;
  }

  setLastDynamicModel(model: string): void {
    this.lastDynamicModel = model;
  }

  setLastDynamicCategory(category: string | undefined): void {
    this.lastDynamicCategory = category;
  }
}
