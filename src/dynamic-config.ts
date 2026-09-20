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
import { effCost, lookupGdp, lookupPrice, lookupContextWindow, getMatchedSlug } from './metrics.ts';
import type { Config, Group } from './types.ts';
import { normalizeModelId } from './slug-matcher.ts';

export interface ModelWithMetadata {
  ref: string;
  gdpval: number;
  cost: number | 'unknown';
  price: { input: number | 'unknown'; output: number | 'unknown' } | null;
  isFreeModel: boolean;
  /**
   * Scanned context window (tokens), or null when the scan reported none.
   * Populated from cache.available_models[].capabilities.contextWindow via
   * lookupContextWindow — the same field src/capabilities.ts normalizes from
   * Mistral/OpenRouter/Ollama. Null is authoritative for "unknown"; the
   * min_context_length group filter treats null as failing the gate
   * (strict, mirroring min_gdpval).
   */
  contextWindow?: number | null;
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

      const contextWindow = lookupContextWindow(ref);

      return { ref, gdpval, cost, price, isFreeModel, contextWindow };
    })
    .filter((m) => {
      if (staticModelRefs.has(m.ref)) return true;
      return m.gdpval > 0;
    });
}

/** Applies a group's min_gdpval / max_cost_per_m / max_cost gates to the scored candidate pool. */
/**
 * Collapses same-provider slug clusters to their canonical representative —
 * the persist-path mirror of applyGroupFilters' dedup-before-gates step
 * (2026-09-20). MUST run BEFORE filterModelsForGroup: the per-group cost
 * filter otherwise drops the honest registry-priced twin (zai-glm-5-3,
 * $1.4) first and the fake-priced alias (cost_per_m-0 scan placeholder)
 * survives as the cluster's representative — the generated dynamic config
 * listed mistral/zai-glm-5 at $0.0 in trivial/simple/scout/fallback.
 *
 * Keying is provider:slug — cross-provider same-slug variants are genuinely
 * different endpoints/prices and stay for collectGroupModels' phase-2 slug
 * dedup among the survivors. Unmatched refs (no slug) never collapse.
 */
export function collapseSameSlugClusters(models: ModelWithMetadata[]): ModelWithMetadata[] {
  // Canonical: the ref whose normalized id equals its matched slug — the
  // real versioned name that -latest / dated-snapshot aliases point at
  // (same rule as collectGroupModels' isCanonicalRef).
  const isCanonical = (ref: string): boolean => {
    const slug = getMatchedSlug(ref);
    if (!slug) return true;
    const modelId = ref.split('/').pop() ?? ref;
    return normalizeModelId(modelId) === normalizeModelId(slug);
  };
  const best = new Map<string, ModelWithMetadata>();
  for (const m of models) {
    const slug = getMatchedSlug(m.ref);
    const key = slug ? `${m.ref.split('/')[0]}:${slug}` : m.ref;
    const existing = best.get(key);
    if (existing === undefined) {
      best.set(key, m);
    } else if (isCanonical(m.ref) && !isCanonical(existing.ref)) {
      best.set(key, m);
    }
  }
  return [...best.values()];
}

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

  // min_context_length (strict: unknown context window fails the gate,
  // mirroring min_gdpval's null-fails semantics — never silently admit a
  // model whose capacity is unverified into a group that *needs* a large
  // context window). Absent/0 means "no context-length gate".
  if (groupConfig.min_context_length != null && groupConfig.min_context_length > 0) {
    filtered = filtered.filter((m) => {
      const cw = m.contextWindow;
      return typeof cw === 'number' && cw >= groupConfig.min_context_length!;
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
 * deduplicating by model identity (GDPval slug, falling back to token
 * signature for unmatched refs) so e.g. "mistral/mistral-medium-3.5",
 * "mistral/mistral-medium-latest" and "mistral/mistral-medium-2604" — all
 * resolving to slug mistral-medium-3-5 — don't end up as three entries.
 * Within an identity cluster the CANONICAL ref (whose normalized id equals
 * its matched slug) replaces alias forms; a static curated entry is never
 * displaced by a dynamic sibling (hand-curated allow-list = explicit intent).
 */
export function collectGroupModels(
  groupConfig: Group,
  filteredModels: ModelWithMetadata[],
  sortedGroupModels: ModelWithMetadata[],
  cfg: Config,
  staticFreeModelsLookup: Set<string>
): string[] {
  const modelsToInclude = new Set<string>();
  const modelSig = (ref: string) => [...baseTokens(ref)].sort().join('|');
  // Identity key: matched GDPval slug when one exists, else the token signature
  // (so unmatched refs still dedup by their tokens and never collapse with a
  // different unmatched model).
  const identityKey = (ref: string) => getMatchedSlug(ref) ?? modelSig(ref);
  // Canonical: the ref whose normalized id equals its matched slug — the real
  // versioned name that -latest / dated-snapshot aliases point at.
  const isCanonicalRef = (ref: string): boolean => {
    const slug = getMatchedSlug(ref);
    if (!slug) return true; // unmatched refs use their signature as identity
    const modelId = ref.split('/').pop() ?? ref;
    return normalizeModelId(modelId) === normalizeModelId(slug);
  };
  const includedByKey = new Map<string, string>(); // key → the ref currently held
  const staticIncluded = new Set<string>();

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
    includedByKey.set(identityKey(origModel), origModel);
    staticIncluded.add(origModel);
  }

  for (const model of sortedGroupModels) {
    if (modelsToInclude.has(model.ref)) continue;
    const key = identityKey(model.ref);
    const existing = includedByKey.get(key);
    if (existing !== undefined) {
      // Same identity already included.
      // - A STATIC curated entry is explicit user intent and is never
      //   displaced by a dynamic sibling (even a canonical one).
      // - Otherwise replace an alias form with the canonical ref (so the
      //   generated group names the real versioned model, not -latest).
      if (!staticIncluded.has(existing) && !isCanonicalRef(existing) && isCanonicalRef(model.ref)) {
        modelsToInclude.delete(existing);
        modelsToInclude.add(model.ref);
        includedByKey.set(key, model.ref);
      }
      continue;
    }
    modelsToInclude.add(model.ref);
    includedByKey.set(key, model.ref);
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
