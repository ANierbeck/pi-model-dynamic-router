// src/routing.ts
// Routing-Logik für den pi-model-router

import type { Group, Config, Cache, RateLimit, Metrics, ModelWithLimits, GroupResolution } from "./types.js";
import { splitRef, stripProvider, norm, baseTokens } from "./utils.js";
import { PROVIDER_MAP } from "./providers.js";
import { getM, lookupGdp, billingTier, effCost, costMux, lookupPrice } from "./metrics.js";

// ── Constants ────────────────────────────────────────────────────────────

const SUB_DISCOUNT = 0.5; // Subscription discount factor

// ── Routing Logic ─────────────────────────────────────────────────────────

/**
 * Verwaltet das Routing für Modellgruppen
 */
export class Router {
  private cfg: Config;
  private cache: Cache;
  private limits: Map<string, RateLimit>;
  private rrCounters: Record<string, number> = {};
  private activeGroup: string | null = null;
  private curModel: string = "";
  private lastDynamicModel: string = "";
  private lastDynamicCategory: string | undefined;

  constructor(cfg: Config, cache: Cache, limits: Map<string, RateLimit>) {
    this.cfg = cfg;
    this.cache = cache;
    this.limits = limits;
  }

  // ── Model Discovery ─────────────────────────────────────────────────────

  /**
   * Gibt alle entdeckten Modell-Referenzen zurück
   */
  allDiscoveredRefs(): string[] {
    const refs = new Set<string>();
    // Always include explicitly pinned group models
    for (const g of Object.values(this.cfg.model_groups)) {
      for (const r of g.models ?? []) refs.add(r);
    }
    
    // Add models from available_models cache
    for (const m of this.cache.available_models ?? []) {
      refs.add(`${m.provider}/${m.id}`);
    }
    
    return [...refs];
  }

  // ── Filtering ─────────────────────────────────────────────────────────────

  /**
   * Filtert Modelle nach Verfügbarkeit (nicht rate-limited)
   */
  filterAvailable(refs: string[]): string[] {
    return refs.filter(r => !this.isLimited(r));
  }

  /**
   * Filtert Modelle nach GDPval-Prozentil
   */
  filterByQualityPct(refs: string[], pct: number): string[] {
    if (!refs.length || pct <= 0) return refs;
    const gdps = refs.map(r => getM(r).gdpval).sort((a, b) => a - b);
    const idx = Math.floor((pct / 100) * (gdps.length - 1));
    const threshold = gdps[idx];
    return refs.filter(r => getM(r).gdpval >= threshold);
  }

  /**
   * Filtert Modelle nach minimalem GDPval
   */
  filterByQualityMin(refs: string[], min: number): string[] {
    if (!refs.length || min <= 0) return refs;
    const filtered = refs.filter(r => getM(r).gdpval >= min);
    return filtered.length ? filtered : refs;
  }

  // ── Sorting ───────────────────────────────────────────────────────────────

  /**
   * Sortiert Modelle nach verschiedenen Methoden
   */
  sortBy(models: string[], method: string): string[] {
    const s = [...models];
    if (method === "min_latency") return s.sort((a, b) => getM(a).avg_latency_ms - getM(b).avg_latency_ms);
    if (method === "max_throughput") return s.sort((a, b) => getM(b).throughput_tps - getM(a).throughput_tps);
    if (method === "min_cost") return s.sort((a, b) => effCost(a) - effCost(b) || getM(b).gdpval - getM(a).gdpval);
    if (method === "max_gdpval") return s.sort((a, b) => getM(b).gdpval - getM(a).gdpval);
    if (method === "billing_preference") return this.sortByBillingPreference(s);
    if (method === "roundrobin") return s;
    return s;
  }

  /**
   * Sortiert Modelle nach Billing-Präferenz
   */
  sortByBillingPreference(refs: string[]): string[] {
    return [...refs].sort((a, b) => {
      const ta = billingTier(a), tb = billingTier(b);
      if (ta !== tb) return ta - tb;
      // Within subscription tier, prefer lower rate-limit pressure first, then cost
      if (ta === 1) {
        const pa = this.limitSecs(a), pb = this.limitSecs(b);
        if (pa !== pb) return pa - pb;
      }
      return effCost(a) - effCost(b);
    });
  }

  // ── Resolution ────────────────────────────────────────────────────────

  /**
   * Löst eine Modellgruppe auf
   */
  resolve(name: string): GroupResolution | null {
    const g = this.cfg.model_groups[name];
    if (!g) return null;

    // Dynamic group is handled by the hook, not here
    if (g.method === "dynamic") return null;

    let c = this.allDiscoveredRefs();
    if (g.min_gdpval != null) c = this.filterByQualityMin(c, g.min_gdpval);
    else if (g.min_gdpval_pct != null) c = this.filterByQualityPct(c, g.min_gdpval_pct);

    if (g.method === "best") {
      // Strategic: highest gdpval available
      c = this.sortBy(c, "max_gdpval");
    } else if (g.method === "tiered") {
      // Quality-gated + billing preference
      c = this.sortByBillingPreference(c);
    } else if (g.method === "pipeline" && g.pipeline) {
      for (const step of g.pipeline) {
        c = this.sortBy(c, step.method);
        if (step.top_k && step.top_k < c.length) c = c.slice(0, step.top_k);
      }
    } else if (g.method === "roundrobin") {
      const i = (this.rrCounters[name] ?? 0) % c.length;
      this.rrCounters[name] = i + 1;
      c = [...c.slice(i), ...c.slice(0, i)];
    } else {
      c = this.sortBy(c, g.method);
      if (g.top_k && g.top_k < c.length) c = c.slice(0, g.top_k);
    }

    return { selected: c[0], candidates: c };
  }

  // ── Group Detection ─────────────────────────────────────────────────────

  /**
   * Detects the group for a model reference
   */
  detectGroup(ref: string): string | null {
    if (this.activeGroup) return this.activeGroup;
    for (const [n, g] of Object.entries(this.cfg.model_groups)) if (g.models?.includes(ref)) return n;
    // With auto-discovery, any available model belongs to any group — return lowest tier that includes it
    const refs = this.allDiscoveredRefs();
    if (refs.includes(ref)) {
      for (const name of ["scout", "operational", "tactical", "strategic"]) {
        if (this.cfg.model_groups[name]) return name;
      }
    }
    return null;
  }

  // ── Rate Limit ─────────────────────────────────────────────────────────────

  /**
   * Prüft, ob eine Referenz aktuell rate-limited ist
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
   * Gibt die verbleibenden Sekunden der Rate-Limit zurück
   */
  limitSecs(ref: string): number {
    const limit = this.limits.get(ref);
    return limit ? Math.max(0, Math.ceil((limit.cooldown_until - Date.now()) / 1000)) : 0;
  }

  // ── Top Models ────────────────────────────────────────────────────────────

  /**
   * Gibt die Top-Modelle für eine Gruppe zurück
   */
  getTopModels(groupName: string, n: number): ModelWithLimits[] {
    const g = this.cfg.model_groups[groupName];
    if (!g) return [];
    if (g.method === "dynamic") return []; // resolved at prompt-time via classifier

    let c = this.allDiscoveredRefs();
    if (g.min_gdpval != null) c = this.filterByQualityMin(c, g.min_gdpval);
    else if (g.min_gdpval_pct != null) c = this.filterByQualityPct(c, g.min_gdpval_pct);

    if (g.method === "best") {
      c = this.sortBy(c, "max_gdpval");
    } else if (g.method === "tiered") {
      c = this.sortByBillingPreference(c);
    } else if (g.method === "pipeline" && g.pipeline) {
      for (let i = 0; i < g.pipeline.length; i++) {
        const step = g.pipeline[i];
        c = this.sortBy(c, step.method);
        const isLastStep = i === g.pipeline.length - 1;
        if (step.top_k && step.top_k < c.length && !isLastStep) c = c.slice(0, step.top_k);
      }
    } else {
      c = this.sortBy(c, g.method);
    }

    const avail = c.filter(ref => !this.isLimited(ref));
    const limited = c.filter(ref => this.isLimited(ref));
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
