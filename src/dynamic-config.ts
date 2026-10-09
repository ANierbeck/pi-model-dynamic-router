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
import { applyGroupFilters, type GroupFilterLookups } from './routing.ts';
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

/**
 * Applies a group's gates to the scored candidate pool through the SAME rule
 * set as the live path (applyGroupFilters, ADR-0010), fed with the values
 * this path already computed per model.
 */
export function filterModelsForGroup(models: ModelWithMetadata[], groupConfig: Group, cfg: Config): ModelWithMetadata[] {
  const byRef = new Map(models.map((m) => [m.ref, m]));
  const lookups: GroupFilterLookups = {
    gdp: (ref) => {
      const v = byRef.get(ref)?.gdpval;
      return v !== undefined && v > 0 ? v : null;
    },
    cost: (ref) => byRef.get(ref)?.cost ?? 'unknown',
    price: (ref) => byRef.get(ref)?.price ?? null,
    contextWindow: (ref) => byRef.get(ref)?.contextWindow ?? null,
    isFree: (ref) => byRef.get(ref)?.isFreeModel ?? false,
  };
  const kept = new Set(applyGroupFilters([...byRef.keys()], groupConfig, cfg, false, undefined, lookups));
  return models.filter((m) => kept.has(m.ref));
}

/** Orders a group's filtered candidates per its `method` (best/max_gdpval/min_cost/tiered). */
export function sortModelsForGroup(
  models: ModelWithMetadata[],
  groupConfig: Group,
  cfg: Config,
  calculateScore: (ref: string, taskType: string, cfg: Config) => number
): ModelWithMetadata[] {
  const sorted = [...models];
  // The score column comes from the group's score_by (gdpval default) —
  // NEVER from the group NAME. The name was historically passed as the
  // legacy taskType argument: harmless before the AA capability round, but
  // since columns exist it would make a group literally named 'briefcase'/
  // 'coding' accidentally score by that capability column while a group
  // WITH a configured score_by silently sorted by gdpval (release review
  // 2026-10-04). Mirrors routing.ts sortBy's `g.score_by ?? 'gdpval'`.
  const column = groupConfig.score_by ?? 'gdpval';

  if (groupConfig.method === 'best' || groupConfig.method === 'max_gdpval') {
    sorted.sort((a, b) => calculateScore(b.ref, column, cfg) - calculateScore(a.ref, column, cfg));
  } else if (groupConfig.method === 'min_cost') {
    sorted.sort((a, b) => {
      if (a.isFreeModel && !b.isFreeModel) return -1;
      if (!a.isFreeModel && b.isFreeModel) return 1;

      const costA = a.cost;
      const costB = b.cost;
      if (costA === 'unknown' && costB === 'unknown') {
        return calculateScore(b.ref, column, cfg) - calculateScore(a.ref, column, cfg);
      }
      if (costA === 'unknown') return 1;
      if (costB === 'unknown') return -1;
      if (costA !== costB) return costA - costB;

      return calculateScore(b.ref, column, cfg) - calculateScore(a.ref, column, cfg);
    });
  } else if (groupConfig.method === 'tiered') {
    sorted.sort((a, b) => {
      if (b.gdpval !== a.gdpval) return b.gdpval - a.gdpval;

      if (a.isFreeModel && !b.isFreeModel) return -1;
      if (!a.isFreeModel && b.isFreeModel) return 1;

      const scoreB = calculateScore(b.ref, column, cfg);
      const scoreA = calculateScore(a.ref, column, cfg);
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
  cfg: Config
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
    // Hand-curated models must still resolve to a score, then pass the same
    // gates as every other candidate (ADR-0010).
    if (lookupGdp(origModel) === null) continue;
    if (applyGroupFilters([origModel], groupConfig, cfg).length === 0) continue;

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

/**
 * Config keys that are ALWAYS taken from the static layered config
 * (embedded defaults → user override → project override) instead of the
 * persisted dynamic config. Used by BOTH consumers:
 *
 * 1. index.ts load(), when a stale router-config.dynamic.json is read: the
 *    file is a generated CACHE of computed group/model lists, but it also
 *    round-trips user-overridable scalar keys. Without the re-sync, editing
 *    such a key in router-config.json / router-config.user.json has NO
 *    effect for as long as the dynamic file exists (the common steady
 *    state) — the stale file silently shadows the user's intent.
 * 2. the write site in src/dynamic-config-runner.ts, when the dynamic config is
 *    (re)written: forcing these keys from staticCfg means the regenerated
 *    file never persists a stale user value for another 30-day cycle.
 *
 * Every key here is user intent (behavior settings, safety properties) —
 * NEVER a scan-derived value (those legitimately live in the dynamic
 * file). Final v1.6.0 review findings I4 + I5: this list replaced two
 * hand-maintained, drifted assignment blocks (ollama_max_concurrent_streams
 * had already been forgotten in both).
 */
export const DYNAMIC_CONFIG_RESYNC_KEYS = [
  // Safety property: exclude rules from the static layers are enforced even
  // when a stale dynamic file exists (ADR-0009 union semantics apply within
  // the static layers).
  'exclude',
  // Agent-capability tier (2026-09-27): the user-layer list of non-agent family prefixes.
  'non_agent_model_prefixes',
  // Empty-response watchdog windows.
  'empty_response_timeout_ms',
  'reasoning_empty_response_timeout_ms',
  // Same timeout-override family as the two windows above (was missing from
  // the load() whitelist — same bug class as ollama_max_concurrent_streams).
  'stall_timeout_ms',
  // Rate-limit scheduling/behavior (ADR-0017 wait-for-reset + cfg-backed
  // backoff schedules).
  'rate_limit_wait_max_ms',
  'backoff_minutes',
  'soft_backoff_ms',
  // Enforced-delegation settings (ADR-0007 revision) — user intent.
  'delegation',
  // Local-stream concurrency limiter (process-wide semaphore for
  // ollama/lm-studio) — user intent; was missing from BOTH whitelists
  // (final v1.6.0 review I4).
  'ollama_max_concurrent_streams',
  // ADR-0023 quality-equivalence window. Missing here, it never reached the
  // live config: a dynamic file generated before the key existed is spread
  // into every regeneration, so `best` ranked by pure score live (opus
  // before sonnet in strategic/planning) while an offline simulation on the
  // static config showed the intended order (Phase 0 step 3, 2026-10-06).
  'best_quality_window',
  // Log verbosity is applied from the layered config (index.ts setLogLevel);
  // re-synced so the persisted dynamic copy is never a stale, misleading one.
  'log_level',
  // Category→group mapping overrides (task-type-balancing Phase 3) — user
  // intent; without the re-sync a dynamic file generated before the key
  // existed would shadow the user's mapping for as long as it exists.
  'category_groups',
  // Global cache-aware compaction settings (task-type-balancing Phase 5b) —
  // user intent, same shadowing class as category_groups. Per-group overrides
  // live inside model_groups entries and flow with the group config the scan
  // copies (dynamicGroups[g] = { ...staticGroup, models }).
  'context_budget',
  // Classifier decision log (2026-10-08 plan, Phase 1): whether/how the
  // classification decision log runs is user intent (privacy + retention) —
  // a stale dynamic file must not silently switch it off.
  'classifier_log',
  // Opt-in local Laya classifier stage (2026-10-09 plan): enable/configure is
  // user intent; a stale dynamic file must not leave it stuck on or off.
  'classifier_laya',
] as const satisfies readonly (keyof Config)[];

/**
 * Keys that BOTH layers legitimately write: the static layers (shipped
 * defaults, user/project overrides, update_model_metrics) and the scan (it
 * auto-registers unknown providers as subscription, persists per-model
 * values). Re-syncing them wholesale would drop the scan's entries; never
 * re-syncing them shadowed every static edit for as long as the dynamic file
 * existed. They are merged per entry instead — static wins per provider /
 * ref / slug (field-wise for object entries), scan-only entries stay. An
 * added or changed static entry applies at once; a REMOVED one is pruned via
 * the remembered static contribution (see StaticContributions).
 */
export const DYNAMIC_CONFIG_MERGE_KEYS = [
  'providers',
  'model_metrics',
  'gdpval_builtin',
] as const satisfies readonly (keyof Config)[];

type MergeKey = (typeof DYNAMIC_CONFIG_MERGE_KEYS)[number];

/**
 * What the static layers contributed to the merge keys at the last resync,
 * persisted as `_dynamic.static_contributions` in router-config.dynamic.json:
 * merge key → entry → names of the fields the static entry carried (`null`
 * for a scalar entry such as a gdpval_builtin score).
 *
 * The merge alone cannot tell "this dynamic entry came from a static layer
 * that dropped it" from "the scan / a learned path added it" — both look
 * like a dynamic entry the static layers lack. The remembered set can: an
 * entry that is REMEMBERED but no longer in the current static set is
 * pruned; one that was never remembered (scan-added) stays. Provenance
 * unknown (no remembered set yet, or a corrupt one) → nothing is pruned,
 * the same conservatism as the merge itself.
 */
export type StaticContributions = Record<MergeKey, Record<string, string[] | null>>;

/**
 * Pure-config fields the scan never writes: for these the static layers are
 * authoritative with no provenance needed, so a dynamic file that predates
 * the remembered set (every install upgrading from before the prune) still
 * heals. `providers.*.free_models` is the field whose lingering list kept
 * feeding max_cost: 0 groups after ADR-0025 B1 removed it from the shipped
 * config.
 */
const STATIC_AUTHORITATIVE_FIELDS: Partial<Record<MergeKey, readonly string[]>> = {
  providers: ['free_models'],
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Registers a lightweight provider stub for each registry-discovered provider
 * the config doesn't know yet (e.g. claude-bridge): without the entry
 * stripProvider() won't recognize the prefix and GDPval/price inference via
 * the base model name would fail. Never overwrites an existing entry.
 * Extracted (review M2, 2026-10-07) so BOTH the scan write site AND load()
 * can register stubs: a static `billing` field that was removed (or a
 * project-layer switch) prunes the entry at the next resync, and the stub
 * must come back immediately — not at the next regeneration, which can be
 * up to 30 days away.
 */
export function registerRegistryProviderStubs(cfg: Config, registryRefs: string[]): void {
  for (const ref of registryRefs) {
    const slash = ref.indexOf('/');
    if (slash === -1) continue;
    const prov = ref.slice(0, slash);
    if (!PROVIDER_MAP[prov] && !cfg.providers?.[prov]) {
      (cfg.providers ??= {})[prov] = { billing: 'subscription' };
    }
  }
}

/** Snapshot of the entries/fields the static layers currently declare under the merge keys. */
export function collectStaticContributions(staticCfg: Config): StaticContributions {
  const stat = staticCfg as unknown as Record<string, unknown>;
  const out = {} as StaticContributions;
  for (const key of DYNAMIC_CONFIG_MERGE_KEYS) {
    const section: Record<string, string[] | null> = {};
    const s = stat[key];
    if (isPlainObject(s)) {
      for (const [entry, value] of Object.entries(s)) {
        section[entry] = isPlainObject(value) ? Object.keys(value) : null;
      }
    }
    out[key] = section;
  }
  return out;
}

/**
 * Parses the remembered set defensively; a malformed section or entry is
 * skipped (→ nothing pruned there), never thrown on.
 */
function readRememberedContributions(dynamicCfg: Config): Partial<StaticContributions> {
  const raw = (dynamicCfg as unknown as { _dynamic?: { static_contributions?: unknown } })._dynamic?.static_contributions;
  const out: Partial<StaticContributions> = {};
  if (!isPlainObject(raw)) return out;
  for (const key of DYNAMIC_CONFIG_MERGE_KEYS) {
    const section = raw[key];
    if (!isPlainObject(section)) continue;
    const parsed: Record<string, string[] | null> = {};
    for (const [entry, fields] of Object.entries(section)) {
      if (fields === null) parsed[entry] = null;
      else if (Array.isArray(fields) && fields.every((f) => typeof f === 'string')) parsed[entry] = fields as string[];
    }
    out[key] = parsed;
  }
  return out;
}

/**
 * Removes from `dyn[key]` what the static layers contributed at the last
 * resync (`remembered`) but no longer declare (`current`), plus the
 * STATIC_AUTHORITATIVE_FIELDS the static layers lack. A pruned object entry
 * keeps its other (scan-added) fields and goes away only when nothing is
 * left of it. Only the container is replaced, never the shared entry objects.
 */
function pruneRemovedStaticEntries(
  dyn: Record<string, unknown>,
  key: MergeKey,
  remembered: Record<string, string[] | null> | undefined,
  current: Record<string, string[] | null>,
  dropped?: Set<string>,
): void {
  const entries = dyn[key];
  if (!isPlainObject(entries)) return;
  const pruned: Record<string, unknown> = { ...entries };
  const dropFields = (entry: string, fields: readonly string[]) => {
    const value = pruned[entry];
    if (!isPlainObject(value)) return;
    const rest = { ...value };
    for (const f of fields) delete rest[f];
    if (Object.keys(rest).length === 0) { delete pruned[entry]; dropped?.add(entry); }
    else pruned[entry] = rest;
  };
  for (const [entry, fields] of Object.entries(remembered ?? {})) {
    const now = current[entry];
    if (fields === null) {
      if (now === undefined) { delete pruned[entry]; dropped?.add(entry); }
    } else {
      const kept = Array.isArray(now) ? now : [];
      // A static entry that turned scalar replaces the dynamic one in the merge.
      if (now === null) continue;
      dropFields(entry, fields.filter((f) => !kept.includes(f)));
    }
  }
  for (const field of STATIC_AUTHORITATIVE_FIELDS[key] ?? []) {
    for (const entry of Object.keys(pruned)) {
      if (!(current[entry] ?? []).includes(field)) dropFields(entry, [field]);
    }
  }
  dyn[key] = pruned;
}

/**
 * Brings a (possibly stale) dynamic config up to date with the layered
 * static config, in place: DYNAMIC_CONFIG_RESYNC_KEYS are copied wholesale,
 * DYNAMIC_CONFIG_MERGE_KEYS are first pruned of what the static layers
 * dropped since the last resync, then merged per entry. `model_groups` stays
 * — it is the scan's output. Finally the current static contribution is
 * recorded in `_dynamic.static_contributions` for the next resync. Used by
 * both resync sites (index.ts load() and the src/dynamic-config-runner.ts write site).
 *
 * `contributions` defaults to the snapshot of `staticCfg`; the write site
 * passes one taken BEFORE the scan stub-registers providers into a config
 * that may alias staticCfg, so scan-added stubs are never recorded as static.
 */
export function resyncDynamicFromStatic(
  dynamicCfg: Config,
  staticCfg: Config,
  contributions: StaticContributions = collectStaticContributions(staticCfg),
): { droppedProviders: string[] } {
  const dyn = dynamicCfg as unknown as Record<string, unknown>;
  const stat = staticCfg as unknown as Record<string, unknown>;
  const remembered = readRememberedContributions(dynamicCfg);
  // Providers this resync DROPPED entirely (a static `billing` field removed
  // from a layer): load() re-registers exactly these as registry stubs so the
  // provider keeps its subscription billing until the next regeneration —
  // without it, the live group-admission and budget filters would treat it
  // as pay_per_token for up to a 30-day scan cycle (billingTier/the cost
  // rule read the static layers at load and heal at the next regeneration;
  // review M2, 2026-10-07). Only the dropped
  // ones: stubbing every unknown provider at load time would reorder tiered
  // groups (subscription ahead of local) BEFORE the first regeneration.
  const droppedProviders = new Set<string>();
  for (const key of DYNAMIC_CONFIG_RESYNC_KEYS) dyn[key] = stat[key];
  for (const key of DYNAMIC_CONFIG_MERGE_KEYS) {
    pruneRemovedStaticEntries(dyn, key, remembered[key], contributions[key], key === 'providers' ? droppedProviders : undefined);
    const s = stat[key];
    if (!isPlainObject(s)) continue;
    const merged: Record<string, unknown> = { ...(isPlainObject(dyn[key]) ? dyn[key] : {}) };
    for (const [entry, value] of Object.entries(s)) {
      const prev = merged[entry];
      merged[entry] = isPlainObject(prev) && isPlainObject(value) ? { ...prev, ...value } : value;
    }
    dyn[key] = merged;
  }
  if (isPlainObject(dyn._dynamic)) dyn._dynamic.static_contributions = contributions;
  return { droppedProviders: [...droppedProviders] };
}
