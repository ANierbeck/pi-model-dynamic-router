// src/metrics.ts
// Metrics management for the pi-model-router

import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
import type { Metrics, Config, Cache, Group, ModelRef } from './types.ts';
import { norm, stripDateSuffix, baseTokens, splitRef } from './utils.ts';
import { PROVIDER_MAP } from './providers.ts';


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
  } catch {
    // no map file, use fallback only
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
  if (PROVIDER_MAP[prov] || (global as any).cfg?.providers?.[prov]) return ref.slice(i + 1);
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
export function lookupGdp(id: string): number | null {
  // Primary: model-map.yaml explicit mapping
  const mapped = mapLookup(id);
  if (mapped === null) return null; // explicitly no score
  if (mapped !== undefined) {
    // Find the slug's score (take highest across parameter variants)
    if (lastIndexVersion !== gdpvalVersion) buildGdpvalIndex();
    const key = [...baseTokens(mapped)].sort().join('|');
    return gdpvalIndex!.get(key) ?? null;
  }
  // Fallback: automatic token-set matching
  if (lastIndexVersion !== gdpvalVersion) buildGdpvalIndex();
  const key = [...baseTokens(id)].sort().join('|');
  return gdpvalIndex!.get(key) ?? null;
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
    setGdpval(config.gdpval_builtin);
  }
}

/**
 * Sets the cache
 */
export function setCache(newCache: Cache): void {
  cache = newCache;
  if (cache.gdpval_scores) {
    setGdpval(cache.gdpval_scores);
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
  if (metrics[ref]) return metrics[ref];

  const cm = cfg.model_metrics[ref] ?? {};

  return (metrics[ref] = {
    gdpval: lookupGdp(ref) ?? cm.gdpval ?? 50,
    throughput_tps: cm.throughput_tps ?? 100,
    avg_latency_ms: cm.avg_latency_ms ?? 1000,
    cost_per_m: cm.cost_per_m ?? 0,
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
 */
export function lookupPrice(ref: string): { input: number; output: number } | null {
  // 1. Check config metrics first
  const cm = cfg.model_metrics[ref];
  if (cm?.cost_per_m) return { input: cm.cost_per_m, output: cm.cost_per_m };

  // 2. Check pricing cache by exact provider/model ref
  if (cache.openrouter_pricing?.[ref]) return cache.openrouter_pricing[ref];

  // 3. Backfill: find paid OpenRouter pricing for same model
  const { modelId } = splitRef(ref);
  const n = norm(modelId);
  for (const [k, v] of Object.entries(cache.openrouter_pricing ?? {})) {
    if (v.input <= 0) continue; // skip free-tier
    const kModel = k.indexOf('/') >= 0 ? k.slice(k.indexOf('/') + 1) : k;
    if (norm(kModel) === n) return v;
  }
  return null;
}

/**
 * Calculates the effective cost for a reference
 */
export function effCost(ref: string): number {
  const m = getM(ref),
    prov = ref.split('/')[0];
  // 1. Use metrics cost_per_m if set
  let base = m.cost_per_m;
  // 2. Look up in OpenRouter/Chutes pricing cache
  if (!base) {
    const price = lookupPrice(ref);
    if (price) base = price.input; // use input price as representative
  }
  // 3. Fallback to tiny base (costMux still differentiates free models)
  if (!base) base = 0.01;
  // Apply subscription discount
  if (cfg.providers?.[prov]?.billing === 'subscription') base *= SUB_DISCOUNT;
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
