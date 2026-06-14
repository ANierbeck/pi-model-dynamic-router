// src/metrics.ts
// Metriken-Verwaltung für den pi-model-router

import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
import type { Metrics, Config, Cache, Group, ModelRef } from './types.ts';
import { norm, stripDateSuffix, baseTokens, splitRef } from './utils.ts';
import { PROVIDER_MAP } from './providers.ts';

// Extended metrics interface for benchmark data
interface ExtendedMetrics extends Metrics {
  mmlu?: number;
  gpqa?: number;
  truthful?: number;
  humaneval?: number;
  swebench?: number;
}

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
 * Lädt die Model-Map aus der YAML-Datei
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
 * Setzt die GDPval-Scores
 */
export function setGdpval(scores: Record<string, number>): void {
  gdpval = { ...scores };
  gdpvalVersion++;
}

/**
 * Setzt die Model-Map
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
 * Setzt die Konfiguration
 */
export function setConfig(config: Config): void {
  cfg = config;
  if (config.gdpval_builtin) {
    setGdpval(config.gdpval_builtin);
  }
}

/**
 * Setzt den Cache
 */
export function setCache(newCache: Cache): void {
  cache = newCache;
  if (cache.gdpval_scores) {
    setGdpval(cache.gdpval_scores);
  }
}

/**
 * Setzt die Metriken
 */
export function setMetrics(newMetrics: Record<string, Metrics>): void {
  metrics = newMetrics;
}

/**
 * Gibt die Metriken für eine Referenz zurück
 * Inklusive Benchmark-Daten falls verfügbar
 */
export function getM(ref: string): Metrics & ExtendedMetrics {
  if (metrics[ref]) return metrics[ref] as Metrics & ExtendedMetrics;
  
  const cm = cfg.model_metrics[ref] ?? {};
  const benchmarks = cfg.model_benchmarks?.[ref] ?? {};
  
  return (metrics[ref] = {
    gdpval: lookupGdp(ref) ?? cm.gdpval ?? 50,
    throughput_tps: cm.throughput_tps ?? 100,
    avg_latency_ms: cm.avg_latency_ms ?? 1000,
    cost_per_m: cm.cost_per_m ?? 0,
    last_updated: Date.now(),
    // Benchmark-Daten
    mmlu: benchmarks.mmlu,
    gpqa: benchmarks.gpqa,
    truthful: benchmarks.truthful,
    humaneval: benchmarks.humaneval,
    swebench: benchmarks.swebench
  } as Metrics & ExtendedMetrics);
}

/**
 * Aktualisiert die Metriken für eine Referenz
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
 * Berechnet einen gewichteten Score basierend auf mehreren Metriken
 * Alle Metriken werden auf die gleiche Skala (0-100) normalisiert
 * @param ref - Modell-Referenz (z.B. "anthropic/claude-3-sonnet")
 * @param taskType - Optionaler Aufgabentyp für spezifische Gewichtung (z.B. "code")
 * @param config - Konfiguration für Zugriff auf model_metadata und model_benchmarks
 */
export function calculateScore(ref: string, taskType?: string, config?: Config): number {
  const m = getM(ref);
  const metadata = config?.model_metadata?.[ref] ?? cfg.model_metadata?.[ref] ?? {};
  const benchmarks = config?.model_benchmarks?.[ref] ?? cfg.model_benchmarks?.[ref] ?? {};
  
  // Normalisiere GDPval von 0-1000 auf 0-100 Skala
  const normalizedGdpval = Math.min(100, m.gdpval / 10);
  
  // Basis-Score: Normalisierter GDPval (40% Gewicht)
  let score = normalizedGdpval * 0.4;
  
  // Benchmark-Bonus (60% Gewicht verteilt auf Benchmarks)
  // Alle Benchmarks sind bereits in 0-100 Skala
  if (benchmarks.mmlu != null || m.mmlu != null) score += (benchmarks.mmlu ?? m.mmlu ?? 0) * 0.2;    // 20% Gewicht
  if (benchmarks.gpqa != null || m.gpqa != null) score += (benchmarks.gpqa ?? m.gpqa ?? 0) * 0.12;   // 12% Gewicht
  if (benchmarks.truthful != null || m.truthful != null) score += (benchmarks.truthful ?? m.truthful ?? 0) * 0.08; // 8% Gewicht
  if (benchmarks.humaneval != null || m.humaneval != null) score += (benchmarks.humaneval ?? m.humaneval ?? 0) * 0.1; // 10% Gewicht
  if (benchmarks.swebench != null || m.swebench != null) score += (benchmarks.swebench ?? m.swebench ?? 0) * 0.1;  // 10% Gewicht
  
  // Generations-Bonus: +2 Punkte pro Generation über 3 (auf 0-100 Skala)
  if (metadata.generation) {
    const generationBonus = Math.max(0, metadata.generation - 3) * 2;
    score += generationBonus;
  }
  
  // Aufgaben-spezifische Anpassungen
  if (taskType === 'code') {
    // Für Code-Aufgaben: Gewichte umverteilen (nicht addieren!)
    // Reduziere Allround-Benchmarks, erhöhe Code-Benchmarks
    score = normalizedGdpval * 0.3; // GDPval auf 30% reduzieren
    if (benchmarks.mmlu != null || m.mmlu != null) score += (benchmarks.mmlu ?? m.mmlu ?? 0) * 0.1;    // MMLU auf 10% reduzieren
    if (benchmarks.gpqa != null || m.gpqa != null) score += (benchmarks.gpqa ?? m.gpqa ?? 0) * 0.05;   // GPQA auf 5% reduzieren
    if (benchmarks.truthful != null || m.truthful != null) score += (benchmarks.truthful ?? m.truthful ?? 0) * 0.05; // Truthful auf 5% reduzieren
    if (benchmarks.humaneval != null || m.humaneval != null) score += (benchmarks.humaneval ?? m.humaneval ?? 0) * 0.2; // HumanEval auf 20% erhöhen
    if (benchmarks.swebench != null || m.swebench != null) score += (benchmarks.swebench ?? m.swebench ?? 0) * 0.2;  // SWE-bench auf 20% erhöhen
  }
  
  return score;
}

// ── Billing & Cost ────────────────────────────────────────────────────────

/**
 * Gibt die Billing-Tier für eine Referenz zurück
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
 * Sucht den Preis für eine Referenz
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
 * Berechnet die effektiven Kosten für eine Referenz
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
 * Gibt den Cost-Multiplikator für einen Provider zurück
 */
export function costMux(prov: string): number {
  return cache.cost_mux?.[prov] ?? 1;
}

// ── Usage Stats ──────────────────────────────────────────────────────────

/**
 * Gibt die Token-Nutzung für eine Referenz in den letzten Tagen zurück
 */
export function getUsage(ref: string, days: number): number {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return (cache.usage_log ?? [])
    .filter((e) => e.ref === ref && e.ts > cutoff)
    .reduce((sum, e) => sum + e.tokens, 0);
}

/**
 * Gibt die Token-Nutzung für alle Referenzen in den letzten Tagen zurück
 */
export function getUsageAll(days: number): Record<string, number> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const result: Record<string, number> = {};
  for (const e of cache.usage_log ?? []) {
    if (e.ts > cutoff) result[e.ref] = (result[e.ref] ?? 0) + e.tokens;
  }
  return result;
}
