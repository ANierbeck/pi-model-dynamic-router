// src/metrics.ts
// Metrics management for the pi-model-router

import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
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
    console.warn(`[router] WARNING: model-map.yaml failed to parse (${err instanceof Error ? err.message : String(err)}); model-map overrides are DISABLED. Check for duplicate keys.`);
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
 * Strip provider prefix from ref: "chutes/deepseek-ai/DeepSeek-V3" → "deepseek-ai/DeepSeek-V3"
 */
export function stripProvider(ref: string): string {
  const i = ref.indexOf('/');
  if (i === -1) return ref;
  const prov = ref.slice(0, i);
  if (PROVIDER_MAP[prov] || cfg.providers?.[prov]) return ref.slice(i + 1);
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
 * Returns the GDPval slug that was matched for a model ref, or null.
 * Used for deduplication: models that match the same slug are the same model
 * (e.g. mistral-medium-2604 and mistral-medium-latest both → mistral-medium-3-5).
 */
export function getMatchedSlug(ref: string): string | null {
  // Check LLM match first
  if (llmModelMatches[ref]) return llmModelMatches[ref];
  // Check slug-matcher
  const slugKeys = Object.keys(gdpval);
  const matched = matchSlug(ref, slugKeys);
  return matched ?? null;
}

export function lookupGdp(id: string): number | null {
  // SELBSTHEILEND: stelle sicher, dass gdpval die gescrapten Scores enthält.
  if (Object.keys(gdpval).length === 0 && cache.gdpval_scores) {
    Object.assign(gdpval, cache.gdpval_scores);
    gdpvalVersion++;
  }

  // Stage 0: model-map.yaml explicit override (highest priority)
  // Explicit null means "exclude this model" — must be checked BEFORE the
  // algorithmic matcher, otherwise Turbo/Flash variants get matched to
  // their base model (e.g. GLM-5-Turbo → glm-5-2).
  const mapped = mapLookup(id);
  if (mapped === null) return null; // explicitly no score
  if (mapped !== undefined) {
    if (lastIndexVersion !== gdpvalVersion) buildGdpvalIndex();
    const key = [...baseTokens(mapped)].sort().join('|');
    return gdpvalIndex!.get(key) ?? null;
  }

  // Stage 1: LLM-assisted match (PRIMARY — semantically understands versions)
  // The LLM can distinguish glm-5-2 from glm-5-3, and knows that
  // mistral-medium-2604 = mistral-medium-3-5 (date-versioned).
  // Much more accurate than algorithmic token-set matching.
  const llmSlug = llmModelMatches[id];
  if (llmSlug) {
    const score = gdpval[llmSlug];
    if (score !== undefined) return score;
    if (lastIndexVersion !== gdpvalVersion) buildGdpvalIndex();
    const slugKey = [...baseTokens(llmSlug)].sort().join('|');
    const llmScore = gdpvalIndex!.get(slugKey);
    if (llmScore !== undefined) return llmScore;
  }

  // Stage 2: algorithmic slug-matcher (FALLBACK — only if LLM didn't match)
  // Less accurate but better than nothing. Uses version-aware token matching.
  const slugKeys = Object.keys(gdpval);
  const matchedSlug = matchSlug(id, slugKeys);
  if (matchedSlug === null) return null; // explicitly excluded (small/special model)
  if (matchedSlug !== undefined) {
    const score = gdpval[matchedSlug];
    if (score !== undefined) return score;
    if (lastIndexVersion !== gdpvalVersion) buildGdpvalIndex();
    const key = [...baseTokens(matchedSlug)].sort().join('|');
    return gdpvalIndex!.get(key) ?? null;
  }

  return null;
}

// ── Metrics Management ──────────────────────────────────────────────────

let metrics: Record<string, Metrics> = {};
let cfg: Config = { model_groups: {}, model_metrics: {}, providers: {} };
let cache: Cache = {};

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
 * artificialanalysis.ai), normalized to 0–100. Higher is better.
 */
export function calculateScore(ref: string, _taskType?: string, _config?: Config): number {
  return Math.min(100, getM(ref).gdpval / 10);
}

// ── Billing & Cost ────────────────────────────────────────────────────────

/**
 * Returns the billing tier for a reference
 * 0=free, 1=subscription, 2=local, 3=payg
 */
export function billingTier(ref: string): number {
  const prov = ref.split('/')[0];
  const provDef = PROVIDER_MAP[prov];
  const provCfg = cfg.providers?.[prov];
  const billing = provCfg?.billing ?? provDef?.billing ?? 'pay_per_token';

  // Local providers (ollama, lm-studio)
  if (provDef?.local) return 2;
  // Subscription providers
  if (billing === 'subscription') return 1;
  // Free models
  const discovered = (cache.available_models ?? []).find((m) => `${m.provider}/${m.id}` === ref);
  if (discovered?.cost_per_m === 0) return 0;
  return 3; // pay per token
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
  
  // 1. Use metrics cost_per_m if set
  let base: number | 'unknown' | undefined = m.cost_per_m;
  
  // 2. Look up in OpenRouter/Chutes pricing cache
  if (base === undefined || base === 0) {
    const price = lookupPrice(ref);
    if (price) {
      if (price.input === 'unknown' || price.output === 'unknown') {
        return 'unknown';
      }
      base = price.input; // use input price as representative
    }
  }
  
  // 3. Check if base is still unknown/undefined
  if (base === undefined || base === 0) {
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
