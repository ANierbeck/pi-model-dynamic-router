/**
 * Model resolution / display glue, extracted from index.ts (refactor plan
 * 2026-10-02, task 3). Delegating helpers for group resolution and the
 * /router table formatting. Pure code motion; closure state via `d`.
 */

import * as metricsModule from './metrics.ts';
import type { Cache, Metrics } from './types.ts';
import type { DiscoveryManager } from './discovery.ts';
import type { Router } from './routing.ts';

/**
 * Dependencies createModelResolveGlue reads from index.ts's extension closure. Exposed as
 * live accessors (getters, plus setters for state the moved code writes), so
 * every read sees the CURRENT closure value — index.ts reassigns cfg/router/
 * managers on reload, and a captured copy would go stale.
 */
export interface ModelResolveGlueDeps {
  readonly cache: Cache;
  readonly costMux: (prov: string) => number;
  readonly discoveryManager: DiscoveryManager;
  readonly effCost: (ref: string) => number | "unknown";
  readonly getM: (ref: string) => Metrics;
  readonly isLimited: (ref: string) => boolean;
  readonly limitSecs: (ref: string) => number;
  readonly router: Router;
}

export function createModelResolveGlue(d: ModelResolveGlueDeps) {
  // ── Resolution ─────────────────────────────────────────────────────────

  // ── Auto-discovery ────────────────────────────────────────────────────

  /** All known model refs: auto-discovered + any pinned models in group config */
  function allDiscoveredRefs(): string[] {
    return d.router.allDiscoveredRefs();
  }

  function resolve(name: string): { selected: string; candidates: string[] } | null {
    return d.router.resolve(name);
  }



  // ── Format ─────────────────────────────────────────────────────────────

  function fmtModel(ref: string, i: number, sel: boolean) {
    const m = d.getM(ref),
      prov = ref.split('/')[0],
      mux = d.costMux(prov);
    // Billing label now derives from billingTier() (single source of truth).
    // Previously this inlined `cfg.providers?.[prov]?.billing === 'subscription'`,
    // which IGNORED PROVIDER_MAP built-in defaults — a built-in subscription
    // provider without a user config entry would display as 'ppt' instead of
    // 'sub'. Also, 'free' only checked cost_per_m===0, missing the :free tag
    // and the free_models config list. billingTier() unifies all three.
    const tier = metricsModule.billingTier(ref);
    const billing = tier === 1 ? 'sub' : tier === 0 ? 'free' : 'ppt';
    const muxS = mux > 1 ? ` ×${mux}` : '';
    const rl = d.isLimited(ref) ? ` ⛔${d.limitSecs(ref)}s` : '';
    const cost = d.effCost(ref);
    const costStr = cost === 'unknown' ? 'unknown' : cost.toFixed(3);
    
    // Add budget info for subscription providers
    const budgetInfo = d.cache.budget_cache?.[prov];
    let budgetStr = '';
    if (budgetInfo && budgetInfo.window_reset && budgetInfo.remaining_tokens !== undefined) {
      const now = Date.now();
      if (now < budgetInfo.window_reset) {
        const remaining = budgetInfo.remaining_tokens;
        const windowType = budgetInfo.window_type ?? 'monthly';
        budgetStr = ` bud:${Math.round(remaining)}${windowType.substring(0, 1)}`;
      }
    }
    
    return `${i + 1}. ${ref}  gdp:${m.gdpval}  tps:${Math.round(m.throughput_tps)}  eff:$${costStr}/M  [${billing}${muxS}]${rl}${budgetStr}${sel ? ' ←' : ''}`;
  }

  // Get top N models for a group, including rate-limited ones (for display)
  function getTopModels(
    groupName: string,
    n: number
  ): { models: { ref: string; limited: boolean; rank: number }[]; total: number } {
    return d.router.getTopModels(groupName, n);
  }

  function detectGroup(ref: string): string | null {
    return d.router.detectGroup(ref);
  }

  return { resolve, detectGroup, fmtModel, getTopModels, allDiscoveredRefs };
}
