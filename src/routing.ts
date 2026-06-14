// src/routing.ts
// Routing-Logik für den pi-model-router

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
   * Gibt alle entdeckten Modell-Referenzen zurück
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
   * Filtert Modelle nach Verfügbarkeit (nicht rate-limited)
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
   * Filtert Modelle nach GDPval-Prozentil
   */
  filterByQualityPct(refs: string[], pct: number): string[] {
    if (!refs.length || pct <= 0) return refs;
    const gdps = refs.map((r) => getM(r).gdpval).sort((a, b) => a - b);
    const idx = Math.floor((pct / 100) * (gdps.length - 1));
    const threshold = gdps[idx];
    return refs.filter((r) => getM(r).gdpval >= threshold);
  }

  /**
   * Filtert Modelle nach minimalem GDPval
   */
  filterByQualityMin(refs: string[], min: number): string[] {
    if (!refs.length || min <= 0) return refs;
    const filtered = refs.filter((r) => getM(r).gdpval >= min);
    return filtered.length ? filtered : refs;
  }

  // ── Sorting ───────────────────────────────────────────────────────────────

  /**
   * Sortiert Modelle nach verschiedenen Methoden
   * Für 'best' wird Multi-Metrik-Scoring verwendet
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
      // Multi-Metrik-Scoring für 'best'-Methode
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
   * Sortiert Modelle nach Billing-Präferenz
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
   * Löst eine Modellgruppe auf
   * Verwendet Multi-Metrik-Scoring für 'best'-Methode
   */
  resolve(name: string): GroupResolution | null {
    const g = this.cfg.model_groups[name];
    if (!g) return null;

    // Dynamic group is handled by the hook, not here
    if (g.method === 'dynamic') return null;

    // When a group has an explicit models list, use it as the routing pool so that
    // routing candidates match what /router displays. Fall back to allDiscoveredRefs()
    // only for groups without an explicit list (auto-discovery mode).
    let c = g.models?.length ? [...g.models] : this.allDiscoveredRefs();
    
    // Filter nach Qualität
    if (g.min_gdpval != null) c = this.filterByQualityMin(c, g.min_gdpval);
    else if (g.min_gdpval_pct != null) c = this.filterByQualityPct(c, g.min_gdpval_pct);
    
    // Filter nach Kosten (falls konfiguriert)
    if (g.max_cost !== undefined) {
      c = c.filter(ref => effCost(ref) <= g.max_cost!);
    }
    if (g.max_cost_per_m !== undefined) {
      c = c.filter(ref => {
        const price = lookupPrice(ref);
        return price ? price.input <= g.max_cost_per_m! : true;
      });
    }

    // Sortierung
    if (g.method === 'best') {
      // Multi-Metrik-Scoring für 'best'-Methode
      // taskType ist der Gruppenname - nur 'code' triggert Code-spezifische Gewichtung
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
    
    // Falls models-Array existiert: Stelle sicher, dass diese Modelle enthalten sind
    // ABER: Sie müssen auch die Filter-Kriterien erfüllen (min_gdpval, max_cost, etc.)
    if (g.models?.length) {
      // Berechne Thresholds einmal vor der Schleife (Performance-Optimierung)
      let gdpvalPctThreshold: number | null = null;
      if (g.min_gdpval_pct != null) {
        const allRefs = this.allDiscoveredRefs();
        const allGdpvals = allRefs.map(r => getM(r).gdpval).sort((a, b) => a - b);
        if (allGdpvals.length > 0) {
          const thresholdIndex = Math.floor((g.min_gdpval_pct / 100) * (allGdpvals.length - 1));
          gdpvalPctThreshold = allGdpvals[thresholdIndex];
        }
      }
      
      for (const requiredModel of g.models) {
        if (!c.includes(requiredModel)) {
          // Prüfe ob das Modell die Filter-Kriterien erfüllt
          let passesFilters = true;
          
          // GDPval Filter
          if (g.min_gdpval != null) {
            const modelGdpval = getM(requiredModel).gdpval;
            if (modelGdpval < g.min_gdpval) passesFilters = false;
          }
          if (gdpvalPctThreshold != null && passesFilters) {
            const modelGdpval = getM(requiredModel).gdpval;
            // Konsistent mit filterByQualityPct: >= threshold
            if (modelGdpval < gdpvalPctThreshold) passesFilters = false;
          }
          
          // Kosten Filter
          if (g.max_cost !== undefined && passesFilters) {
            if (effCost(requiredModel) > g.max_cost) passesFilters = false;
          }
          if (g.max_cost_per_m !== undefined && passesFilters) {
            const price = lookupPrice(requiredModel);
            if (price && price.input > g.max_cost_per_m) passesFilters = false;
          }
          
          if (passesFilters) {
            c.push(requiredModel);
          }
        }
      }
      // Nochmal sortieren, um die besten Modelle nach oben zu bringen
      if (g.method === 'best') {
        c = this.sortBy(c, 'best', name);
      } else {
        c = this.sortBy(c, g.method, name);
      }
    }

    return { selected: c[0], candidates: c };
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
