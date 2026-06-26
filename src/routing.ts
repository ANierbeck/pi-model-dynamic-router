// src/routing.ts
// Routing logic for the pi-model-router

import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
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

  constructor(cfg: Config, cache: Cache, limits: Map<string, RateLimit>) {
    this.cfg = cfg;
    this.cache = cache;
    this.limits = limits;
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
    
    // Also include explicitly pinned group models (for backwards compatibility)
    // These might not be in the registry (e.g., free cloud models)
    for (const g of Object.values(this.cfg.model_groups)) {
      for (const r of g.models ?? []) {
        refs.add(r);
      }
    }

    return [...refs];
  }

  // ── Filtering ─────────────────────────────────────────────────────────────

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
      return s.sort((a, b) => effCost(a) - effCost(b) || getM(b).gdpval - getM(a).gdpval);
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
      return effCost(a) - effCost(b);
    });
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

    // Start from allDiscoveredRefs() (which unconditionally includes all g.models
    // entries across all groups, preserving the post-restart fix), then filter to
    // only this group's g.models for strict isolation.
    //
    // Intentional asymmetry with getTopModels():
    //   getTopModels() uses g.models for DISPLAY so /router shows the configured list.
    //   resolve() uses allDiscoveredRefs() for ROUTING which already includes all g.models
    //   entries (lines 81-85), so filtering to g.models preserves both group isolation and
    //   the post-restart fix (models in g.models are in the pool regardless of registry state).
    let c = this.allDiscoveredRefs().filter(ref => g.models?.includes(ref));
    
    // Filter by quality
    if (g.min_gdpval != null) c = this.filterByQualityMin(c, g.min_gdpval);
    else if (g.min_gdpval_pct != null) c = this.filterByQualityPct(c, g.min_gdpval_pct);

    // Filter by cost (if configured)
    if (g.max_cost !== undefined) {
      c = c.filter(ref => effCost(ref) <= g.max_cost!);
    }
    if (g.max_cost_per_m !== undefined) {
      c = c.filter(ref => {
        const price = lookupPrice(ref);
        return price ? price.input <= g.max_cost_per_m! : true;
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
    } else {
      c = this.sortBy(c, g.method, name);
      if (g.top_k && g.top_k < c.length) c = c.slice(0, g.top_k);
    }
    

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

      // Filter models by cost tier (Pool: g.models from allDiscoveredRefs)
      let c = this.allDiscoveredRefs().filter(ref => g.models?.includes(ref));

      // Apply the same quality floor that resolve() applies (min_gdpval)
      if (g.min_gdpval != null) c = this.filterByQualityMin(c, g.min_gdpval);
      else if (g.min_gdpval_pct != null) c = this.filterByQualityPct(c, g.min_gdpval_pct);

      const filtered = c.filter(ref => {
        return modelFitsCostTier(ref, costTier, tierConfig, staticFreeModels);
      });

      if (filtered.length === 0) {
        console.warn(`[router] No models fit cost tier "${costTier}" for group "${name}"`);
        return null;
      }

      // Sort by group method
      let sorted = [...filtered];
      if (g.method === 'best') {
        sorted = this.sortBy(sorted, 'best', name);
      } else if (g.method === 'tiered') {
        sorted = this.sortByBillingPreference(sorted);
      } else if (g.method === 'min_cost') {
        sorted = this.sortBy(sorted, 'min_cost', name);
      } else {
        sorted = this.sortBy(sorted, g.method, name);
      }

      return { selected: sorted[0], candidates: sorted };
    }

    // Default behavior
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
   * Detects the group for a model reference
   */
  detectGroup(ref: string): string | null {
    if (this.activeGroup) return this.activeGroup;
    for (const [n, g] of Object.entries(this.cfg.model_groups))
      if (g.models?.includes(ref)) return n;
    // With auto-discovery, any available model belongs to any group — return lowest tier that includes it
    const refs = this.allDiscoveredRefs();
    if (refs.includes(ref)) {
      for (const name of ['scout', 'operational', 'tactical', 'strategic']) {
        if (this.cfg.model_groups[name]) return name;
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

    // When a group has an explicit models list (e.g. from dynamic config), use it as the
    // display pool so /router reflects what the config actually intends to route to —
    // not just whatever Pi's session registry happens to have discovered.
    // Fall back to allDiscoveredRefs() only for groups without an explicit list.
    let c = g.models?.length ? [...g.models] : this.allDiscoveredRefs();
    if (g.min_gdpval != null) c = this.filterByQualityMin(c, g.min_gdpval);
    else if (g.min_gdpval_pct != null) c = this.filterByQualityPct(c, g.min_gdpval_pct);

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
