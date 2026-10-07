// src/types.ts
// TypeScript type definitions for the pi-model-router

import type { Model } from '@earendil-works/pi-ai';

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
  reasoning_empty_response_timeout_ms: number;
  stall_timeout_ms: number;
  rate_limit_wait_max_ms: number;
  ollama_max_concurrent_streams: number;
  strip_suffixes: string[];
}

export interface Metrics {
  gdpval: number;
  throughput_tps: number;
  avg_latency_ms: number;
  cost_per_m: number | 'unknown';
  last_updated: number;
}

export interface RateLimit {
  cooldown_until: number;
  backoff_ms: number;
  hits: number;
  /** Optional reset-at timestamp (Unix ms). When present, the cooldown_until
   * is at least this value — set from a parsed rate-limit reset time so the
   * router doesn't retry before the provider's window actually resets. */
  resetAtMs?: number;
}

interface PipeStep {
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

  /**
   * Maximum GDPval a group member may have — the hard upper tier boundary,
   * symmetric to `min_gdpval` (owner decision 2026-10-04, ADR-0023). Keeps
   * top-tier models out of a group they would otherwise dominate via the
   * `best` method's score convergence: e.g. `tactical` capped at 1700
   * admits glm-5-3 (1644) but excludes claude-opus-5-5 (1900) and
   * claude-sonnet-5-5 (1844), reserving those for `strategic`. Strict
   * null-fails semantics, matching `min_gdpval`: a model with a null
   * (unscored) GDPval fails a positive cap. Absent/0 = no upper bound.
   */
  max_gdpval?: number;

  /**
   * Which capability column ranks WITHIN this group (ADR-0023 round 2):
   * 'gdpval' (default) | 'briefcase' (AA-Briefcase Elo — agentic knowledge
   * work, the natural planning score) | 'coding' (SciCode/Terminal-Bench
   * blend). Floors and caps stay on the global GDPval — a column never
   * changes which models are ADMITTED, only their order within the pool.
   * Missing column for a model → gdpval fallback (pre-round behavior).
   */
  score_by?: 'gdpval' | 'briefcase' | 'coding';
  max_cost?: number;
  max_cost_per_m?: number;

  /**
   * Minimum model context window (in tokens) required for this group.
   * Models whose scanned `capabilities.contextWindow` is unknown or below
   * this value are dropped — matching the strict (null-fails) semantics of
   * `min_gdpval`. Use this for use-case groups that must hold large inputs
   * (e.g. `bulk_reader` reading several files at once). Absent/0 = no
   * context-length gate (default; preserves existing behaviour).
   */
  min_context_length?: number;
  exclude_providers?: string[];
  exclude_models?: string[];
  /**
   * Per-group cache-aware compaction settings (Phase 5b): each field wins
   * over the same field of the global `context_budget`; absent fields fall
   * back to the global values. Absent everywhere = feature off.
   * See src/context-compaction.ts.
   */
  context_budget?: ContextBudgetConfig;
  /**
   * Billing-tier ranking override, applied as a post-sort pass by
   * `resolveGroup()` (live selection) and `getTopModels()` (display) AFTER
   * the group's `method` has ordered the candidates. It re-ranks by billing
   * tier only; it does not change which models passed the filters.
   *
   * Orderings (see `Router.sortByBillingPreference`):
   * - 'default':      free → subscription → local → payg
   * - 'local_first':  free → local → subscription → payg
   * - 'strict_local': local → free → subscription → payg — for cheap groups
   *   (trivial/simple) where the local daemon should answer first: best
   *   latency and no quota burn, ahead of even the $0 remote models.
   *
   * Note that a subscription model's nominal $0 cost does NOT mean it is
   * free — those plans hide a hard time/token limit (the pi-claude
   * incident, 2026-09-26). Prefer the local daemon or a genuine `:free`
   * model over a subscription model for cheap work.
   */
  billing_preference?:
    | 'default'
    | 'local_first'
    | 'strict_local'
    | 'cloud_first'
    | 'local_before_payg';
  /**
   * Optional user PIN for the local classifier primary (dynamic group only),
   * an Ollama model ref such as "ollama/<model>:<tag>". No shipped value
   * (ADR-0025): unset, the primary is derived from the models Ollama reports
   * and verified by the scan-time probe (src/classifier-local-probe.ts).
   */
  classifier_model?: string;
  /** Optional user PIN for the local classifier fallback; unset = derived (see classifier_model). */
  classifier_fallback?: string;
  /**
   * Pinned cloud classifier model ref ("provider/id") for the dynamic
   * group's cloud fallback. When set, the classifier tries this model
   * FIRST — before the probe-verified cached list — so a specific (e.g.
   * subscription-covered) model classifies deterministically, regardless
   * of what the scan-time probe ranked first. If pi's model registry
   * cannot resolve the ref, the fallback chain continues unchanged.
   */
  classifier_cloud_model?: string;
  /**
   * Opt-in: if both classifier_model and classifier_fallback are unavailable,
   * send the (raw) prompt to a free cloud model (via a provider's configured
   * free_models) purely to classify it. Off by default (data minimization --
   * a provider configured for free_models as a general answering fallback
   * should not silently also receive prompt content for an unrelated,
   * internal classification purpose). Requires a provider with free_models
   * and a resolvable key configured in router-config.json.
   */
  classifier_cloud_fallback?: boolean;
  /** Groups to try (in order) when all candidates in this group fail. e.g. ["strategic", "operational"] */
  fallback_groups?: string[];
}

export interface ProviderKey {
  key: string;
  label?: string;
}

export interface ProviderConfig {
  billing: string;
  monthly_cost_usd?: number;
  /**
   * Budget pacing (task-type-balancing Phase 4): a spend allowance the
   * router compares its own usage_log counter against. A provider that runs
   * ahead of the LINEAR target for the current window is DEMOTED (ranked
   * behind on-pace candidates, never excluded). Works for capped
   * subscriptions and pay-per-token spend limits alike; absent = off (the
   * shipped default — user-layer key). See src/budget-pacing.ts.
   */
  budget?: ProviderBudget;
  /**
   * Legacy (ADR-0022): key entries are no longer read, resolved, or written
   * by the router — pi resolves credentials. The field stays so old
   * router-config files with leftover `keys` arrays still parse.
   */
  keys?: ProviderKey[];
  free_models?: string[];
  cost_per_m?: number;  // Cost per million tokens (for subscription providers)
}

/** User-tunable knobs of the provider circuit breaker (Config.provider_breaker, plan D8). */
export interface BreakerConfig {
  /** Kill switch for the CLOUD breaker; local (ADR-0016) always stays active. Default true. */
  enabled?: boolean;
  /** Distinct models with evidence needed to trip, per provider class. Defaults: cloud 3, local 2. */
  min_models?: { cloud?: number; local?: number };
  /** Evidence window in seconds. Default 600. */
  window_s?: number;
  /** Cooldown ladder per repeated trip, in seconds. Default [120, 300, 900]. */
  cooldown_s?: number[];
}

export interface Config {
  providers?: Record<string, ProviderConfig>;
  model_groups: Record<string, Group>;
  model_metrics: Record<string, Partial<Metrics>>;
  gdpval_builtin?: Record<string, number>;
  /** Router log level: error < warn < info < debug (ROUTER_LOG_LEVEL overrides
   * it). Release builds ship at "warn" or "error" (AGENTS.md §1). */
  log_level?: 'error' | 'warn' | 'info' | 'debug';
  /**
   * Milliseconds after start before a scan counts as "settled" (model registry
   * loaded). Only a settled scan may confirm a smaller result refused by the
   * scan-sanity regression check. Default 60000.
   */
  scan_settle_ms?: number;
  /** Override the default first-token empty-response timeout (ms). */
  empty_response_timeout_ms?: number;
  /** Override the first-token timeout for reasoning/thinking models (ms). */
  reasoning_empty_response_timeout_ms?: number;
  /** Override the mid-stream inactivity timeout (ms), after the first content token. */
  stall_timeout_ms?: number;
  /** Max ms to WAIT for a rate-limited model whose reset time is known and
   * near (instead of burning the whole candidate chain and recording
   * failures on every other model). 0 disables waiting. Default 120s. */
  rate_limit_wait_max_ms?: number;
  /** Rate-limit backoff schedule in MINUTES (escalating per hit). Default [1,2,4,8,16,32,64,90]. */
  backoff_minutes?: number[];
  /** Soft-failure (empty response/stall) backoff schedule in ms. Default [30000,60000,120000,300000]. */
  soft_backoff_ms?: number[];
  /** Max simultaneous streams to a LOCAL model server (ollama/lm-studio), to prevent OOM crashes. Default 1 (serial). */
  ollama_max_concurrent_streams?: number;
  /**
   * Global model exclusion rules — applied to EVERY group before per-group
   * filtering. Lets a user opt out of paid OpenRouter models, specific costly
   * models (e.g. claude-fable-5), or whole providers, regardless of group.
   */
  exclude?: ExcludeRules;
  /**
   * Agent-capability tier prefixes — curated model-id families that must
   * never serve main-agent work (see src/agent-capability.ts for the
   * 2026-09-27 incident evidence: GDPval floors cannot keep small-but-
   * benchmark-capable models out). Matched against ANY path segment of the
   * model id, so provider re-hosts (e.g. openrouter/mistral/mistral-small-3-2)
   * are covered. Nothing ships (ADR-0025 Phase D: the list is a quality
   * judgement, not a Pi/scan capability flag) — set it in
   * router-config.user.json; layers REPLACE arrays (set the full list you
   * want). Absent/empty (the shipped default) = tier explicitly OFF. Like `exclude`, this
   * is user intent and is ALWAYS taken from the static layered config — the
   * dynamic-config whitelist in load() resyncs it.
   */
  non_agent_model_prefixes?: string[];

  /**
   * Provider circuit breaker (docs/plans/2026-10-06-provider-circuit-breaker.md,
   * D8/ADR-0026). Defaults live in code (provider-breaker.ts); the shipped
   * config carries NO entry — set overrides in router-config.user.json.
   * `enabled: false` is the kill switch for CLOUD providers (restores the
   * pre-1.7.0 behaviour exactly); the local watchdog of ADR-0016 always
   * stays active. No provider names appear here — per-provider overrides
   * live in the user layer only, and the mechanism itself is provider-agnostic
   * (ADR-0025 class A).
   */
  provider_breaker?: BreakerConfig;

  /**
   * Quality-equivalence window (fraction of the best candidate's score,
   * e.g. 0.05 = 5%) applied by the `best` group method: candidates within
   * the window of the group's best score are treated as EQUALLY GOOD, and
   * the cheapest of them is picked first (cost ties broken by the LOWER
   * score — least overkill — since within the window quality is deemed
   * equivalent). Models outside the window keep pure score order behind
   * the pool (ADR-0023, owner decision 2026-10-04: score compression at the
   * top — opus-5-5 1900 vs sonnet-5-5 1844 vs glm-5-3 1644 — made `best`
   * converge on the single most expensive model). Absent/0 = off (pure
   * score ordering, previous behaviour).
   */
  best_quality_window?: number;
  /**
   * Enforced delegation (ADR-0007, revised 2026-09-20): shrink oversized
   * file-inspection tool results (`read`, `bash`) with a cheap summarizer
   * model (via a router group) BEFORE the main model sees them. Strictly
   * fail-open. Like `exclude`, this is user intent and is ALWAYS taken from
   * the static layered config — a dynamic config can never silently change it.
   */
  delegation?: DelegationConfig;
  /**
   * User override of the category→group mapping (task-type-balancing
   * Phase 3): `{ <category>: <group> }`, merged OVER the built-in
   * CATEGORY_TO_GROUP in src/content-classifier.ts. Only the nine known
   * categories are valid keys and only groups present in `model_groups`
   * are valid values — anything else is rejected with a warning at load
   * time and ignored. Absent = the built-in mapping applies unchanged.
   * Like `exclude`, this is user intent and is ALWAYS taken from the
   * static layered config — a dynamic config can never silently change it.
   */
  category_groups?: Record<string, string>;
  /**
   * Global cache-aware compaction settings (task-type-balancing Phase 5b):
   * `{ enabled, soft_tokens, hard_tokens, cache_ttl_s }`, OPT-IN — absent =
   * off (measurement only, which Phase 5a ships always-on). Setting
   * thresholds opts into the "compacting now would pay off" hints at cold
   * turn boundaries; `enabled: true` additionally compacts automatically
   * (only between turns, never mid-turn). Per-group overrides live on
   * `model_groups.<g>.context_budget` and win per field. Compaction runs on
   * a COLD cache only (over soft) or above `hard_tokens` regardless — a
   * warm paid cache is never thrown away. See src/context-compaction.ts.
   */
  context_budget?: ContextBudgetConfig;
}

/**
 * Cache-aware compaction settings (Phase 5b of
 * docs/plans/2026-10-05-task-type-balancing.md), globally and per group.
 */
export interface ContextBudgetConfig {
  /** Master switch: compact automatically at turn boundaries. Default false. */
  enabled?: boolean;
  /** Context size (tokens) that pays off to compact below WHEN THE CACHE IS COLD. 0/absent = off. */
  soft_tokens?: number;
  /** Context size (tokens) that compacts regardless of cache state. 0/absent = off. */
  hard_tokens?: number;
  /** Provider-cache TTL in seconds: an idle gap longer than this counts as a cold cache. */
  cache_ttl_s?: number;
}

/**
 * Settings for the enforced-delegation result shrinker (src/delegation.ts).
 * All fields optional; omitted → disabled with defaults.
 */
export interface DelegationConfig {
  /** Master switch. Default false (fork's router-config.json opts in). */
  enabled?: boolean;
  /** Minimum joined text length of a tool result to be delegated.
   * Default 3500 (Portal/shunt-aligned: ~350 lines at ~10 chars/line —
   * below this the 10-30s delegation latency exceeds the savings). */
  min_chars?: number;
  /** Router group whose models summarize. Default 'bulk_reader'. */
  group?: string;
  /** Cap of raw text passed to the summarizer. Default 60000. */
  max_raw_chars?: number;
  /** Tool names whose oversized results get delegated.
   * Default ['read', 'bash'] — log evidence (2026-09-20): agent sessions
   * inspect files predominantly via bash (sed/grep/cat), so a read-only
   * default never fires. Set ['read'] to restore the original behavior. */
  tools?: string[];
  /** Pre-call block threshold for full-file reads, in lines (shunt's
   * SHUNT_MIN_LINES). Default 350; 0 disables pre-call blocking. */
  block_lines?: number;
  /** Router groups whose members never do full-file reads regardless of
   *  size (ADR-0007 escalation): expensive models orchestrate and reason;
   *  file inspection belongs to the cheap delegation group. Matched against
   *  the ACTIVE config's materialized model lists (scan output). Defaults
   *  to ['strategic', 'tactical']; an empty array disables the group check. */
  expensive_groups?: string[];
  /** Provider prefixes (e.g. 'pi-claude') whose models count as expensive
   *  regardless of group membership — for fixed (non-routed) sessions whose
   *  model never appears in any group list. Defaults to none. */
  expensive_providers?: string[];
}

/**
 * Personalized support/exclude rules.
 *
 * All fields are optional; omitted fields exclude nothing.
 * Patterns are glob-style ("openrouter/*", "*fable*"); "*" matches any.
 */
export interface ExcludeRules {
  /** Provider prefixes to exclude entirely (e.g. "openrouter" drops all OR/* refs). */
  providers?: string[];
  /** Model-ref patterns to exclude (e.g. "openrouter/*" drops all OR models,
   *  "claude-bridge/claude-fable-5" drops one specific model). */
  models?: string[];
  /**
   * Exclude all PAY-AS-YOU-GO (non-free) models from the given providers.
   * "openrouter" → keep only openrouter/*:free models, drop the rest.
   * Unlike excluding the provider outright, this preserves free tier models.
   */
  paid_models_from?: string[];
}

// ── Cache Types ───────────────────────────────────────────────────────────

/**
 * One failed main-session stream attempt, recorded by recordStreamFailure
 * (index.ts) into the cache.session_errors ring buffer. Single source of
 * truth for the status-line counter and /router errors (2026-09-27).
 */
export interface SessionError {
  ts: number;
  ref: string;
  reason: string;
  detail?: string;
  consequence: string;
  /** Recording process (per-project split 2026-10-03); absent in pre-split history. */
  pid?: number;
}

export interface Cache {
  gdpval_scores?: Record<string, number>;
  gdpval_scraped?: boolean;

  /**
   * Per-slug capability profile from the Artificial Analysis scrape
   * (ADR-0023 round 2, docs/plans/2026-10-04-aa-multi-benchmark-sourcing.md).
   * Same additive-merge lifecycle as gdpval_scores: setCache merges,
   * absent column = null (gdpval fallback), never 0.
   */
  capability_profiles?: Record<string, { gdpval?: number; briefcase?: number; coding?: number }>;
  models_cached?: string;
  available_models?: AvailableModel[];
  benchmarks?: Record<string, number>;
  cost_mux?: Record<string, number>;
  cost_mux_last_bump?: Record<string, string>;
  lastScanTimestamp?: number;
  exhausted_keys?: Record<string, number>; // "provider:keyIdx" → exhausted_until timestamp
  openrouter_pricing?: Record<string, { input: number; output: number }>; // provider/modelId ref → $/1M
  usage_log?: UsageLogEntry[]; // token usage history
  /** Ring buffer of main-session stream failures (single source of truth for
   * the status-line error counter and /router errors — src/session-errors.ts). */
  session_errors?: SessionError[];
  // Budget tracking for subscription providers. Nothing currently writes to
  // this — there is no live API to query remaining subscription quota (see
  // docs/adr/0003-reject-live-subscription-usage-api.md). The field and the
  // hasBudget()/filterByBudget() logic that reads it stay in place as a hook
  // a future local-usage-log-based tracker could populate.
  budget_cache?: Record<string, { // provider → budget info
    remaining_tokens?: number;
    window_type?: 'hourly' | 'daily' | 'monthly';
    window_reset?: number; // timestamp when window resets
    last_checked?: number; // timestamp of last check
  }>;
  /** LLM-assisted model→gdpval-slug matches (3rd-tier fallback in lookupGdp). */
  model_score_cache?: Record<string, string>;
  /**
   * Per-model consecutive-failure tracking. Keyed by "provider/id" ref.
   * See src/model-health.ts. Failures decay after HEALTH_DECAY_MS (15 min).
   */
  model_health?: Record<string, { fails: number; last_fail: number }>;
  /**
   * Local models that answered a classifier call with HTTP 501
   * "structured output is unavailable" (e.g. Ollama's MLX backend rejects
   * JSON-schema calls). Keyed by local model name, value = observation
   * timestamp. The classifier skips these as primary; entries expire after
   * CLASSIFIER_NO_SCHEMA_TTL_MS (24h) so a backend upgrade that adds
   * schema support self-heals.
   */
  classifier_no_schema?: Record<string, number>;
  /**
   * false marks a scan cache that never had a router-config.dynamic.json
   * (test fixtures). Absent means a valid cache implies the file should exist
   * and is regenerated when missing.
   */
  dynamic_config_expected?: boolean;
  /**
   * Last scan refused by the scan-sanity regression check (survivor count,
   * previous snapshot count, time). A second scan with the same result is
   * accepted as a real shrink.
   */
  scan_sanity_refusal?: { survivors: number; previous: number; at: number };
  /**
   * Learned blocklist (ADR-0008): models whose failures matched a
   * known-permanent signature, keyed by "provider/id" ref. Entries expire
   * after BLOCKLIST_TTL_MS (7 days) from last_seen; see src/model-blocklist.ts.
   */
  model_blocklist?: Record<string, {
    reason: string;
    code: number;
    signature: string;
    first_seen: number;
    last_seen: number;
    occurrences: number;
  }>;
  /**
   * Tier-2 failure streaks (ADR-0008): consecutive failures per ref with the
   * same unknown signature, reset by a success or a different signature.
   */
  model_failure_streaks?: Record<string, {
    signature: string;
    count: number;
    first_seen: number;
    last_seen: number;
  }>;
  /**
   * Provider circuit breaker (provider-breaker.ts), keyed by provider id:
   * counting evidence per distinct model ref (timestamp + D1 evidence kind),
   * the open expiry, and how many times the breaker has tripped since the
   * last success (ladder position). Replaces the local-only watchdog state
   * of ADR-0016; a stale `local_provider_health` left in an old cache file
   * is ignored. VOLATILE (plan D7): stripped on save and ignored on load —
   * a restart is the standard remedy for a wedged provider and must never
   * re-open a breaker the restart just fixed.
   */
  provider_breaker?: Record<string, {
    evidence: Record<string, { at: number; kind: string }>;
    open_until?: number;
    trip_count: number;
  }>;
  /**
   * Persisted breaker telemetry (plan D7): trips, last trip time and
   * avoided hops per provider — the tuning evidence that outlives the
   * volatile open state above. Survives restarts.
   */
  provider_breaker_stats?: Record<string, {
    trips: number;
    avoided_hops: number;
    last_trip_at?: number;
  }>;
  /**
   * Verified-working cloud models for the classifier's cloud fallback.
   * Populated by probeAndCache() at scan time (a quality probe with real
   * classification cases — incl. the HINT-narration trap — filters out
   * broken/unavailable and misclassifying candidates). Reused by the
   * classifier until the next /router
   * scan regenerates the cache. Empty array = probe ran but all failed;
   * absent = probe hasn't run yet this scan cycle.
   */
  classifier_fallback_models?: string[];
  /**
   * Probe-verified LOCAL classifier chain (ADR-0025 C): Ollama model names in
   * size order, written at scan time by probeLocalClassifierCandidates.
   * [0] is the primary, [1] the fallback; absent = not probed yet (the
   * classifier then uses the unprobed candidate order), empty = probed and
   * nothing qualified.
   */
  classifier_local_models?: string[];
  /**
   * When classifier_local_models was last probed and for which candidates
   * (size order) — lets a scan reuse a fresh result instead of spending GPU
   * time on every session start.
   */
  classifier_local_probe?: { at: number; candidates: string[] };
}

// ── Provider Discovery Types ────────────────────────────────────────────

export interface ProviderDef {
  // NOTE (ADR-0022): the credential fields (env-var names, auth-store keys,
  // pass-store patterns, CLI auth files, catalog endpoints, auth-header
  // builders, the scan model filter) were removed — pi owns credential
  // resolution and the router no longer scans provider catalogs.
  local?: boolean; // ollama/lm-studio — no key needed
  billing?: string; // default billing type
  baseUrl?: string; // API base URL for pi provider registration
  api?: string; // pi API type (e.g. "anthropic", "openai-responses", "qwen")
  /**
   * Another provider key whose Pi-registry pricing applies to this one too —
   * for a provider that is the SAME upstream API/account under a different
   * router-internal key (e.g. mistral-zai is Mistral "Le Platform" with a
   * separate API key, not a separate service — see its PROVIDER_MAP entry).
   * Pi's own model catalog only ever registers the primary key (mistral),
   * never the router-internal alias, so registryCost() retries under this
   * provider when the direct lookup finds nothing — otherwise every model
   * from an aliased provider is permanently priced as the scan's
   * cost_per_m:0 placeholder (ADR-0006 "F3"), never the real price.
   */
  pricingAlias?: string;
  /**
   * Prefix this provider puts in front of the model ids it hosts for another
   * vendor (e.g. a re-host that namespaces its upstream's models as
   * "<vendor>-<model>"). Slug normalisation strips it so the upstream's
   * GDPval slug matches. Protocol knowledge about HOW the provider names
   * models (ADR-0025 class A) — it never admits or ranks a model.
   */
  modelIdVendorPrefix?: string;
}

// ── Utility Types ────────────────────────────────────────────────────────

/**
 * Declared spend allowance for one provider (budget pacing, Phase 4 of
 * docs/plans/2026-10-05-task-type-balancing.md). Structural twin of
 * src/budget-pacing.ts's runtime-validated ProviderBudget — the config type
 * lives here so `providers.<p>.budget` type-checks in Config.
 */
export interface ProviderBudget {
  /** Allowance per window; must be > 0. */
  amount: number;
  /** 'tokens' counts usage_log tokens (incl. cacheRead, Phase 5a); 'usd' estimates spend via the blended effCost. */
  unit: 'usd' | 'tokens';
  /** Only 'month' is supported today. */
  period: 'month';
  /** Day of month (1-31) the window starts; clamped to shorter months. */
  reset_day: number;
}

export interface ModelRef {
  provider: string;
  modelId: string;
}

/**
 * Real capabilities of a discovered model, as reported by the provider's
 * /v1/models (or Ollama /api/tags) endpoint. Normalized from the various
 * provider-specific shapes (Mistral capabilities.vision, OpenRouter
 * architecture.input_modalities, etc.) into one common form.
 *
 * All fields optional — providers don't all report every capability.
 * Consumers (registerGroupModels) fall back to conservative defaults when
 * a field is absent, so a partially-populated record is always usable.
 */
export interface ModelCapabilities {
  /** Supports image input. False is authoritative (provider says no); undefined = unknown. */
  vision?: boolean;
  /** Supports reasoning/thinking output. */
  reasoning?: boolean;
  /** Max context window in tokens, if the provider reports one. */
  contextWindow?: number;
  /** Max output tokens per request, if reported. */
  maxTokens?: number;
  /**
   * Local runtimes only (Ollama /api/show `capabilities`): true when the model
   * generates text. Undefined = the runtime reported no capability list
   * (unknown, NOT false) — the local classifier derivation (ADR-0025 C1)
   * keeps unknown models and lets the probe decide.
   */
  completion?: boolean;
  /** Local runtimes only: true for embedding-only models (never a classifier). */
  embedding?: boolean;
  /** Local runtimes only: parameter count in billions (Ollama `details.parameter_size`). */
  parameterSizeB?: number;
}

/**
 * One discovered model. `cost_per_m` is always present (0 for local/free);
 * `capabilities` is optional and populated only when the scan could extract
 * real values from the provider's models endpoint.
 */
export interface AvailableModel {
  id: string;
  provider: string;
  cost_per_m: number;
  capabilities?: ModelCapabilities;
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

// ── Cost Tracking Types ────────────────────────────────────────────────

/**
 * One completed assistant step in the persistent usage_log. `tokens` is the
 * TOTAL the model processed (input + output + cacheRead + cacheWrite — Phase
 * 5a: input+output alone undercounted long agentic contexts ~40x);
 * cacheRead/cacheWrite are recorded separately (omitted when the provider
 * reports none) so cache hit rates are derivable per window.
 */
export interface UsageLogEntry {
  ref: string;
  tokens: number;
  ts: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface CostMetrics {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Provider-reported cache reads/writes this session (Phase 5a). */
  totalCacheReadTokens?: number;
  totalCacheWriteTokens?: number;
  requestsByModel: Record<string, number>;
  costByModel: Record<string, number>;
  /** Per-model token split for the /router cost report (audit depth, 2026-09-27). */
  tokensByModel?: Record<string, { in: number; out: number; cacheRead?: number; cacheWrite?: number }>;
}
