// src/metrics.ts
// Metrics management for the pi-model-router
//
// ── GDPval: the SINGLE resolution pipeline (A2) ─────────────────────────
//
// GDPval scores come from THREE sources that answer TWO different questions.
// This module is the ONLY place that resolves both, so no other code may
// re-implement this merge (a second, drifted copy in src/model-matcher.ts
// was removed for exactly this reason — see its file header).
//
// Q1: "which GDPval SLUG does this model ref mean?" — resolveSlug()
//   Stage 0: model-map.yaml explicit override (mapLookup) — authoritative,
//            curated by hand; an explicit `null` means "exclude this model".
//   Stage 1: LLM-assisted match (setLlmMatches, cached in
//            cache.model_score_cache) — semantic fallback for vendor-
//            prefixed / renamed ids the map doesn't cover yet.
//   Stage 2: algorithmic fuzzy matcher (slug-matcher.ts matchSlug) — cheap,
//            deterministic last resort.
//
// Q2: "what SCORE does that slug have?" — the `gdpval` map (lookupGdp)
//   cfg.gdpval_builtin   (highest — our own curated overrides, e.g.
//                         mistral-medium-3-5:933; AA's scrape never has
//                         these slugs) always wins for a given slug.
//   cache.gdpval_scores  (scraped from Artificial Analysis + Ollama
//                         heuristic estimates) fills in everything else.
//   These two merge ADDITIVELY into the in-memory `gdpval` map (setConfig/
//   setCache: Object.assign, builtin applied last → wins on conflict).
//   Self-healing (see resolveSlug below) guards against setGdpval()'s
//   REPLACE semantics wiping builtins mid-session.
//
// model-map.yaml is NOT a score source — it only answers Q1. Conflating it
// with a "third score source" was the root of the original confusion; it
// always defers to the `gdpval` map (Q2) for the actual number.

import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
import { routerLog } from './logger.ts';
import type { Metrics, Config, Cache, Group, ModelRef } from './types.ts';
import { norm, stripDateSuffix, baseTokens, splitRef } from './utils.ts';
import { PROVIDER_MAP } from './providers.ts';
import { matchSlug } from './slug-matcher.ts';


// ── Constants ────────────────────────────────────────────────────────────

const SUB_DISCOUNT = 0.5; // Subscription discount factor

// ── Model Map: authoritative model → GDPval slug mapping ──────────────────

type ModelMap = Record<string, string | null>;
let modelMap: ModelMap = {};
let modelMapWildcards: [string, string | null][] = []; // [prefix, slug]
let gdpval: Record<string, number> = {};
let gdpvalVersion = 0;
let gdpvalIndex: Map<string, number> | null = null;
let lastIndexVersion = -1;

/**
 * Loads the model map from the YAML file
 */
export function loadModelMap(extDir: string): void {
  const yamlPath = path.join(extDir, 'model-map.yaml');
  try {
    const raw = YAML.parse(fs.readFileSync(yamlPath, 'utf-8')) as Record<string, string | null>;
    modelMap = {};
    modelMapWildcards = [];
    for (const [key, slug] of Object.entries(raw)) {
      if (key === null || typeof key !== 'string') continue;
      if (key.endsWith('*')) {
        modelMapWildcards.push([key.slice(0, -1), slug]);
      } else {
        modelMap[key] = slug;
      }
    }
    // Sort wildcards longest-first for most specific match
    modelMapWildcards.sort((a, b) => b[0].length - a[0].length);
  } catch (err) {
    // CRITICAL: a parse error (e.g. duplicate YAML keys) leaves modelMap EMPTY,
    // so ALL model-map overrides silently stop working and every model falls
    // through to the lossy token-set + LLM fallback. Log loudly so this is
    // never silent again.
    routerLog(`[router] WARNING: model-map.yaml failed to parse (${err instanceof Error ? err.message : String(err)}); model-map overrides are DISABLED. Check for duplicate keys.`);
    modelMap = {};
    modelMapWildcards = [];
  }
}

/**
 * Sets the GDPval scores
 */
export function setGdpval(scores: Record<string, number>): void {
  gdpval = { ...scores };
  gdpvalVersion++;
}

/** Read-only access to the current gdpval scores (for the LLM matcher prompt). */
export function getGdpval(): Record<string, number> {
  return gdpval;
}

/**
 * Sets the model map
 */
export function setModelMap(map: ModelMap, wildcards: [string, string | null][]): void {
  modelMap = map;
  modelMapWildcards = wildcards;
}

/**
 * Strip provider prefix from ref: "chutes/deepseek-ai/DeepSeek-V3" → "deepseek-ai/DeepSeek-V3".
 * Only strips a KNOWN provider prefix — an unrecognized first segment is left
 * alone, since it might be part of the model id itself rather than a provider.
 * A provider is "known" if it is in:
 *   1. PROVIDER_MAP (the router's static provider definitions), OR
 *   2. cfg.providers (user config), OR
 *   3. piRegisteredProviders (pi's own modelRegistry — F11, 2026-09-02).
 * The third source is what makes pi-registered providers like 'pi-claude',
 * 'claude-bridge', and extension providers work: without it, stripProvider
 * would leave 'pi-claude/claude-sonnet-5' intact and GDPval/price inference
 * would never resolve the model id.
 * This is the only implementation; a second, unconditional-strip copy in
 * utils.ts was dead code (imported nowhere) and has been removed.
 */
export function stripProvider(ref: string): string {
  const i = ref.indexOf('/');
  if (i === -1) return ref;
  const prov = ref.slice(0, i);
  if (PROVIDER_MAP[prov] || cfg.providers?.[prov] || piRegisteredProviders.has(prov)) {
    return ref.slice(i + 1);
  }
  return ref;
}

/**
 * Look up GDPval slug for a model ref using model-map.yaml
 */
export function mapLookup(ref: string): string | null | undefined {
  const modelId = stripProvider(ref);
  // Exact match
  if (modelId in modelMap) return modelMap[modelId];
  // Wildcard match (longest prefix first)
  for (const [prefix, slug] of modelMapWildcards) {
    if (modelId.startsWith(prefix)) return slug;
  }
  return undefined; // not in map
}

/**
 * Build GDPval index for fallback matching
 */
function buildGdpvalIndex(): void {
  gdpvalIndex = new Map();
  for (const [slug, score] of Object.entries(gdpval)) {
    const key = [...baseTokens(slug)].sort().join('|');
    const existing = gdpvalIndex.get(key);
    if (existing === undefined || score > existing) gdpvalIndex.set(key, score);
  }
  lastIndexVersion = gdpvalVersion;
}

/**
 * Lookup GDPval score for a model
 */
// ── LLM-assisted matches (3rd-tier fallback) ─────────────────────────────
// Populated by index.ts (populateLlmMatches) once per scan. Maps a model
// ref (e.g. "mistral-zai/zai-glm-5-2") to a gdpval slug that an LLM
// confidently matched. lookupGdp consults this AFTER the token-set fallback.
let llmModelMatches: Record<string, string> = {};

/** Set the LLM-derived model→slug matches (called from index.ts populateLlmMatches). */
export function setLlmMatches(matches: Record<string, string>): void {
  llmModelMatches = { ...matches };
}

/**
 * Resolve a model ref to its authoritative GDPval slug through the SAME
 * pipeline lookupGdp uses. Returns:
 *   string     — the matched slug (e.g. "mistral-medium-3-5")
 *   null       — explicitly excluded (mapLookup returned null, or matchSlug
 *                flagged it as a small/special model)
 *   undefined  — no match found at any stage
 *
 * This is the SINGLE source of truth for "which slug belongs to this ref".
 * Both lookupGdp (scoring) and getMatchedSlug (dedup) MUST go through here
 * so dedup and scoring can never disagree on model identity.
 *
 * Stage order (mirrors lookupGdp exactly):
 *   0. model-map.yaml explicit override (mapLookup)
 *   1. LLM-assisted match (in-memory + cached)
 *   2. algorithmic slug-matcher (fuzzy token-set)
 */
export function resolveSlug(ref: string): string | null | undefined {
  // SELF-HEALING, two independent checks:
  //
  // 1. gdpval completely empty (e.g. a fresh module load before any setCache
  //    call ran yet) → restore from cache.gdpval_scores.
  if (Object.keys(gdpval).length === 0 && cache.gdpval_scores) {
    Object.assign(gdpval, cache.gdpval_scores);
    gdpvalVersion++;
  }

  // 2. gdpval is non-empty but missing known gdpval_builtin entries. This
  //    happens after scan()'s AA scrape calls setGdpval(freshlyScrapedScores)
  //    — setGdpval REPLACES the entire gdpval map (`gdpval = {...scores}`),
  //    wiping whatever setConfig() had merged in earlier (gdpval_builtin is
  //    OUR OWN curated data, e.g. mistral-medium-3-5:933 — Artificial
  //    Analysis's scrape never contains these slugs, so a fresh scrape
  //    silently drops every model that only resolves through a builtin).
  //    Nothing re-applies gdpval_builtin before generateDynamicConfig runs,
  //    so the check-1 self-heal above doesn't fire (gdpval isn't EMPTY, just
  //    incomplete) — this caused a real scoring collapse (13/148 scored)
  //    caught by scan-sanity.ts on 2026-08-23. cfg.gdpval_builtin (set once
  //    by setConfig(), untouched by setGdpval()) is the reliable source to
  //    heal from — cache.gdpval_scores is NOT reliable here, since scan()
  //    writes the same wiped gdpval right back into cache.gdpval_scores
  //    immediately after the setGdpval() call.
  if (cfg.gdpval_builtin) {
    const missingBuiltin = Object.keys(cfg.gdpval_builtin).some((k) => !(k in gdpval));
    if (missingBuiltin) {
      Object.assign(gdpval, cfg.gdpval_builtin);
      gdpvalVersion++;
    }
  }

  // Stage 0: model-map.yaml explicit override (highest priority)
  // Explicit null means "exclude this model" — must be checked BEFORE the
  // algorithmic matcher, otherwise Turbo/Flash variants get matched to
  // their base model (e.g. GLM-5-Turbo → glm-5-2).
  const mapped = mapLookup(ref);
  if (mapped === null) return null; // explicitly excluded
  if (mapped !== undefined) return mapped; // explicit slug — authoritative

  // Stage 1: LLM-assisted match (semantically understands versions)
  // The LLM can distinguish glm-5-2 from glm-5-3, and knows that
  // mistral-medium-2604 = mistral-medium-3-5 (date-versioned).
  if (llmModelMatches[ref]) return llmModelMatches[ref];
  // Cached LLM matches (from cache.model_score_cache). Needed because esbuild
  // may bundle two instances of this module, and the routing.ts instance
  // doesn't share in-memory state with index.ts.
  const cached = (cache as any)?.model_score_cache?.[ref];
  if (cached && typeof cached === 'string') return cached;

  // Stage 2: algorithmic slug-matcher (FALLBACK — only if LLM didn't match)
  const scores = Object.keys(gdpval).length > 0 ? gdpval : (cache.gdpval_scores ?? {});
  const slugKeys = Object.keys(scores);
  return matchSlug(ref, slugKeys);
}

/**
 * Returns the GDPval slug that was matched for a model ref, or null.
 * Used for deduplication: models that match the same slug are the same model
 * (e.g. mistral-medium-2604 and mistral-medium-latest both → mistral-medium-3-5).
 *
 * Thin wrapper over resolveSlug — dedup now uses the SAME pipeline as scoring,
 * so the two can never disagree on model identity.
 */
export function getMatchedSlug(ref: string): string | null {
  return resolveSlug(ref) ?? null;
}

export function lookupGdp(id: string): number | null {
  // Resolve the slug through the unified pipeline first.
  const slug = resolveSlug(id);
  if (slug === null) return null; // explicitly excluded
  if (slug === undefined) return null; // no match at any stage

  if (lastIndexVersion !== gdpvalVersion) buildGdpvalIndex();

  // Direct slug → score (fast path)
  const direct = gdpval[slug];
  if (direct !== undefined) return direct;

  // Token-set fallback (slug may be a synonym whose score is stored under
  // a different key, e.g. mapped slug "mistral-medium-3-5" but score under
  // a token-equivalent key).
  const key = [...baseTokens(slug)].sort().join('|');
  return gdpvalIndex!.get(key) ?? null;
}

// ── Metrics Management ──────────────────────────────────────────────────

let metrics: Record<string, Metrics> = {};
let cfg: Config = { model_groups: {}, model_metrics: {}, providers: {} };
let cache: Cache = {};

/**
 * Provider IDs that pi's own modelRegistry has registered (e.g. 'pi-claude',
 * 'claude-bridge', 'ollama', 'lm-studio', plus anything an extension
 * registers). Populated by index.ts from
 * `sessionCtx.modelRegistry.getRegisteredProviderIds()` so the router
 * recognizes pi-registered providers it has no static PROVIDER_MAP entry for
 * (F11, 2026-09-02). Without this, stripProvider() leaves the full
 * 'pi-claude/claude-sonnet-5' ref intact because 'pi-claude' is neither in
 * PROVIDER_MAP nor cfg.providers — breaking GDPval/price inference for
 * every pi-registered provider.
 */
let piRegisteredProviders: Set<string> = new Set();

/**
 * Reports the set of provider IDs pi's modelRegistry has registered, so
 * stripProvider() and other lookups can recognize pi-managed providers
 * (F11). Call this from index.ts after `session_start` once
 * `getRegisteredProviderIds()` is available, and again after any
 * `registerProvider` call that adds a new provider.
 */
export function setPiRegisteredProviders(ids: Iterable<string>): void {
  piRegisteredProviders = new Set(ids);
}

/** For tests: read back the registered-provider set. */
export function getPiRegisteredProviders(): Set<string> {
  return piRegisteredProviders;
}

/**
 * Sets the configuration
 */
export function setConfig(config: Config): void {
  cfg = config;
  if (config.gdpval_builtin) {
    // Additive merge (like the original closure): add builtins to EXISTING
    // gdpval scores, don't replace them. Builtins override scraped scores
    // for the same slug (manual correction takes precedence).
    Object.assign(gdpval, config.gdpval_builtin);
    gdpvalVersion++;
  }
}

/**
 * Sets the cache
 */
export function setCache(newCache: Cache): void {
  cache = newCache;
  if (cache.gdpval_scores) {
    // Additive merge: add scraped scores to EXISTING gdpval (which may have
    // builtins from setConfig). Builtins take precedence (manual overrides
    // win over scraped values).
    const merged: Record<string, number> = { ...cache.gdpval_scores };
    if (cfg.gdpval_builtin) {
      Object.assign(merged, cfg.gdpval_builtin);
    }
    Object.assign(gdpval, merged);
    gdpvalVersion++;
  }
}

/**
 * Sets the metrics
 */
export function setMetrics(newMetrics: Record<string, Metrics>): void {
  metrics = newMetrics;
}

/**
 * Returns the metrics for a reference
 * Including benchmark data if available
 */
export function getM(ref: string): Metrics {
  if (metrics[ref]) {
    // gdpval is NOT cached — it can change as model-map / scraped scores
    // load. Always recompute it so the TUI reflects the current state.
    metrics[ref].gdpval = lookupGdp(ref) ?? cfg.model_metrics?.[ref]?.gdpval ?? 50;
    return metrics[ref];
  }

  const cm = cfg.model_metrics[ref] ?? {};
  
  // Check if cost_per_m is explicitly set to 'unknown' in config
  let costPerM: number | 'unknown' = cm.cost_per_m ?? 0;
  
  // If cost is 0, check if it's a local provider (truly free) or unknown
  if (costPerM === 0) {
    const prov = ref.split('/')[0];
    const provDef = PROVIDER_MAP[prov];
    const provCfg = cfg.providers?.[prov];
    
    // Local providers are truly free
    if (provDef?.local) {
      costPerM = 0;
    }
    // Subscription providers with no pricing data are free
    else if (provCfg?.billing === 'subscription') {
      costPerM = 0;
    }
    // For discovered models, check if cost_per_m is explicitly 0
    else {
      const discovered = (cache.available_models ?? []).find((m) => `${m.provider}/${m.id}` === ref);
      if (discovered?.cost_per_m === 0) {
        costPerM = 0;
      } else {
        costPerM = 'unknown';
      }
    }
  }

  return (metrics[ref] = {
    gdpval: lookupGdp(ref) ?? cm.gdpval ?? 50,
    throughput_tps: cm.throughput_tps ?? 100,
    avg_latency_ms: cm.avg_latency_ms ?? 1000,
    cost_per_m: costPerM,
    last_updated: Date.now(),
  });
}

/**
 * Updates the metrics for a reference
 */
export function updateMetrics(ref: string, latMs: number, tokens: number, durMs: number): void {
  const m = getM(ref),
    α = 0.3;
  m.avg_latency_ms = m.avg_latency_ms * (1 - α) + latMs * α;
  if (durMs > 0 && tokens > 0) {
    m.throughput_tps = m.throughput_tps * (1 - α) + (tokens / durMs) * 1000 * α;
    if (!cache.benchmarks) cache.benchmarks = {};
    cache.benchmarks[ref] = m.throughput_tps;
  }
  m.last_updated = Date.now();
}

// ── Multi-Metric Scoring ────────────────────────────────────────────────

/**
 * Calculates a quality score for a model reference.
 * Uses GDPval (composite intelligence + throughput + cost-efficiency score from
 * artificialanalysis.ai) directly. Higher is better.
 *
 * Deliberately uncapped: scraped gdpval_scores in the scan cache now
 * routinely exceed 1000 (e.g. claude-sonnet-5=1603, glm-5-2=1497,
 * minimax-m3=1380) since artificialanalysis.ai rescaled its benchmark.
 * A Math.min(100, gdpval / 10) cap here used to be harmless when scores
 * topped out around 700-800, but once several elite models cross the
 * 1000 threshold they all saturate at the same capped score of 100 and
 * the 'best' sort degenerates to insertion order among them — observed
 * in production as openrouter/minimax-m2.7:free (gdpval 1157, capped to
 * 100) outranking pi-claude/claude-sonnet-5 (gdpval 1603, also capped to
 * 100) in the tactical group, so a stronger model's rate limit caused a
 * silent quality downgrade to a much weaker free model instead of falling
 * through to the next-best paid/subscription candidate.
 */
export function calculateScore(ref: string, _taskType?: string, _config?: Config): number {
  return getM(ref).gdpval;
}

// ── Billing & Cost ────────────────────────────────────────────────────────

/**
 * PURE helper: is `ref` a free model? Takes explicit cfg/cache args so it
 * can be used both from modul-state-bound code (billingTier) AND from
 * context-bound code (exclude.ts isExcluded) without coupling the latter to
 * global module state.
 *
 * A model is free iff:
 *   - its provider is local (ollama, lm-studio) — local compute is $0, OR
 *   - the ref carries an explicit `:free` tag, OR
 *   - it's listed in the provider's `free_models` config (any normalization), OR
 *   - it was discovered with cost_per_m === 0
 *
 * Note: local providers return true here too (they ARE free in the $0 sense),
 * even though billingTier classifies them as tier 2 (local), not tier 0.
 * Callers that need the tier should use billingTier(); callers that only need
 * the free/paid dichotomy (like exclude.ts paid_models_from) can use this.
 */
export function isFreeModelRef(
  ref: string,
  providers: Config['providers'],
  availableModels: Cache['available_models']
): boolean {
  const prov = ref.split('/')[0];
  const provDef = PROVIDER_MAP[prov];
  // Local providers are $0 — free in the cost sense.
  if (provDef?.local) return true;
  // Explicit :free tag in the ref (e.g. openrouter/.../gpt-4o-mini:free)
  if (ref.includes(':free')) return true;
  // Listed in the provider's free_models config (any normalization)
  const provCfg = providers?.[prov];
  if (provCfg?.free_models) {
    const freeList = provCfg.free_models;
    if (freeList.includes(ref)) return true;
    const bare = ref.includes('/') ? ref.split('/').slice(1).join('/') : ref;
    if (freeList.includes(bare)) return true;
    if (freeList.includes(`${prov}/${bare}`)) return true;
  }
  // Discovered with cost_per_m === 0
  const discovered = (availableModels ?? []).find((m) => `${m.provider}/${m.id}` === ref);
  if (discovered?.cost_per_m === 0) return true;
  return false;
}

/**
 * Returns the billing tier for a reference
 * 0=free, 1=subscription, 2=local, 3=payg
 *
 * SINGLE SOURCE OF TRUTH for "which billing tier does this model belong to".
 * fmtModel (display), hasModelBudget (budget check), sortByBillingPreference
 * (routing) MUST all go through here so
 * they can never disagree on whether a model is free/subscription/local/payg.
 *
 * "Free" (tier 0) uses isFreeModelRef for the :free tag + free_models list +
 * discovered cost_per_m===0 checks (but NOT the local-provider case, since
 * local is its own tier 2 — local models are $0 but classified as local, not
 * free, so they rank differently under sortByBillingPreference).
 */
export function billingTier(ref: string): number {
  const prov = ref.split('/')[0];
  const provDef = PROVIDER_MAP[prov];
  const provCfg = cfg.providers?.[prov];
  const billing = provCfg?.billing ?? provDef?.billing ?? 'pay_per_token';

  // Local providers (ollama, lm-studio) — their own tier, ahead of payg
  if (provDef?.local) return 2;
  // Subscription providers
  if (billing === 'subscription') return 1;
  // Free models (excluding local, which is already handled above):
  //   :free tag OR free_models config list OR discovered cost_per_m === 0
  if (ref.includes(':free')) return 0;
  if (provCfg?.free_models) {
    const freeList = provCfg.free_models;
    if (freeList.includes(ref)) return 0;
    const bare = ref.includes('/') ? ref.split('/').slice(1).join('/') : ref;
    if (freeList.includes(bare)) return 0;
    if (freeList.includes(`${prov}/${bare}`)) return 0;
  }
  const discovered = (cache.available_models ?? []).find((m) => `${m.provider}/${m.id}` === ref);
  if (discovered?.cost_per_m === 0) return 0;
  return 3; // pay per token
}

/**
 * Whether `ref` is free for the paid_models_from rule (cost $0, including
 * local). Convenience over isFreeModelRef with module-state args — mirrors
 * exclude.ts isFreeModel. Use isFreeModelRef directly when you have a ctx.
 */
export function isFreeModel(ref: string): boolean {
  return isFreeModelRef(ref, cfg.providers, cache.available_models);
}

/**
 * Looks up the price for a reference
 * Returns null if not found, or { input: 'unknown', output: 'unknown' } if model exists but price is unknown
 */
export function lookupPrice(ref: string): { input: number | 'unknown'; output: number | 'unknown' } | null {
  // 1. Check config metrics first
  const cm = cfg.model_metrics[ref];
  if (cm?.cost_per_m !== undefined) {
    const cost = cm.cost_per_m;
    if (cost === 'unknown') {
      return { input: 'unknown', output: 'unknown' };
    }
    return { input: cost, output: cost };
  }

  // 2. Check pricing cache by exact provider/model ref
  if (cache.openrouter_pricing?.[ref]) {
    const price = cache.openrouter_pricing[ref];
    // If price exists but is 0, check if it's explicitly free or unknown
    if (price.input === 0 && price.output === 0) {
      // Check if this is a known free model
      const discovered = (cache.available_models ?? []).find((m) => `${m.provider}/${m.id}` === ref);
      const prov = ref.split('/')[0];
      const freeModels = cfg.providers?.[prov]?.free_models ?? [];
      
      if (discovered?.cost_per_m === 0 || freeModels.includes(ref)) {
        return { input: 0, output: 0 };
      }
      // Otherwise, it's unknown
      return { input: 'unknown', output: 'unknown' };
    }
    return price;
  }

  // 3. Backfill: find paid OpenRouter pricing for same model
  const { provider, modelId } = splitRef(ref);
  const n = norm(modelId);
  for (const [k, v] of Object.entries(cache.openrouter_pricing ?? {})) {
    if (v.input <= 0) continue; // skip free-tier
    const kModel = k.indexOf('/') >= 0 ? k.slice(k.indexOf('/') + 1) : k;
    if (norm(kModel) === n) return v;
  }

  // 4. Fallback: use provider-based cost estimate if available
  if (cfg.providers?.[provider]?.cost_per_m !== undefined) {
    const cost = cfg.providers[provider].cost_per_m;
    return { input: cost, output: cost };
  }

  return null;
}

/**
 * Calculates the effective cost for a reference
 * Returns 'unknown' if cost cannot be determined
 */
export function effCost(ref: string): number | 'unknown' {
  const m = getM(ref),
    prov = ref.split('/')[0];
  
  // 1. Use metrics cost_per_m if set to a non-zero value.
  //    cost_per_m: 0 is a valid value (free model) and must NOT trigger
  //    the fallback to lookupPrice or the 0.000020 default — that would
  //    cause max_cost: 0 groups to exclude free models!
  let base: number | 'unknown' | undefined = m.cost_per_m;
  if (base === 0) return 0; // explicitly free
  
  // 2. Look up in OpenRouter/Chutes pricing cache
  if (base === undefined) {
    const price = lookupPrice(ref);
    if (price) {
      if (price.input === 'unknown' || price.output === 'unknown') {
        return 'unknown';
      }
      base = price.input; // use input price as representative
    }
  }
  
  // 3. Check if base is still unknown/undefined
  if (base === undefined) {
    // Local providers (ollama, lm-studio) are truly free
    const provDef = PROVIDER_MAP[prov];
    if (provDef?.local) return 0;
    
    // Try provider-based cost estimate
    const provCost = cfg.providers?.[prov]?.cost_per_m;
    if (provCost !== undefined) {
      return provCost;
    }
    
    // Unknown cost — assume high to be safe
    return 0.000020; // ~$20/Mio Tokens
  }
  
  // At this point, base must be a number
  if (typeof base !== 'number') {
    return 'unknown';
  }
  
  // Apply subscription discount
  if (cfg.providers?.[prov]?.billing === 'subscription') {
    base *= SUB_DISCOUNT;
  }
  
  return base * costMux(prov);
}

/**
 * Returns the cost multiplier for a provider
 */
export function costMux(prov: string): number {
  return cache.cost_mux?.[prov] ?? 1;
}

// ── Usage Stats ──────────────────────────────────────────────────────────

/**
 * Returns the token usage for a reference over the last days
 */
export function getUsage(ref: string, days: number): number {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return (cache.usage_log ?? [])
    .filter((e) => e.ref === ref && e.ts > cutoff)
    .reduce((sum, e) => sum + e.tokens, 0);
}

/**
 * Returns the token usage for all references over the last days
 */
export function getUsageAll(days: number): Record<string, number> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const result: Record<string, number> = {};
  for (const e of cache.usage_log ?? []) {
    if (e.ts > cutoff) result[e.ref] = (result[e.ref] ?? 0) + e.tokens;
  }
  return result;
}
