// src/dynamic-config.ts
// Pure computational core of generateDynamicConfig() (index.ts), extracted so
// the group-filtering/sorting/collection pipeline that builds
// router-config.dynamic.json can be read and unit tested without the full
// Pi extension (session context, streaming, file I/O). index.ts owns the
// orchestration (scan cache validity, disk write, in-memory cfg/router swap);
// this module owns only the "given inputs, compute the dynamic groups" math.
//
// C1: extracted from index.ts's generateDynamicConfig (behavior-preserving,
// no semantic changes — only code motion + parameterizing what used to be
// closures over `cfg`/`cache`).

import { PROVIDER_MAP } from './providers.ts';
import { baseTokens } from './utils.ts';
import { effCost, lookupGdp, lookupPrice } from './metrics.ts';
import type { Config, Group } from './types.ts';

export interface ModelWithMetadata {
  ref: string;
  gdpval: number;
  cost: number | 'unknown';
  price: { input: number | 'unknown'; output: number | 'unknown' } | null;
  isFreeModel: boolean;
}

/**
 * Collects the static free_models declared per-provider in router-config.json.
 * These models are never scanned; they come straight from config.
 */
export function buildStaticFreeModelsLookup(staticCfg: Config): {
  staticFreeModels: string[];
  staticFreeModelsLookup: Set<string>;
} {
  const staticFreeModels: string[] = [];
  const staticFreeModelsLookup = new Set<string>();
  for (const [provId, provConfig] of Object.entries(staticCfg.providers ?? {})) {
    if (provConfig.free_models && Array.isArray(provConfig.free_models)) {
      for (const freeModel of provConfig.free_models) {
        const normalizedModel = freeModel.startsWith(`${provId}/`) ? freeModel : `${provId}/${freeModel}`;
        staticFreeModels.push(normalizedModel);
        staticFreeModelsLookup.add(normalizedModel);
        if (normalizedModel.includes('/')) {
          const nonPrefixed = normalizedModel.split('/').slice(1).join('/');
          staticFreeModelsLookup.add(nonPrefixed);
        }
      }
    }
  }
  return { staticFreeModels, staticFreeModelsLookup };
}

/**
 * Enriches candidate refs with GDPval/cost/price/free-model metadata, then
 * drops anything without a GDPval score UNLESS it's an explicitly configured
 * static model (router-config.json models list is a hand-curated allow-list,
 * kept even without a resolvable score).
 */
export function buildModelsWithMetadata(
  refs: string[],
  cfg: Config,
  staticFreeModelsLookup: Set<string>,
  staticModelRefs: Set<string>
): ModelWithMetadata[] {
  return refs
    .map((ref) => {
      const gdpval = lookupGdp(ref) ?? 0;
      const cost = effCost(ref);
      const price = lookupPrice(ref);

      const prov = ref.split('/')[0];
      const isTokenBased = (cfg.providers?.[prov]?.billing ?? PROVIDER_MAP[prov]?.billing) === 'pay_per_token';

      const isFreeModel =
        staticFreeModelsLookup.has(ref) ||
        (price !== null && price.input === 0 && price.output === 0) ||
        ref.includes(':free') ||
        (cost === 0 && isTokenBased);

      return { ref, gdpval, cost, price, isFreeModel };
    })
    .filter((m) => {
      if (staticModelRefs.has(m.ref)) return true;
      return m.gdpval > 0;
    });
}

/** Applies a group's min_gdpval / max_cost_per_m / max_cost gates to the scored candidate pool. */
export function filterModelsForGroup(models: ModelWithMetadata[], groupConfig: Group, cfg: Config): ModelWithMetadata[] {
  let filtered = [...models];

  if (groupConfig.min_gdpval !== undefined) {
    filtered = filtered.filter((m) => m.gdpval >= groupConfig.min_gdpval!);
  }

  if (groupConfig.max_cost_per_m !== undefined) {
    filtered = filtered.filter((m) => {
      const prov = m.ref.split('/')[0];
      const isTokenBased = (cfg.providers?.[prov]?.billing ?? PROVIDER_MAP[prov]?.billing) === 'pay_per_token';

      if (m.isFreeModel && isTokenBased) return true;
      if (!isTokenBased) return true;

      const price = m.price;
      if (!price || price.input === 'unknown' || price.output === 'unknown') return false;
      if (typeof price.input !== 'number') return false;
      return price.input <= groupConfig.max_cost_per_m!;
    });
  }

  if (groupConfig.max_cost !== undefined) {
    filtered = filtered.filter((m) => {
      const prov = m.ref.split('/')[0];
      const isTokenBased = (cfg.providers?.[prov]?.billing ?? PROVIDER_MAP[prov]?.billing) === 'pay_per_token';

      if (groupConfig.max_cost === 0) {
        return m.isFreeModel && isTokenBased;
      }

      if (m.isFreeModel) return true;

      if (m.cost === 'unknown') return false;
      return m.cost <= groupConfig.max_cost!;
    });
  }

  return filtered;
}

/** Orders a group's filtered candidates per its `method` (best/max_gdpval/min_cost/tiered). */
export function sortModelsForGroup(
  models: ModelWithMetadata[],
  groupConfig: Group,
  groupName: string,
  cfg: Config,
  calculateScore: (ref: string, taskType: string, cfg: Config) => number
): ModelWithMetadata[] {
  const sorted = [...models];

  if (groupConfig.method === 'best' || groupConfig.method === 'max_gdpval') {
    sorted.sort((a, b) => calculateScore(b.ref, groupName, cfg) - calculateScore(a.ref, groupName, cfg));
  } else if (groupConfig.method === 'min_cost') {
    sorted.sort((a, b) => {
      if (a.isFreeModel && !b.isFreeModel) return -1;
      if (!a.isFreeModel && b.isFreeModel) return 1;

      const costA = a.cost;
      const costB = b.cost;
      if (costA === 'unknown' && costB === 'unknown') {
        return calculateScore(b.ref, groupName, cfg) - calculateScore(a.ref, groupName, cfg);
      }
      if (costA === 'unknown') return 1;
      if (costB === 'unknown') return -1;
      if (costA !== costB) return costA - costB;

      return calculateScore(b.ref, groupName, cfg) - calculateScore(a.ref, groupName, cfg);
    });
  } else if (groupConfig.method === 'tiered') {
    sorted.sort((a, b) => {
      if (b.gdpval !== a.gdpval) return b.gdpval - a.gdpval;

      if (a.isFreeModel && !b.isFreeModel) return -1;
      if (!a.isFreeModel && b.isFreeModel) return 1;

      const scoreB = calculateScore(b.ref, groupName, cfg);
      const scoreA = calculateScore(a.ref, groupName, cfg);
      if (scoreB !== scoreA) return scoreB - scoreA;

      const costA = a.cost;
      const costB = b.cost;
      if (costA === 'unknown' && costB === 'unknown') return 0;
      if (costA === 'unknown') return 1;
      if (costB === 'unknown') return -1;
      return costA - costB;
    });
  }

  return sorted;
}

/**
 * Merges a group's hand-curated static models (router-config.json `models`,
 * re-filtered against the same gates) with the sorted dynamic candidates,
 * deduplicating by token signature so e.g. "mistral/mistral-medium-3.5" and
 * "mistral/mistral-medium-3-5" don't both end up in the final list.
 */
export function collectGroupModels(
  groupConfig: Group,
  filteredModels: ModelWithMetadata[],
  sortedGroupModels: ModelWithMetadata[],
  cfg: Config,
  staticFreeModelsLookup: Set<string>
): string[] {
  const modelsToInclude = new Set<string>();
  const includedSigs = new Set<string>();
  const modelSig = (ref: string) => [...baseTokens(ref)].sort().join('|');

  const originalModels = groupConfig.models ?? [];
  for (const origModel of originalModels) {
    const origGdpval = lookupGdp(origModel);

    if (origGdpval === null) continue;

    if (
      groupConfig.min_gdpval !== undefined &&
      origGdpval !== undefined &&
      origGdpval !== null &&
      origGdpval < groupConfig.min_gdpval
    ) {
      continue;
    }

    const isFree = staticFreeModelsLookup.has(origModel);
    const origProv = origModel.split('/')[0];
    const isTokenBased = (cfg.providers?.[origProv]?.billing ?? PROVIDER_MAP[origProv]?.billing) === 'pay_per_token';

    if (groupConfig.max_cost_per_m !== undefined) {
      if (isFree && isTokenBased) {
        // ok
      } else if (!isTokenBased) {
        // Subscription models always pass through
      } else {
        const price = lookupPrice(origModel);
        if (price) {
          if (price.input === 'unknown' || price.output === 'unknown') continue;
          if (typeof price.input === 'number' && price.input > groupConfig.max_cost_per_m) continue;
        }
      }
    }
    if (groupConfig.max_cost !== undefined) {
      if (groupConfig.max_cost === 0) {
        if (!(isFree && isTokenBased)) continue;
      } else {
        if (isFree && isTokenBased) {
          // ok
        } else if (!isTokenBased) {
          // Subscription models always pass through
        } else {
          const cost = effCost(origModel);
          if (cost === 'unknown' || (typeof cost === 'number' && cost > groupConfig.max_cost)) continue;
        }
      }
    }

    modelsToInclude.add(origModel);
    includedSigs.add(modelSig(origModel));
  }

  for (const model of sortedGroupModels) {
    if (modelsToInclude.has(model.ref)) continue;
    const sig = modelSig(model.ref);
    if (includedSigs.has(sig)) continue;
    modelsToInclude.add(model.ref);
    includedSigs.add(sig);
  }

  return Array.from(modelsToInclude);
}

/**
 * Auto-generates fallback_groups for each non-dynamic group based on quality
 * ordering (nearest higher quality first, then lower), so a failing group
 * escalates before it degrades. Mutates each group's `fallback_groups`
 * in place, matching the original inline behavior exactly.
 */
export function computeFallbackGroups(dynamicGroups: Record<string, Group>): void {
  const qualityOf = (g: Group): number => {
    if (g.method === 'dynamic') return -1;
    if (g.max_cost === 0) return 0;
    if (g.min_gdpval !== undefined) return g.min_gdpval;
    return 750;
  };
  const eligibleGroups = Object.entries(dynamicGroups)
    .filter(([, g]) => g.method !== 'dynamic')
    .sort(([, a], [, b]) => qualityOf(a) - qualityOf(b));

  for (const [myIdx, [name]] of eligibleGroups.entries()) {
    const above = eligibleGroups.slice(myIdx + 1).map(([n]) => n);
    const below = eligibleGroups.slice(0, myIdx).reverse().map(([n]) => n);
    dynamicGroups[name].fallback_groups = [...above, ...below];
  }
}
