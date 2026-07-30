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
} from './types.js';
import { splitRef, stripProvider, norm, baseTokens } from './utils.js';
import { PROVIDER_MAP } from './providers.js';
import { getM, lookupGdp, billingTier, effCost, costMux, lookupPrice, calculateScore } from './metrics.js';
import {
  CostTier,
  CostTierConfig,
  getModelCostTier,
  modelFitsCostTier,
  getCostTierForCategory,
  DEFAULT_COST_TIERS,
  getCostTiersFromConfig
} from './cost-tiers.js';
import { getGroupForCategory } from './content-classifier.js';
import { BudgetTracker, initBudgetTracker } from './budget-tracker.js';

// ── Constants ────────────────────────────────────────────────────────────

const SUB_DISCOUNT = 0.5; // Subscription discount factor

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
  private budgetTracker: BudgetTracker | null = null;

  constructor(cfg: Config, cache: Cache, limits: Map<string, RateLimit>) {
    this.cfg = cfg;
    this.cache = cache;
    this.limits = limits;
    this.budgetTracker = initBudgetTracker(cfg, cache);
  }

  setSessionCtx(ctx: ExtensionContext | null): void {
    this.sessionCtx = ctx;
  }

  // ── Model Discovery ─────────────────────────────────────────────────────

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
    
    return [...refs];
  }

  // ── Filtering ─────────────────────────────────────────────────────────────

  /**
   * Filters models by budget availability (subscription providers)
   * Uses cached budget info for synchronous operation
   */
  filterByBudget(refs: string[]): string[] {
    if (!this.budgetTracker || !this.cache.budget_cache) return refs;
    
    const result: string[] = [];
    for (const ref of refs) {
      const prov = ref.split('/')[0];
      
      // Local providers always have budget
      if (PROVIDER_MAP[prov]?.local) {
        result.push(ref);
        continue;
      }
      
      // Pay-per-token providers always have budget (limited by money, not tokens)
      const billing = this.cfg.providers?.[prov]?.billing ?? PROVIDER_MAP[prov]?.billing ?? 'pay_per_token';
      if (billing === 'pay_per_token') {
        result.push(ref);
        continue;
      }
      
      // Subscription providers: check cached budget
      const budget = this.cache.budget_cache[prov];
      if (!budget) {
        // If no cached budget info, assume available (conservative)
        result.push(ref);
        continue;
      }
      
      // Check if we're still in the same window
      const now = Date.now();
      if (budget.window_reset && now >= budget.window_reset) {
        // Window has reset, but we haven't refreshed yet - assume available
        result.push(ref);
        continue;
      }
      
      // Check remaining tokens
      if ((budget.remaining_tokens ?? 0) > 0) {
        result.push(ref);
      }
    }
    return result;
  }
  
  /**
   * Async version that refreshes budget info from APIs
   */
  async filterByBudgetAsync(refs: string[]): Promise<string[]> {
    if (!this.budgetTracker) return refs;
    
    const result: string[] = [];
    for (const ref of refs) {
      if (await this.budgetTracker.hasBudget(ref)) {
        result.push(ref);
      }
    }
    return result;
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
  sortByBillingPreference(refs: string[]): string[] {
    return [...refs].sort((a, b) => {
      const ta = billingTier(a),
        tb = billingTier(b);
      if (ta !== tb) return ta - tb;
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
   * Resolves a model group
   * Uses multi-metric scoring for 'best' method
   */
  resolve(name: string): GroupResolution | null {
    const g = this.cfg.model_groups[name];
    if (!g) return null;

    // Dynamic group is handled by the hook, not here
    if (g.method === 'dynamic') return null;

    // Try primary group first
    let result = this.resolveGroup(g, name);
    if (result) return result;

    // Kaskadierender Fallback zu fallback_groups
    for (const fbGroupName of g.fallback_groups ?? []) {
      const fbGroup = this.cfg.model_groups[fbGroupName];
      if (!fbGroup) continue;
      const fbResult = this.resolveGroup(fbGroup, fbGroupName);
      if (fbResult) return fbResult;
    }

    return null;
  }

  /**
   * Resolves a group with cost tier filter and fallback cascade
   */
  private resolveGroupWithCostTier(g: Group, name: string, costTier: CostTier, tierConfig: CostTierConfig, staticFreeModels: string[]): GroupResolution | null {
    // Get models for this group
    let c: string[];
    if (g.models?.length) {
      c = this.allDiscoveredRefs().filter(ref => g.models!.includes(ref));
    } else {
      c = this.allDiscoveredRefs();
    }
    
    // Filter out excluded providers
    if (g.exclude_providers?.length) {
      c = c.filter(ref => {
        const provider = ref.split('/')[0];
        return !g.exclude_providers!.includes(provider);
      });
    }
    
    // Filter out excluded models
    if (g.exclude_models?.length) {
      c = c.filter(ref => !g.exclude_models!.includes(ref));
    }

    // Apply the same quality floor that resolve() applies (min_gdpval)
    if (g.min_gdpval != null) c = this.filterByQualityMin(c, g.min_gdpval);
    else if (g.min_gdpval_pct != null) c = this.filterByQualityPct(c, g.min_gdpval_pct);

    // Apply cost tier filter
    const filtered = c.filter(ref => {
      return modelFitsCostTier(ref, costTier, tierConfig, staticFreeModels);
    });

    if (filtered.length === 0) return null;

    // Sort by group method
    let sorted = [...filtered];
    if (g.method === 'best') {
      sorted = this.sortBy(sorted, 'best', name);
    } else if (g.method === 'tiered') {
      sorted = this.sortByBillingPreference(sorted);
    } else if (g.method === 'min_cost') {
      sorted = this.sortBy(sorted, 'min_cost', name);
    } else if (g.method === 'min_cost_if_all_priced') {
      sorted = this.sortBy(sorted, 'min_cost_if_all_priced', name);
    } else {
      sorted = this.sortBy(sorted, g.method, name);
    }
    return { selected: sorted[0], candidates: sorted };
  }

  /**
   * Resolves a single group (without fallback cascade)
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
    
    // Filter out excluded providers
    if (g.exclude_providers?.length) {
      c = c.filter(ref => {
        const provider = ref.split('/')[0];
        return !g.exclude_providers!.includes(provider);
      });
    }
    
    // Filter out excluded models
    if (g.exclude_models?.length) {
      c = c.filter(ref => !g.exclude_models!.includes(ref));
    }
    
    // Filter by quality
    if (g.min_gdpval != null) c = this.filterByQualityMin(c, g.min_gdpval);
    else if (g.min_gdpval_pct != null) c = this.filterByQualityPct(c, g.min_gdpval_pct);

    // Filter by budget availability (subscription providers)
    // This ensures we only use models with remaining tokens in their window
    c = this.filterByBudget(c);

    // Filter by cost (if configured)
    if (g.max_cost !== undefined) {
      c = c.filter(ref => {
        const cost = effCost(ref);
        // Exclude models with unknown costs when filtering by max_cost
        if (cost === 'unknown') return false;
        return cost <= g.max_cost!;
      });
    }
    if (g.max_cost_per_m !== undefined) {
      c = c.filter(ref => {
        const price = lookupPrice(ref);
        // Exclude models with unknown prices
        if (!price) return false;
        if (price.input === 'unknown' || price.output === 'unknown') return false;
        return price.input <= g.max_cost_per_m!;
      });
    }

    // Sorting
    if (g.method === 'best') {
      // Multi-metric scoring for 'best' method
      // taskType is the group name - only 'code' triggers code-specific weighting
      c = this.sortBy(c, 'best', name);
    } else if (g.method === 'tiered') {
      // Quality-gated + billing preference
      c = this.sortByBillingPreference(c);
    } else if (g.method === 'pipeline' && g.pipeline) {
      for (const step of g.pipeline) {
        c = this.sortBy(c, step.method, name);
        if (step.top_k && step.top_k < c.length) c = c.slice(0, step.top_k);
      }
    } else if (g.method === 'roundrobin') {
      const i = (this.rrCounters[name] ?? 0) % c.length;
      this.rrCounters[name] = i + 1;
      c = [...c.slice(i), ...c.slice(0, i)];
    } else if (g.method === 'min_cost_if_all_priced') {
      c = this.sortBy(c, 'min_cost_if_all_priced', name);
      if (g.top_k && g.top_k < c.length) c = c.slice(0, g.top_k);
    } else {
      c = this.sortBy(c, g.method, name);
      if (g.top_k && g.top_k < c.length) c = c.slice(0, g.top_k);
    }
    
    if (c.length === 0) return null;
    return { selected: c[0], candidates: c };
  }

  // ── Cost Tier Methods ──────────────────────────────────────────────────

  /**
   * Returns the cost tier configuration
   */
  getCostTiers(): Record<CostTier, CostTierConfig> {
    return getCostTiersFromConfig(this.cfg);
  }

  /**
   * Resolves a model group with cost tier filter
   * @param name - Group name
   * @param costTier - Cost tier (optional, extracted from group)
   * @returns GroupResolution or null
   */
  resolveWithCostTier(name: string, costTier?: CostTier): GroupResolution | null {
    const g = this.cfg.model_groups[name];
    if (!g) return null;

    // If a cost tier is specified, filter by it
    if (costTier) {
      const tierConfig = this.getCostTiers()[costTier];
      if (!tierConfig) return null;

      // Extract static free_models from the configuration
      const staticFreeModels: string[] = [];
      for (const [provId, provConfig] of Object.entries(this.cfg.providers ?? {})) {
        if (provConfig.free_models && Array.isArray(provConfig.free_models)) {
          for (const model of provConfig.free_models) {
            const normalized = model.startsWith(`${provId}/`) ? model : `${provId}/${model}`;
            staticFreeModels.push(normalized);
          }
        }
      }

      // Try primary group with cost tier filter
      let result = this.resolveGroupWithCostTier(g, name, costTier, tierConfig, staticFreeModels);
      if (result) return result;

      // Kaskadierender Fallback zu fallback_groups (MIT cost tier filter)
      for (const fbGroupName of g.fallback_groups ?? []) {
        const fbGroup = this.cfg.model_groups[fbGroupName];
        if (!fbGroup) continue;
        const fbResult = this.resolveGroupWithCostTier(fbGroup, fbGroupName, costTier, tierConfig, staticFreeModels);
        if (fbResult) return fbResult;
      }

      console.warn(`[router] No models fit cost tier "${costTier}" for group "${name}" (including fallback groups)`);
    }

    // No cost tier specified - use regular resolve with fallback cascade
    return this.resolve(name);
  }

  /**
   * Resolves a group based on the classification category
   * @param category - Classification category
   * @returns GroupResolution or null
   */
  resolveByCategory(category: string): GroupResolution | null {
    // Get the cost tier and group for this category
    // NOTE: getCostTierForCategory and getGroupForCategory always return a truthy value
    // (with fallback values), so the !costTier || !groupName check is always false
    const costTier = getCostTierForCategory(category as any);
    const groupName = getGroupForCategory(category as any);

    // Try the specific group with cost tier filter first
    const groupResolution = this.resolveWithCostTier(groupName, costTier);
    if (groupResolution) {
      return groupResolution;
    }

    // Fallback: Try without cost tier filter
    const fallbackResolution = this.resolve(groupName);
    if (fallbackResolution) {
      return fallbackResolution;
    }

    // Ultimate Fallback
    return this.resolve('fallback');
  }

  /**
   * Returns the cost tier for a classification category
   */
  getCostTierForCategory(category: string): CostTier {
    return getCostTierForCategory(category as any);
  }

  /**
   * Returns the group for a classification category
   */
  getGroupForCategory(category: string): string {
    return getGroupForCategory(category as any);
  }

  /**
   * Returns the cost tier of a model
   */
  getModelCostTier(modelRef: string): CostTier {
    const staticFreeModels: string[] = [];
    for (const [provId, provConfig] of Object.entries(this.cfg.providers ?? {})) {
      if (provConfig.free_models && Array.isArray(provConfig.free_models)) {
        for (const model of provConfig.free_models) {
          const normalized = model.startsWith(`${provId}/`) ? model : `${provId}/${model}`;
          staticFreeModels.push(normalized);
        }
      }
    }
    return getModelCostTier(modelRef, staticFreeModels);
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
   * Returns the top models for a group
   */
  getTopModels(groupName: string, n: number): ModelWithLimits[] {
    const g = this.cfg.model_groups[groupName];
    if (!g) return [];
    if (g.method === 'dynamic') return []; // resolved at prompt-time via classifier

    // Use all discovered models (from Pi's registry + free_models + cached)
    // Groups are filtered by min_gdpval and other criteria, not by explicit model lists.
    // This ensures /router reflects all available models dynamically.
    let c = this.allDiscoveredRefs();
    
    // Filter out excluded providers
    if (g.exclude_providers?.length) {
      c = c.filter(ref => {
        const provider = ref.split('/')[0];
        return !g.exclude_providers!.includes(provider);
      });
    }
    
    // Filter out excluded models
    if (g.exclude_models?.length) {
      c = c.filter(ref => !g.exclude_models!.includes(ref));
    }
    
    if (g.min_gdpval != null) c = this.filterByQualityMin(c, g.min_gdpval);
    else if (g.min_gdpval_pct != null) c = this.filterByQualityPct(c, g.min_gdpval_pct);

    // Filter by cost constraints (same logic as resolveGroup)
    if (g.max_cost !== undefined) {
      c = c.filter(ref => {
        const cost = effCost(ref);
        if (cost === 'unknown') return false;
        return cost <= g.max_cost!;
      });
    }
    if (g.max_cost_per_m !== undefined) {
      c = c.filter(ref => {
        const price = lookupPrice(ref);
        if (!price) return false;
        if (price.input === 'unknown' || price.output === 'unknown') return false;
        return price.input <= g.max_cost_per_m!;
      });
    }

    if (g.method === 'best') {
      c = this.sortBy(c, 'max_gdpval');
    } else if (g.method === 'tiered') {
      c = this.sortByBillingPreference(c);
    } else if (g.method === 'pipeline' && g.pipeline) {
      for (let i = 0; i < g.pipeline.length; i++) {
        const step = g.pipeline[i];
        c = this.sortBy(c, step.method);
        const isLastStep = i === g.pipeline.length - 1;
        if (step.top_k && step.top_k < c.length && !isLastStep) c = c.slice(0, step.top_k);
      }
    } else if (g.method === 'min_cost_if_all_priced') {
      c = this.sortBy(c, 'min_cost_if_all_priced');
    } else {
      c = this.sortBy(c, g.method);
    }

    const avail = c.filter((ref) => !this.isLimited(ref));
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
