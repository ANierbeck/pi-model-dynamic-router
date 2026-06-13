// src/types.ts
// TypeScript-Typdefinitionen für den pi-model-router

import type { Model } from '@mariozechner/pi-ai';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

// ── Core Types ────────────────────────────────────────────────────────────

export interface Defaults {
  gdpval_url: string;
  backoff_minutes: number[];
  soft_backoff_ms: number[];
  cost_mux_at_hit: number;
  sub_discount: number;
  models_ttl_ms: number;
  max_stream_retries: number;
  empty_response_timeout_ms: number;
  strip_suffixes: string[];
}

export interface Metrics {
  gdpval: number;
  throughput_tps: number;
  avg_latency_ms: number;
  cost_per_m: number;
  last_updated: number;
}

export interface RateLimit {
  cooldown_until: number;
  backoff_ms: number;
  hits: number;
}

export interface PipeStep {
  method: string;
  top_k?: number;
}

export interface Group {
  description?: string;
  method: string;
  top_k?: number;
  pipeline?: PipeStep[];
  models?: string[];
  filter_free?: boolean;
  min_gdpval_pct?: number;
  min_gdpval?: number;
}

export interface ProviderKey {
  key: string;
  label?: string;
}

export interface ProviderConfig {
  billing: string;
  monthly_cost_usd?: number;
  keys?: ProviderKey[];
}

export interface Config {
  providers?: Record<string, ProviderConfig>;
  model_groups: Record<string, Group>;
  model_metrics: Record<string, Partial<Metrics>>;
  gdpval_builtin?: Record<string, number>;
}

// ── Cache Types ───────────────────────────────────────────────────────────

export interface Cache {
  gdpval_scores?: Record<string, number>;
  gdpval_scraped?: boolean;
  models_cached?: string;
  available_models?: { id: string; provider: string; cost_per_m: number }[];
  benchmarks?: Record<string, number>;
  cost_mux?: Record<string, number>;
  cost_mux_last_bump?: Record<string, string>;
  exhausted_keys?: Record<string, number>; // "provider:keyIdx" → exhausted_until timestamp
  openrouter_pricing?: Record<string, { input: number; output: number }>; // provider/modelId ref → $/1M
  usage_log?: { ref: string; tokens: number; ts: number }[]; // token usage history
}

// ── Provider Discovery Types ────────────────────────────────────────────

export interface ProviderDef {
  envVar?: string; // e.g. "ANTHROPIC_API_KEY"
  authKey?: string; // key in ~/.pi/agent/auth.json
  passPatterns?: string[]; // glob-ish prefixes to match in `pass ls`
  cliAuthFiles?: { path: string; tokenField: string }[]; // CLI tool auth files
  local?: boolean; // ollama/lm-studio — no key needed
  billing?: string; // default billing type
  freeModels?: string[]; // list of free models for this provider
  modelsUrl?: string; // API endpoint for model discovery
  authHeader?: (key: string) => Record<string, string>; // how to authenticate
  baseUrl?: string; // API base URL for pi provider registration
  api?: string; // pi API type (e.g. "anthropic", "openai-responses", "qwen")
}

// ── Classification Types ───────────────────────────────────────────────

export type ClassificationCategory =
  | 'trivial'
  | 'simple'
  | 'standard'
  | 'code_simple'
  | 'code_complex'
  | 'design'
  | 'planning'
  | 'exploration'
  | 'fallback';

// ── Extension Types ──────────────────────────────────────────────────────

export interface RouterExtensionContext {
  pi: ExtensionAPI;
  extDir: string;
  cfg: Config;
  cache: Cache;
  metrics: Record<string, Metrics>;
  limits: Map<string, RateLimit>;
  rrCounters: Record<string, number>;
  gdpval: Record<string, number>;
  scanning: boolean;
  activeGroup: string | null;
  sessionStart: number;
  turnStart: number;
  curModel: string;
  lastDynamicModel: string;
  lastDynamicCategory: ClassificationCategory | undefined;
  sessionCtx: any;
}

// ── Utility Types ────────────────────────────────────────────────────────

export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface ModelWithLimits {
  ref: string;
  limited: boolean;
  rank: number;
}

export interface GroupResolution {
  selected: string;
  candidates: string[];
}

export interface PriceInfo {
  input: number;
  output: number;
}
