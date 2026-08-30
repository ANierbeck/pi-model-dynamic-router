/**
 * pi-model-router — Passive model group routing for pi
 *
 * Routes group names (strategic/tactical/operational/scout) to concrete models.
 * Balances intelligence, cost, and availability via:
 *   - GDPval-ranked selection pipelines
 *   - Subscription cost discount (sunk cost preference)
 *   - Exponential backoff on 429 + permanent costMux per provider
 *   - Passive throughput/latency tracking from observed turns
 */
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  Context,
  SimpleStreamOptions,
  AssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';
import { Type } from '@sinclair/typebox';
import { truncateToWidth } from '@earendil-works/pi-tui';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import type { Config, Cache, Metrics, Defaults, ModelCapabilities } from './src/types.ts';
import { PROVIDER_MAP, SKIP_REGISTRATION } from './src/providers.ts';
import { splitRef, stripDateSuffix, resolveShortModelName } from './src/utils.ts';
import { isRefUsable, rankHintCandidates } from './src/hint-resolution.ts';
import { RateLimitManager } from './src/rate-limit.ts';
import { DiscoveryManager } from './src/discovery.ts';
import * as metricsModule from './src/metrics.ts';
import { lookupGdp } from './src/metrics.ts';
import { estimateOllamaModelsGdpvalAsSlugs } from './src/ollama-gdpval.ts';
import { buildOllamaProviderModels } from './src/ollama-context.ts';
import { checkScanSanity } from './src/scan-sanity.ts';
import { extractCapabilities } from './src/capabilities.ts';
import { CacheManager } from './src/cache.ts';
import { matchModelsWithLLMBatched, isPlausibleMatch, type GdpvalEntry } from './src/model-matcher.ts';
import { callLocalLlm, type LocalLlmDeps } from './src/local-llm.ts';
import { isExcluded, type ExcludeContext } from './src/exclude.ts';
import { recordModelFailure, recordModelSuccess, failureStreak } from './src/model-health.ts';
import { detectDegenerateRepetition } from './src/repetition-guard.ts';
import {
  buildStaticFreeModelsLookup,
  buildModelsWithMetadata,
  filterModelsForGroup,
  sortModelsForGroup,
  collectGroupModels,
  computeFallbackGroups,
} from './src/dynamic-config.ts';
import { pushStreamError, pushRouterInfo, isExpectedTransientError } from './src/stream-driver.ts';
import {
  isRateLimitText,
  isOverflowErrorText,
  isOverflowDeltaText,
  parseResetAtMs,
} from './src/detection.ts';
import { hasBudget } from './src/budget.ts';
import { loadLayeredConfig } from './src/config-loader.ts';
import { Router, getFallbackGroup } from './src/routing.ts';
import { classifyPrompt, detectHintDirectly, getGroupForCategory, ClassificationResult } from './src/content-classifier.ts';
import { SessionEscalation } from './src/escalation.ts';
import { costTracker } from './src/cost-tracker.ts';

function loadDefaults(extDir: string): Defaults {
  const yamlPath = path.join(extDir, 'router-defaults.yaml');
  return YAML.parse(fs.readFileSync(yamlPath, 'utf-8')) as Defaults;
}

const _defaults = loadDefaults(path.dirname(fileURLToPath(import.meta.url)));
const BACKOFF = _defaults.backoff_minutes.map((m) => m * 60_000);
const SOFT_BACKOFF = _defaults.soft_backoff_ms;
const COST_MUX_AT_HIT = _defaults.cost_mux_at_hit;
const MODELS_TTL = _defaults.models_ttl_ms;
const EMPTY_RESPONSE_TIMEOUT_MS = _defaults.empty_response_timeout_ms;
const REASONING_EMPTY_RESPONSE_TIMEOUT_MS = _defaults.reasoning_empty_response_timeout_ms;
const STALL_TIMEOUT_MS = _defaults.stall_timeout_ms;
const OLLAMA_MAX_CONCURRENT_STREAMS = _defaults.ollama_max_concurrent_streams;
const GDPVAL_URL = _defaults.gdpval_url;

// Local-stream concurrency limiter (process-wide semaphore for ollama/lm-studio).
// Each local stream loads a full model into RAM; unbounded parallel streams
// (e.g. from subagent fan-out) can exhaust system memory and crash the host.
// tryStream() acquires before opening a local stream; the caller (driveStream)
// releases after consumeWithDetection() settles, in a finally block.
// localStreamLimit() and isLocalProvider() are defined inside the default
// export scope (where `cfg` is in scope) below; only the counter is here.
let localStreamsInFlight = 0;

// ── Extension ──────────────────────────────────────────────────────────────

// Shared router logger (D2): writeLogLine / routerLog / appendRawLog /
// setProjectLogDir live in src/logger.ts so every src/ module can log without
// reaching for console.* (which bypasses Pi's TUI and can land in the user's
// input field). Re-imported here for index.ts's own use.
import { routerLog, writeLogLine, appendRawLog, setProjectLogDir } from './src/logger.ts';

const defaultExport = function (pi: ExtensionAPI) {
  const extDir = path.dirname(fileURLToPath(import.meta.url));
  const cfgPath = path.join(extDir, 'router-config.json');

  const STRIP_SUFFIXES = _defaults.strip_suffixes;
  let cfg: Config;
  let staticCfg: Config; // Statische Konfiguration (immer router-config.json)
  let cache: Cache = {};
  let rateLimitManager: RateLimitManager;
  let discoveryManager: DiscoveryManager;
  let cacheManager: CacheManager;
  let router: Router;
  // gdpval/modelMap/lookupGdp state lives in metrics.ts (single source of truth).
  let scanning = false;
  let sessionStart = Date.now();
  let turnStart = 0;
  let curModel = '';
  let activeGroup: string | null = null;
  let lastDynamicModel = '';
  // Category the dynamic classifier picked on the previous turn — feeds
  // short-prompt momentum ('yes', 'do it', 'mach das') in classifyPrompt so a
  // terse follow-up inherits the prior task's complexity instead of
  // re-classifying from near-zero signal.
  let lastClassifiedCategory: ClassificationResult['category'] | undefined;
  let sessionCtx: any = null;

// Compaction detection state
let previousMessageCount = 0;
let previousTokenCount = 0;

  // ── Session Escalation ─────────────────────────────────────────────────
  const escalation = new SessionEscalation();

  // ── Helpers ────────────────────────────────────────────────────────────

  async function populateLlmMatches(allModelRefs: string[]): Promise<void> {
    metricsModule.setLlmMatches({});
    const gdpval = metricsModule.getGdpval();
    if (!allModelRefs.length || Object.keys(gdpval).length === 0) return;

    // Only ask the LLM about models the first two tiers can't resolve.
    const unscored = allModelRefs.filter((ref) => metricsModule.lookupGdp(ref) === null);
    if (!unscored.length) return;

    // Serve from cache first (avoid repeat LLM calls for the same models).
    // BUT validate cached matches with isPlausibleMatch — old cached entries
    // from a weaker model (e.g. gemma2:2b) may contain cross-family
    // hallucinations that must not be trusted.
    const cachedMatches = cache.model_score_cache ?? {};
    const cachedHits: Record<string, string> = {};
    const stillUnscored: string[] = [];
    for (const ref of unscored) {
      const cached = cachedMatches[ref];
      if (cached && typeof cached === 'string' && isPlausibleMatch(ref, cached)) {
        cachedHits[ref] = cached;
      } else {
        // Cached match is implausible (or missing) → re-match.
        stillUnscored.push(ref);
      }
    }
    if (cachedHits) metricsModule.setLlmMatches(cachedHits);
    if (!stillUnscored.length) return;

    // Build the gdpval candidate list (slug + label + score) for the prompt.
    const gdpvalEntries: GdpvalEntry[] = Object.entries(gdpval).map(([slug, score]) => ({
      slug,
      label: slugToLabel(slug),
      score,
    }));

    // LLM caller: provider-agnostic local, else free OpenRouter cloud.
    const deps: LocalLlmDeps = {
      providers: PROVIDER_MAP,
      cache,
      cfg,
      timeoutMs: 90_000, // large models need time; if the local model is too
      // slow it fails and the cloud fallback (free OpenRouter) fires.
    };
    const callLlm = (prompt: string) => callLocalLlm(prompt, deps);

    try {
      const result = await matchModelsWithLLMBatched({
        modelIds: stillUnscored,
        gdpvalEntries,
        callLlm,
        batchSize: 40,
      });

      // Merge cached plausible hits + fresh matches, persist.
      // (cachedMatches may contain implausible entries from a weaker model —
      // only persist the plausible cachedHits + fresh result.matches.)
      const merged = { ...cachedHits, ...result.matches };
      cache.model_score_cache = merged;
      cacheManager.saveCache();
      metricsModule.setLlmMatches(merged);

      // Distinguish "LLM call failed" (error) from "LLM answered but no matches".
      if (result.error) {
        routerLog(
          `[router] LLM matcher call failed (${result.error}); ${stillUnscored.length} model(s) remain unscored. Check that a local model (Ollama gemma2:2b) or a free OpenRouter model is available.`
        );
      } else if (result.matches && Object.keys(result.matches).length) {
        routerLog(
          `[router] LLM matcher resolved ${Object.keys(result.matches).length} model(s) to gdpval slugs`
        );
        if (result.unmatched.length) {
          routerLog(
            `[router] LLM matcher could not match ${result.unmatched.length} model(s): ${result.unmatched.slice(0, 20).join(', ')}${result.unmatched.length > 20 ? ' ...' : ''}`
          );
        }
      } else if (result.unmatched.length) {
        routerLog(
          `[router] LLM matcher returned no matches; ${result.unmatched.length} model(s) remain unscored`
        );
      }
    } catch (err) {
      // Fail-open: keep whatever cached hits we had; log the gap.
      routerLog(
        `[router] LLM matcher unavailable (${err instanceof Error ? err.message : String(err)}); ${stillUnscored.length} model(s) remain unscored`
      );
    }
  }

  /** Best-effort human-readable label for a gdpval slug (slug → Title Case). */
  function slugToLabel(slug: string): string {
    return slug
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function fmt(n: number) {
    return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
  }

  function fmtTime(ms: number) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60),
      rs = s % 60;
    if (m < 60) return `${m}m${rs ? rs + 's' : ''}`;
    return `${Math.floor(m / 60)}h${m % 60 ? (m % 60) + 'm' : ''}`;
  }

  // ── Config + Cache ─────────────────────────────────────────────────────

  function load() {
    // Layered config: embedded defaults → global user override → project override.
    // Deep-merge so users only specify the keys they want to change.
    const { config: layeredCfg, sources } = loadLayeredConfig(extDir, process.cwd(), routerLog);
    staticCfg = layeredCfg;
    if (sources.length > 1) {
      routerLog(`[router] Config loaded from ${sources.length} layer(s): ${sources.join(' → ')}`);
    }

    // Versuche die dynamische Konfiguration zu laden
    const dynamicConfigPath = path.join(extDir, 'router-config.dynamic.json');
    let loadedFromDynamic = false;
    
    try {
      if (fs.existsSync(dynamicConfigPath)) {
        const dynamicCfg = JSON.parse(fs.readFileSync(dynamicConfigPath, 'utf-8'));
        // Check whether the dynamic configuration is valid (has _dynamic metadata)
        if (dynamicCfg._dynamic && dynamicCfg.model_groups) {
          // IMPORTANT: Exclude rules AND the timeout overrides from staticCfg
          // (layered config) must be enforced. The dynamic config can contain
          // stale values if the user changed router-config.json or
          // router-config.user.json in the meantime. These fields ALWAYS
          // come from staticCfg (the single source of truth for user
          // overrides) — otherwise changing e.g.
          // reasoning_empty_response_timeout_ms has no effect as long as a
          // router-config.dynamic.json exists on disk.
          dynamicCfg.exclude = staticCfg.exclude;
          dynamicCfg.empty_response_timeout_ms = staticCfg.empty_response_timeout_ms;
          dynamicCfg.reasoning_empty_response_timeout_ms = staticCfg.reasoning_empty_response_timeout_ms;
          cfg = dynamicCfg;
          loadedFromDynamic = true;
        }
      }
    } catch (error) {
      routerLog('[router] Error loading dynamic configuration, falling back to static config:', error);
    }
    
    // Falls keine dynamische Konfiguration, verwende die statische
    if (!loadedFromDynamic) {
      cfg = staticCfg;
    }
    
    // gdpval state lives in metrics.ts (single source of truth).
    // setConfig + setCache below populate it correctly, including self-healing
    // from cache.gdpval_scores when needed.
    
    // Initialize managers
    rateLimitManager = new RateLimitManager(BACKOFF, SOFT_BACKOFF, COST_MUX_AT_HIT, cache);
    discoveryManager = new DiscoveryManager(cfg, cache);
    // Always use staticCfg for metrics to ensure provider costs are available
    metricsModule.setConfig(staticCfg);
    // CRITICAL: load the model-map into the metrics module too. Without this,
    // metrics.ts's mapLookup() has an EMPTY modelMap, so the live /router
    // table (which uses metrics.lookupGdp via routing.ts) cannot resolve
    // vendor-prefixed models like zai-glm-5-2 → glm-5-2, and GLM-5-2
    // vanishes from the TUI even though generateDynamicConfig found it.
    metricsModule.loadModelMap(extDir);
    metricsModule.setCache(cache);
    // If a dynamic configuration was loaded and has its own gdpval_builtin,
    // add it (AFTER setConfig/setCache so it isn't overwritten)
    if (loadedFromDynamic && cfg.gdpval_builtin) {
      const currentScores = metricsModule.getGdpval();
      metricsModule.setGdpval({ ...currentScores, ...cfg.gdpval_builtin });
    }
    cacheManager = new CacheManager(extDir);
    router = new Router(cfg, cache, rateLimitManager.getLimits());
    // load() runs on every session_start (and other reload paths) and replaces
    // the Router instance wholesale, which drops its private sessionCtx field.
    // Without this, group resolution silently falls back to the stale on-disk
    // cache for the rest of the session instead of Pi's live model registry —
    // dynamic discovery would never actually engage. sessionCtx (the module-level
    // variable, set in session_start/session_shutdown) is the source of truth to
    // re-apply here; callers must never need to remember to redo this themselves.
    if (sessionCtx) router.setSessionCtx(sessionCtx);
    metricsModule.setCache(cache);
    // Keep escalation's loop-detection model in sync with the configured dynamic
    // group's classifier_fallback — don't hardcode a specific local model.
    const dynGroup = cfg.model_groups?.['dynamic'];
    if (dynGroup?.classifier_fallback) {
      escalation.setClassifierModel(dynGroup.classifier_fallback);
    }
  }

  function loadCache() {
    cache = cacheManager.loadCache();
    metricsModule.setCache(cache);
    rateLimitManager.updateCache(cache);
    router?.updateCache(cache);
  }

  function saveCache() {
    cacheManager.saveCache(cache);
  }

  // ── Key Discovery ───────────────────────────────────────────────────────

  async function discoverKeys() {
    await discoveryManager.discoverKeys();
    cache = discoveryManager.getCache();
    metricsModule.setCache(cache);
    rateLimitManager.updateCache(cache);
    router?.updateCache(cache);
  }

  // ── Budget Tracking ─────────────────────────────────────────────────────
  //
  // There is no live-refresh path here: no subscription provider (Claude Pro/
  // Max via claude-bridge, or any other) exposes a documented API to query
  // remaining quota. See docs/adr/0003-reject-live-subscription-usage-api.md
  // for why this was investigated and rejected rather than built. hasBudget()
  // reads whatever is in cache.budget_cache (currently always empty, so
  // subscription providers are treated as available — the same as
  // pay-per-token providers) and relies on RateLimitManager's reactive
  // cooldowns to react once a provider actually reports a rate limit.

  /**
   * Check if a model has available budget (synchronous, uses cache)
   */
  function hasModelBudget(ref: string): boolean {
    // Delegate to the single source of truth in budget.ts.
    // Previously this duplicated filterByBudget (routing.ts) with identical logic;
    // both now go through hasBudget() so the rule lives in one place.
    return hasBudget(ref, cfg.providers, cache.budget_cache);
  }

  // ── Scan (GDPval forever, models 24hr) ─────────────────────────────────

  /**
   * Extract GDPval scores from Artificial Analysis HTML
   * Tries JSON data first (modern), falls back to HTML table parsing
   */
  function extractGdpvalScores(html: string): Record<string, number> {
    const scores: Record<string, number> = {};

    // Current AA format (2025+): RSC payload embeds structured data as
    // {"label":"Model Name","gdpvalAaElo":[{"@type":"PropertyValue","name":"mid","value":1769.15},...],"detailsUrl":"/models/slug"}
    const entryRe = /\{"label":"([^"]+)","gdpvalAaElo":\[[^\]]*"name":"mid","value":([\d.]+)[^\]]*\],"detailsUrl":"\/models\/([^"]+)"/g;
    let em;
    let count = 0;
    while ((em = entryRe.exec(html))) {
      const label = em[1];
      const score = parseFloat(em[2]);
      const slug = em[3];
      scores[slug] = score;
      const labelKey = label.toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      if (labelKey && labelKey !== slug) scores[labelKey] = score;
      count++;
    }
    if (count > 0) return scores;

    // Legacy: window.__MODELS_DATA__ = {...} (pre-2025 AA structure)
    const scriptJsonMatch = html.match(/window\.__MODELS_DATA__\s*=\s*({[\s\S]*?});/);
    if (scriptJsonMatch) {
      try {
        const modelsData = JSON.parse(scriptJsonMatch[1]);
        for (const [slug, model] of Object.entries(modelsData)) {
          const m = model as { gdpval?: number; shortName?: string; name?: string };
          if (m.gdpval !== undefined) {
            scores[slug] = m.gdpval;
            if (m.shortName) scores[m.shortName] = m.gdpval;
            if (m.name) {
              const nameKey = m.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
              scores[nameKey] = m.gdpval;
            }
          }
        }
        if (Object.keys(scores).length > 0) return scores;
      } catch {}
    }

    return scores;
  }

  async function fetchJson(
    url: string,
    opts?: { headers?: Record<string, string>; timeoutMs?: number; method?: string; body?: string }
  ): Promise<any> {
    const init: RequestInit = {
      method: opts?.method ?? 'GET',
      headers: { 'User-Agent': 'pi-model-dynamic-router/1.0', ...opts?.headers },
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 20_000),
    };
    if (opts?.body !== undefined) init.body = opts.body;
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  /**
   * Discovers all available models across providers and scrapes GDPval scores.
   *
   * RESPONSIBILITY: populate `cache.available_models` (the router's own
   * model discovery, separate from Pi's ~/.pi/agent/models.json) and
   * `cache.gdpval_scores` (scraped from Artificial Analysis + builtin
   * overrides + Ollama GDPval heuristics). Runs on session_start and on
   * `/router scan`. Result feeds generateDynamicConfig (which writes the
   * dynamic group config) and registerGroupModels (which registers models
   * with Pi).
   *
   * PER-MODEL CAPABILITIES (resolved architecture problem B1): each provider's
   *   /v1/models response is parsed for real capabilities via
   *   src/capabilities.ts (Mistral `capabilities.vision/reasoning`/
   *   `max_context_length`, OpenRouter `architecture.input_modalities`/
   *   `context_length`). For Ollama, /api/show is fetched per model (parallel,
   *   bounded) to get `model_info.*.context_length` + the capabilities array —
   *   setup-independent (no hardcoded table, no dependency on any specific
   *   Ollama extension). Results land in cache.available_models[].capabilities
   *   (see AvailableModel/ModelCapabilities types) and flow through to
   *   registerGroupModels, which registers with the real values (conservative
   *   defaults for unreported fields) instead of the old hardcoded blanket.
   *
   * PER-PROVIDER MODEL FILTER (resolved architecture problem B2): PROVIDER_MAP
   *   entries may set `modelFilter: "<regex>"` to constrain which scanned model
   *   ids are kept. Generic and user-configurable (not a hardcoded special
   *   case, per Leitplanke 1). Applied here in the scan; absent = keep all
   *   non-embed/tts/etc. models (legacy behaviour).
   *
   * INPUT CONTRACT: `force` bypasses the GDPval-scrape and model-TTL gates.
   * Without force, GDPval is scraped once (cache.gdpval_scraped flag) and
   * models are re-scanned only if older than MODELS_TTL or a configured
   * provider has keys but zero cached models.
   *
   * OUTPUT CONTRACT: side-effect only — mutates cache (gdpval_scores,
   * available_models, openrouter_pricing, models_cached timestamp). Returns
   * nothing. Then calls generateDynamicConfig(force) to regenerate the
   * dynamic group config from the fresh scan.
   *
   * SIDE EFFECTS: network I/O (fetches GDPval page + each provider's
   * /v1/models + Ollama /api/tags AND /api/show per model). Mutates cache.
   * Triggers generateDynamicConfig (which writes router-config.dynamic.json).
   *
   * INVARIANTS:
   *   - Re-entrant guard: if `scanning` is already true, returns immediately
   *     (prevents overlapping scans from a rapid `/router scan` +
   *     session_start race).
   *   - Per-provider failures are swallowed (the `catch {}` blocks) — a
   *     provider whose /v1/models is down doesn't block the others.
   *   - OpenRouter free models (pricing.prompt === '0') are included; paid
   *     OpenRouter models are NOT pushed to available_models (only their
   *     pricing is recorded) — the router only uses OpenRouter's free tier.
   */
  async function scan(force = false) {
    if (scanning) return;
    scanning = true;
    try {
      if (!cache.gdpval_scraped || force) {
        try {
          const res = await fetch(GDPVAL_URL, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(30_000),
          });
          const html = await res.text().then((h) => h.replace(/\\"/g, '"'));
          const scores = extractGdpvalScores(html);

          if (Object.keys(scores).length) {
            metricsModule.setGdpval(scores);
            cache.gdpval_scores = metricsModule.getGdpval();
            cache.gdpval_scraped = true;
          } else {
            routerLog('[scan] No GDPval scores extracted - table regex may be outdated');
          }
        } catch (err) {
          /* scrape failed, use builtins */
          routerLog(`[scan] GDPval scrape failed (${err instanceof Error ? err.message : String(err)}); using builtins only`);
        }
      }
      const age = cache.models_cached
        ? Date.now() - new Date(cache.models_cached).getTime()
        : Infinity;
      // Also rescan if any configured provider has keys but zero models cached
      const missingProviders = Object.entries(cfg.providers ?? {}).some(
        ([p, pc]) =>
          pc.keys?.length && !(cache.available_models ?? []).some((m) => m.provider === p)
      );
      if (force || age > MODELS_TTL || missingProviders) {
        const models: Cache['available_models'] = [];
        if (cfg.providers?.chutes?.keys?.length) {
          try {
            const d = await fetchJson('https://llm.chutes.ai/v1/models');
            const pricing = cache.openrouter_pricing ?? {};
            for (const m of d.data ?? []) {
              models.push({ id: m.id, provider: 'chutes', cost_per_m: m.pricing?.prompt ?? 0 });
              const inp = m.pricing?.prompt ?? 0;
              const out = m.pricing?.completion ?? 0;
              if (inp >= 0 && out >= 0) {
                const ref = `chutes/${m.id}`;
                if (!pricing[ref] || inp < pricing[ref].input)
                  pricing[ref] = { input: inp, output: out };
              }
            }
            cache.openrouter_pricing = pricing;
          } catch {}
        }
        if (cfg.providers?.openrouter?.keys?.length) {
          try {
            const d = await fetchJson('https://openrouter.ai/api/v1/models', { timeoutMs: 25_000 });
            const pricing: Record<string, { input: number; output: number }> =
              cache.openrouter_pricing ?? {};
            for (const m of d.data ?? []) {
              if (String(m.pricing?.prompt ?? '1') === '0')
                models.push({ id: m.id, provider: 'openrouter', cost_per_m: 0 });
              const inp = parseFloat(m.pricing?.prompt ?? '0') * 1_000_000;
              const out = parseFloat(m.pricing?.completion ?? '0') * 1_000_000;
              if (inp >= 0 && out >= 0) {
                const ref = `openrouter/${m.id}`;
                pricing[ref] = { input: inp, output: out };
                if (m.id.includes('/') && inp > 0) {
                  if (!pricing[m.id] || inp < pricing[m.id].input)
                    pricing[m.id] = { input: inp, output: out };
                }
              }
            }
            cache.openrouter_pricing = pricing;
          } catch {}
        }
        try {
          const d = await fetchJson('http://localhost:11434/api/tags', { timeoutMs: 5_000 });
          const ollamaModelNames = (d.models ?? []).map((m: any) => m.name).filter((id: string) => id);
          // Estimate GDPval for Ollama models as SLUG → score (compatible with
          // cache.gdpval_scores, which the lookup pipeline consumes as slug
          // keys — NOT raw "ollama/<id>" refs). These are FALLBACK scores only;
          // explicit model-map.yaml + gdpval_builtin entries take precedence
          // (setCache merges builtins on top of scraped/estimated scores).
          const ollamaGdpvalEstimates = estimateOllamaModelsGdpvalAsSlugs(ollamaModelNames);

          // B1 (setup-independent Ollama capabilities): for each Ollama model,
          // fetch /api/show to get the REAL context length (model_info.*.context_length)
          // and capabilities array (vision/thinking/tools). /api/tags alone doesn't
          // carry context length; /api/show does. Parallel + bounded so 11 models
          // don't stall the scan. Failures per-model are swallowed (conservative:
          // the model just gets no capabilities and the caller falls back to
          // defaults). This replaces the previous hardcoded num_ctx table
          // (ollama-context.ts) which was setup-specific (mirrored gsd-pi).
          const ollamaShowResults = await Promise.all(
            ollamaModelNames.map(async (name: string) => {
              try {
                const show = await fetchJson('http://localhost:11434/api/show', {
                  method: 'POST',
                  body: JSON.stringify({ name }),
                  headers: { 'Content-Type': 'application/json' },
                  timeoutMs: 8_000,
                });
                return { name, show };
              } catch {
                return { name, show: null };
              }
            })
          );
          for (const m of d.models ?? []) {
            const id = m.name;
            if (!id) continue;
            const showData = ollamaShowResults.find((r) => r.name === id)?.show;
            const caps = extractCapabilities('ollama', showData ?? m);
            const existing = models.find((x) => x.provider === 'ollama' && x.id === id);
            if (existing) {
              if (!existing.capabilities && caps) existing.capabilities = caps;
            } else {
              const entry: { id: string; provider: string; cost_per_m: number; capabilities?: ModelCapabilities } =
                { id, provider: 'ollama', cost_per_m: 0 };
              if (caps) entry.capabilities = caps;
              models.push(entry);
            }
          }
          // Store estimated GDPval scores under their SLUG keys (not raw refs)
          if (Object.keys(ollamaGdpvalEstimates).length > 0) {
            cache.gdpval_scores = cache.gdpval_scores ?? {};
            for (const [slug, score] of Object.entries(ollamaGdpvalEstimates)) {
              // Don't overwrite an existing authoritative score
              if (cache.gdpval_scores[slug] === undefined) {
                cache.gdpval_scores[slug] = score;
              }
            }
            // A2: this only mutated cache.gdpval_scores, NOT metrics.ts's
            // in-memory `gdpval` map that lookupGdp()/resolveSlug() actually
            // read from. Without re-syncing, generateDynamicConfig() (called
            // at the end of this same scan()) would score newly-discovered
            // Ollama models as unscored (gdpval=0) and drop them — they'd
            // only pick up their estimate on the NEXT session's setCache()
            // call. setCache() is additive (Object.assign), so re-calling it
            // here is safe and makes the estimates visible immediately.
            metricsModule.setCache(cache);
          }
        } catch {}
        // Scan direct API providers with modelsUrl (anthropic, openai, etc.)
        // Generic (Ü1-consistent): skip providers Pi already knows.
        // If Pi knows a provider from models.json, an extension, or natively,
        // the router doesn't need to scan it — that would only create
        // duplicates in cache.available_models (e.g. mistral-zai with 46
        // identical models like mistral). The router wouldn't register it
        // anyway (Ü1 in registerGroupModels). So: don't scan.
        const piKnownProviders = new Set<string>();
        if (sessionCtx?.modelRegistry) {
          try {
            for (const model of sessionCtx.modelRegistry.getAvailable()) {
              piKnownProviders.add(model.provider);
            }
          } catch {}
        }
        const providerScans = Object.entries(PROVIDER_MAP)
          .filter(([, def]) => def.modelsUrl && def.authHeader)
          .filter(([provId]) => !piKnownProviders.has(provId))
          .map(async ([provId, def]) => {
            const keys = cfg.providers?.[provId]?.keys;
            if (!keys?.length) return;
            // Optional per-provider model filter (B2): a provider whose key sees
            // a broad catalog can be constrained to a subset via a regex in
            // PROVIDER_MAP. Generic, user-configurable — not a hardcoded
            // special case (per Leitplanke 1). Empty/absent = keep all.
            const filterRe = def.modelFilter ? new RegExp(def.modelFilter, 'i') : null;
            // Try each key until one succeeds (first may be stale)
            for (let ki = 0; ki < keys.length; ki++) {
              try {
                const key = resolveKeyValue(keys[ki].key);
                const headers = def.authHeader!(key);
                const d = await fetchJson(def.modelsUrl!, { headers, timeoutMs: 15_000 });
                const list = d.data ?? d.models ?? [];
                if (!list.length) continue;
                for (const m of list) {
                  const id = m.id ?? m.name?.replace(/^models\//, '');
                  if (!id) continue;
                  if (
                    /embed|tts|whisper|dall|moderation|babbage|davinci|search|audio|realtime|image|transcri/i.test(
                      id
                    )
                  )
                    continue;
                  if (filterRe && !filterRe.test(id)) continue;
                  const existing = models.find((x) => x.provider === provId && x.id === id);
                  if (existing) {
                    // Backfill capabilities if the earlier entry lacked them.
                    const c = extractCapabilities(provId, m);
                    if (!existing.capabilities && c) existing.capabilities = c;
                    continue;
                  }
                  const entry: { id: string; provider: string; cost_per_m: number; capabilities?: ModelCapabilities } =
                    { id, provider: provId, cost_per_m: 0 };
                  const c = extractCapabilities(provId, m);
                  if (c) entry.capabilities = c;
                  models.push(entry);
                }
                break; // success, stop trying keys
              } catch {
                /* try next key */
              }
            }
          });
        await Promise.allSettled(providerScans);
        if (models.length) {
          // Merge: keep existing entries for providers not scanned (or whose scan failed)
          const scannedProviders = new Set(models.map((m) => m.provider));
          const kept = (cache.available_models ?? []).filter(
            (m) => !scannedProviders.has(m.provider)
          );
          cache.available_models = [...kept, ...models];
          cache.models_cached = new Date().toISOString();
        }
      }
      saveCache();
      
      // Generiere dynamische Konfiguration nach dem Scan
      await generateDynamicConfig(force);
    } finally {
      scanning = false;
    }
  }

  /**
   * Generates and persists the dynamic router config (router-config.dynamic.json)
   * from the scanned model set + the static config.
   *
   * RESPONSIBILITY: the SNAPSHOT writer — the third of the three group-
   * candidate paths (A1) and the only one that PERSISTS a result. Builds, per
   * group, a `models` array baked into a JSON file on disk; the live resolver
   * ({@link resolveGroup}) later treats that
   * array as an allow-list when it exists. This is structurally different
   * from the live paths: they decide in the moment, this one freezes a
   * decision for up to 30 days (see CacheManager.isScanCacheValid). That
   * asymmetry is why a bad generation (scoring collapse, missing models)
   * can silently distort routing for weeks — guarded by {@link checkScanSanity}
   * which refuses to persist a broken snapshot.
   *
   * INPUT CONTRACT: reads `cache.available_models` (the scan result), the
   * static config (layered: embedded defaults → user override → project), and
   * the model-map. `force` bypasses the cache-freshness check; otherwise the
   * scan cache must be invalid (older than 30 days / never run) to regenerate.
   *
   * OUTPUT CONTRACT: writes `router-config.dynamic.json` next to the static
   * config and reassigns the in-memory `cfg` to it. Returns early WITHOUT
   * writing if no models scored (sanity check: total collapse) — in that case
   * the on-disk file (if any) is left untouched and lastScanTimestamp is NOT
   * bumped, so the next session retries instead of freezing the bad snapshot.
   *
   * SIDE EFFECTS (significant — the live paths have none of these):
   *   - WRITES `dist/router-config.dynamic.json` (the only path that writes a
   *     config file).
   *   - Updates in-memory `cfg`, `router`, `discoveryManager` to the new config.
   *   - Bumps `lastScanTimestamp` on success (NOT on sanity-check failure).
   *   - Calls {@link populateLlmMatches} which may call an LLM (Ollama/free
   *     OpenRouter) — network I/O, can be slow.
   *
   * INPUT CONTRACT — `g.models` semantics (the orthogonal bit): unlike the live
   * paths where `g.models` is an allow-list, here `groupConfig.models` (the
   * EXISTING models array from the static config) is MERGED IN FIRST, as a
   * priority list — static models are always preserved, then dynamic additions
   * are appended after dedup by token signature. This is why this path cannot
   * simply call the live resolvers: it has a different job (build a durable
   * pinned list including explicit user choices) not a live query.
   *
   * INVARIANTS:
   *   - Static (router-config.json-pinned) models are ALWAYS included, even if
   *     their GDPval is below the group floor (the floor only filters dynamic
   *     additions). This is a deliberate override so user-pinned models survive.
   *   - Dedup uses TOKEN SIGNATURES ({@link baseTokens}), NOT model-identity
   *     slugs — a different dedup method from the live paths. This is because
   *     the snapshot must reconcile static-pinned refs with discovered refs
   *     that may share a base model, and slug resolution isn't available at
   *     snapshot-write time the same way it is at live-resolve time.
   *   - A `model-map.yaml` entry mapping to `null` (explicit exclusion) is
   *     honoured: the model is dropped even if statically pinned.
   */
  async function generateDynamicConfig(force = false): Promise<void> {
    try {
      // Models Pi has already registered (e.g. via providers without PROVIDER_MAP entry
      // like claude-bridge) — so they still qualify as routing candidates.
      const registryRefs: string[] = [];
      if (sessionCtx?.modelRegistry) {
        for (const m of sessionCtx.modelRegistry.getAvailable()) {
          registryRefs.push(`${m.provider}/${m.id}`);
        }
      }

      // With dynamic model discovery, we always consider all registry models as valid.
      // No need to check against static group model lists anymore.
      // Always regenerate if cache is invalid or force is true.
      const hasNewRegistryRefs = false;

      if (!force && !hasNewRegistryRefs && cacheManager.isScanCacheValid()) {
        routerLog('[router] Scan cache is still valid (max 30 days old), skipping regeneration');
        return;
      }
      
      // 1. Get all available models (from cache)
      const scannedModels = cache.available_models ?? [];
      
      // 2. Load STATIC free_models from config (important for free models!)
      // These models are NOT scanned but taken directly from router-config.json
      const { staticFreeModels, staticFreeModelsLookup } = buildStaticFreeModelsLookup(staticCfg);
      
      // 2b. Alle Modelle kombinieren: statische free_models + gescannte Modelle + registry-Refs
      // (Gruppen-Modelle werden dynamisch aus allDiscoveredRefs() geholt, nicht mehr statisch)
      const allModelRefs = [...new Set([
        ...staticFreeModels,
        ...scannedModels.map(m => `${m.provider}/${m.id}`),
        ...registryRefs,
      ])];
      
      if (!allModelRefs.length) {
        routerLog('[router] No models available, skipping dynamic config generation');
        return;
      }

      // 2c. Apply global exclusion rules (personalized support list).
      // Excludes providers, model patterns, and paid models from certain
      // providers — applying to ALL groups, before scoring.
      let effectiveModelRefs = allModelRefs;
      if (staticCfg.exclude) {
        const exCtx: ExcludeContext = { rules: staticCfg.exclude, cfg, cache };
        const excluded: string[] = [];
        effectiveModelRefs = allModelRefs.filter((ref) => {
          if (isExcluded(ref, exCtx)) { excluded.push(ref); return false; }
          return true;
        });
        if (excluded.length) {
          routerLog(`[router] Exclude rules removed ${excluded.length} model(s): ${excluded.slice(0, 15).join(', ')}${excluded.length > 15 ? ' ...' : ''}`);
        }
      }

      // Register a lightweight provider stub for each registry-discovered
      // provider the router doesn't know yet (e.g. claude-bridge). Without this entry
      // stripProvider() won't recognize the prefix and GDPval/price inference via
      // the base model name (e.g. "claude-sonnet-5") would fail.
      for (const ref of registryRefs) {
        const slash = ref.indexOf('/');
        if (slash === -1) continue;
        const prov = ref.slice(0, slash);
        if (!PROVIDER_MAP[prov] && !cfg.providers?.[prov]) {
          (cfg.providers ??= {})[prov] = { billing: 'subscription' };
        }
      }
      
      // 4. Modelle mit GDPval und Kosten anreichern
      // All models are now dynamic, no separate static models
      const staticModelRefs = new Set([...staticFreeModels]);

      // 4a. LLM-assisted matching for models the model-map + token-fallback can't
      // resolve (e.g. vendor-prefixed ids like "mistral-zai/zai-glm-5-2" whose
      // token set {zai,glm,5,2} doesn't equal the gdpval slug's {glm,5,2}).
      // Runs ONCE per scan (not per prompt) and results are cached. Fail-open:
      // if no local/cloud LLM is available, matching silently degrades to the
      // existing two-tier fallback and unscored models are logged + dropped.
      await populateLlmMatches(effectiveModelRefs);

      const modelsWithMetadata = buildModelsWithMetadata(effectiveModelRefs, cfg, staticFreeModelsLookup, staticModelRefs);
      
      if (!modelsWithMetadata.length) {
        routerLog('[router] No models with GDPval scores, skipping dynamic config generation');
        return;
      }

      // Sanity check BEFORE persisting: a bad scan (e.g. gdpval/model-map state
      // not fully loaded at the moment of scoring) must never get frozen into
      // router-config.dynamic.json, since resolveGroup() treats a non-empty
      // `models` array as a hard allow-list that persists for up to 30 days
      // (isScanCacheValid). Observed 2026-08-22: a scan scored only 13/125
      // models instead of the normal ~60+, silently dropping mistral-medium
      // (933 GDPval) from "tactical" for hours across many session restarts.
      const explicitlyMappedRefs = effectiveModelRefs.filter((ref) => typeof metricsModule.mapLookup(ref) === 'string');
      const explicitlyMappedScoredRefs = explicitlyMappedRefs.filter((ref) => (lookupGdp(ref) ?? 0) > 0);
      const sanity = checkScanSanity({
        scannedRefs: effectiveModelRefs,
        survivorRefs: modelsWithMetadata.map((m) => m.ref),
        explicitlyMappedRefs,
        explicitlyMappedScoredRefs,
      });
      if (!sanity.ok) {
        routerLog(
          `[router] Scan sanity check FAILED, refusing to persist dynamic config: ${sanity.reason}`
        );
        // Deliberately do NOT call cacheManager.setLastScanTimestamp() here —
        // leaving it unset (or stale) means the next session/scan retries
        // instead of freezing this broken snapshot for up to 30 days. Any
        // existing router-config.dynamic.json on disk is left untouched
        // (better a previous good snapshot than a freshly broken one); if
        // none exists, load() falls back to staticCfg, which resolves groups
        // via live discovery (verified safe).
        return;
      }

      routerLog(`[router] Generating dynamic config with ${modelsWithMetadata.length} models (${staticFreeModels.length} free models)`);
      
      // 5. Dynamische Gruppen-Konfiguration generieren
      const dynamicGroups: Record<string, any> = {};
      
      for (const [groupName, groupConfig] of Object.entries(staticCfg.model_groups)) {
        // Skip dynamic group (handled separately)
        if (groupConfig.method === 'dynamic') {
          dynamicGroups[groupName] = groupConfig;
          continue;
        }
        
        // 6. Filter Modelle basierend auf Gruppen-Kriterien
        //
        // NOTE (A1): The live path (Router.resolveGroup) and the display path
        // (Router.getTopModels) share the method-independent filters via
        // applyGroupFilters() in routing.ts. This persist path does NOT use
        // that helper, DELIBERATELY: its max_cost/max_cost_per_m semantics
        // diverge (max_cost=0 groups admit ONLY genuine $0 token-based free
        // models, excluding subscription models that cost real money; the
        // live path instead treats max_cost=0 like max_cost=N and keeps
        // unknown-cost subscription/local). Consolidating would break the
        // trivial/simple groups' free-only guarantee. Only min_gdpval and
        // the group-level exclude_providers/exclude_models (applied earlier
        // via the global staticCfg.exclude) are shared in spirit.
        let filteredModels = filterModelsForGroup(modelsWithMetadata, groupConfig, cfg);
        
        // 7. Sortierung basierend auf Gruppen-Methode
        let sortedGroupModels = sortModelsForGroup(filteredModels, groupConfig, groupName, cfg, metricsModule.calculateScore);
        
        // 8. Collect models: static first (highest priority), then dynamic additions
        const finalModels = collectGroupModels(groupConfig, filteredModels, sortedGroupModels, cfg, staticFreeModelsLookup);
        const originalModels = groupConfig.models ?? [];
        
        // Debug-Logging
        if (groupName === 'trivial' || groupName === 'simple') {
          routerLog(`[router] Group ${groupName}: ${finalModels.length} models (${originalModels.length} static, ${filteredModels.length} dynamic)`);
          routerLog(`[router]   Models: ${finalModels.slice(0, 5).join(', ')}...`);
        }
        
        // Erstelle die dynamische Gruppen-Konfiguration
        dynamicGroups[groupName] = {
          ...groupConfig,
          models: finalModels
        };
      }
      
      // 9. Auto-generate fallback_groups for each group based on quality ordering.
      // Quality level: max_cost=0 → 0, min_gdpval=N → N, no constraint → 750 (highest).
      // Fallback order: nearest higher quality first, then lower — so a failing group
      // escalates before it degrades. Groups with no models are skipped.
      computeFallbackGroups(dynamicGroups);

      // 10. Dynamische Konfiguration speichern
      // WICHTIG: Der Objekt-Literal spreadet weiterhin von `cfg` (der
      // potenziell veralteten dynamischen Config), NICHT von staticCfg — nur
      // die einzelnen User-Override-Felder unten (exclude, die beiden Timeout-
      // Werte) werden explizit aus staticCfg erzwungen. staticCfg ist die
      // layered Config (defaults + user override) und damit die einzige Quelle
      // der Wahrheit fuer diese Felder; cfg kann sie verloren haben, wenn der
      // User zwischenzeitlich router-config.json/router-config.user.json
      // geaendert hat, seit die zuletzt persistierte dynamische Config
      // geschrieben wurde.
      const dynamicConfig = {
        ...cfg,
        // Preserve critical global config from staticCfg (layered config).
        // cfg may be a stale dynamic config missing user-overridden values.
        exclude: staticCfg.exclude,
        empty_response_timeout_ms: staticCfg.empty_response_timeout_ms,
        reasoning_empty_response_timeout_ms: staticCfg.reasoning_empty_response_timeout_ms,
        model_groups: dynamicGroups,
        _dynamic: {
          generated_at: new Date().toISOString(),
          source: 'router scan',
          model_count: modelsWithMetadata.length,
          base_config: 'router-config.json',
          free_models_count: staticFreeModels.length,
          scanned_models_count: scannedModels.length
        }
      };
      
      const dynamicConfigPath = path.join(extDir, 'router-config.dynamic.json');
      fs.writeFileSync(dynamicConfigPath, JSON.stringify(dynamicConfig, null, 2));

      // Update in-memory cfg immediately so the new fallback_groups and model lists
      // are available for the current session without requiring a restart.
      cfg = dynamicConfig as Config;
      router = new Router(cfg, cache, rateLimitManager.getLimits());
      if (sessionCtx) router.setSessionCtx(sessionCtx);
      metricsModule.setConfig(cfg);
      discoveryManager = new DiscoveryManager(cfg, cache);

      // Setze den Timestamp des letzten Scans
      cacheManager.setLastScanTimestamp();

      routerLog(`[router] Dynamic configuration generated: ${dynamicConfigPath}`);
      
    } catch (error) {
      routerLog('[router] Error generating dynamic configuration:', error);
    }
  }

  // ── Metrics ────────────────────────────────────────────────────────────

  function getM(ref: string): Metrics {
    return metricsModule.getM(ref);
  }

  function updateMetrics(ref: string, latMs: number, tokens: number, durMs: number) {
    metricsModule.updateMetrics(ref, latMs, tokens, durMs);
  }

  // ── Rate Limit + costMux ───────────────────────────────────────────────

  let activeKeyIdx: Record<string, number> = {}; // provider → current key index

  function resolveKeyValue(key: string): string {
    return discoveryManager.resolveKeyValue(key) ?? key;
  }

  /** Try rotating to next available key for provider. Returns true if switched. */

  function costMux(prov: string) {
    return rateLimitManager.costMux(prov);
  }

  function isLimited(ref: string) {
    return rateLimitManager.isLimited(ref);
  }

  function recordLimit(ref: string, resetAtMs?: number): { rotated: boolean; newKey?: string } {
    recordModelFailure(cache, ref);
    return rateLimitManager.recordLimit(ref, cfg.providers ?? {}, resetAtMs);
  }

  function recordOk(ref: string) {
    rateLimitManager.recordOk(ref);
    recordModelSuccess(cache, ref);
  }

  function clearLimit(ref: string): void {
    rateLimitManager.clearLimit(ref);
  }

  /** Record a soft failure (empty response, timeout) — lighter backoff than 429 */
  function recordSoftFailure(ref: string): void {
    rateLimitManager.recordSoftFailure(ref);
    recordModelFailure(cache, ref);
  }

  /**
   * Escalates a stream failure to the right backoff tier, exactly like the
   * main driveStream loop does: a real rate-limit, or an empty response from
   * a PAID cloud model (which is much more likely a masked 429/auth error
   * than a fluke), gets a hard cooldown + key rotation via recordLimit(). A
   * FREE-model or local-model empty response gets only the short soft-backoff
   * ladder, since those are commonly just transient overload.
   *
   * Used both by the main candidate loop and by the total-cooldown-collapse
   * force-retry, so a force-retried candidate that turns out to still be
   * rate-limited escalates the same way instead of getting a token-cheap
   * soft cooldown that lets it be force-retried again almost immediately.
   */
  function recordStreamFailure(
    ref: string,
    reason: string,
    resetAtMs?: number
  ): { hardLimited: boolean; rotated: boolean; newKey: string | undefined } {
    const isCloudProvider = !ref.startsWith('ollama/') && !ref.startsWith('lm-studio/');
    const isEmptyFailure = reason === 'empty_response'
      || reason === 'empty_timeout'
      || reason === 'stall_timeout';
    const isFreeModel = ref.includes(':free');
    if (reason === 'rate_limit_exceeded' || (isCloudProvider && isEmptyFailure && !isFreeModel)) {
      const rlResult = recordLimit(ref, resetAtMs);
      return { hardLimited: true, rotated: rlResult.rotated, newKey: rlResult.newKey };
    }
    recordSoftFailure(ref);
    return { hardLimited: false, rotated: false, newKey: undefined };
  }

  function limitSecs(ref: string) {
    return rateLimitManager.limitSecs(ref);
  }

  // ── Usage Stats ────────────────────────────────────────────────────────

  function getUsage(ref: string, days: number): number {
    return metricsModule.getUsage(ref, days);
  }

  // ── Price lookup (OpenRouter as oracle) ─────────────────────────────────

  function lookupPrice(ref: string): { input: number | 'unknown'; output: number | 'unknown' } | null {
    return metricsModule.lookupPrice(ref);
  }

  // ── Effective cost ─────────────────────────────────────────────────────

  function effCost(ref: string): number | 'unknown' {
    return metricsModule.effCost(ref);
  }

  // ── Resolution ─────────────────────────────────────────────────────────

  // ── Auto-discovery ────────────────────────────────────────────────────

  /** All known model refs: auto-discovered + any pinned models in group config */
  function allDiscoveredRefs(): string[] {
    return router.allDiscoveredRefs();
  }

  /** Get billing tier for a model ref: 0=free, 1=subscription, 2=local, 3=payg */

  /** Check provider key health: "valid" if key exists and not exhausted, "exhausted" if all keys spent, "unchecked" if no keys configured */
  function providerKeyHealth(prov: string): 'valid' | 'exhausted' | 'unchecked' {
    return discoveryManager.providerKeyHealth(prov, cache.exhausted_keys);
  }

  /** Filter to available models (not rate-limited, healthy provider keys) */
  /** Filter by minimum gdpval percentile (0-100). Keeps models at or above the percentile threshold. */
  /** Filter by absolute minimum gdpval score. Falls back to all refs if none qualify. */
  /**
   * Sort by billing preference: free → subscription (by rate-limit pressure & cost) → local → PAYG (by cost)
   * Within each tier, sort by effective cost. Subscription also considers rate-limit pressure.
   */

  function resolve(name: string): { selected: string; candidates: string[] } | null {
    return router.resolve(name);
  }



  // ── Format ─────────────────────────────────────────────────────────────

  function fmtModel(ref: string, i: number, sel: boolean) {
    const m = getM(ref),
      prov = ref.split('/')[0],
      mux = costMux(prov);
    // Billing label now derives from billingTier() (single source of truth).
    // Previously this inlined `cfg.providers?.[prov]?.billing === 'subscription'`,
    // which IGNORED PROVIDER_MAP built-in defaults — a built-in subscription
    // provider without a user config entry would display as 'ppt' instead of
    // 'sub'. Also, 'free' only checked cost_per_m===0, missing the :free tag
    // and the free_models config list. billingTier() unifies all three.
    const tier = metricsModule.billingTier(ref);
    const billing = tier === 1 ? 'sub' : tier === 0 ? 'free' : 'ppt';
    const muxS = mux > 1 ? ` ×${mux}` : '';
    const rl = isLimited(ref) ? ` ⛔${limitSecs(ref)}s` : '';
    const cost = effCost(ref);
    const costStr = cost === 'unknown' ? 'unknown' : cost.toFixed(3);
    
    // Add budget info for subscription providers
    const budgetInfo = cache.budget_cache?.[prov];
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
  ): { ref: string; limited: boolean; rank: number }[] {
    return router.getTopModels(groupName, n);
  }

  function detectGroup(ref: string): string | null {
    return router.detectGroup(ref);
  }

  /**
   * Register virtual providers for each model group (strategic, tactical, etc).
   * Called synchronously during extension load so groups are available for
   * --model resolution before session_start fires.
   */
  function registerGroupProviders() {
    for (const [groupName, groupCfg] of Object.entries(cfg.model_groups)) {
      // `method: 'dynamic'` groups never resolve here — resolve() always
      // returns null for them by design (see routing.ts Router.resolve):
      // the actual model is picked per-prompt by the classifier hook inside
      // groupStream, not statically at registration time. Calling resolve()
      // anyway would just display a misleading "→ none" in Pi's model
      // picker, so skip it and use a label that reflects what the group
      // actually does.
      const isDynamicGroup = groupCfg.method === 'dynamic';
      const res = isDynamicGroup ? null : resolve(groupName);
      const resolvedRef = res?.selected ?? 'none';
      const resolvedMetrics = res ? getM(resolvedRef) : null;
      const label = isDynamicGroup ? `${groupName} → auto-classify` : `${groupName} → ${resolvedRef}`;

      (pi as any).registerProvider(groupName, {
        baseUrl: 'https://router.local', // not used — streamSimple overrides
        apiKey: 'router-virtual', // not used — streamSimple overrides
        api: `router-group-${groupName}`, // unique per group to avoid overwriting global API providers
        streamSimple: groupStream,
        models: [
          {
            id: groupName,
            name: label,
            reasoning: true,
            input: ['text', 'image'] as any,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: resolvedMetrics ? 200_000 : 128_000,
            maxTokens: 64_000,
          },
          ...(isDynamicGroup ? [{
            id: `${groupName}:use-static`,
            name: `${groupName} → auto-classify (static fallback allowed)`,
            reasoning: true,
            input: ['text', 'image'] as any,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: resolvedMetrics ? 200_000 : 128_000,
            maxTokens: 64_000,
          }] : []),
        ],
      });
    }
  }

  // ── Events ─────────────────────────────────────────────────────────────

  load();
  metricsModule.loadModelMap(extDir);
  loadCache();
  registerGroupProviders();

  pi.on('session_start', async (_ev, ctx) => {
    sessionCtx = ctx;
    router.setSessionCtx(ctx);
    setProjectLogDir(ctx.cwd);
    try {
      const piAiPath = fileURLToPath(import.meta.resolve('@earendil-works/pi-ai'));
      const providerIds = (ctx.modelRegistry as any).getRegisteredProviderIds?.() ?? [];
      routerLog(`[diag] pi-ai resolved from: ${piAiPath}`);
      routerLog(`[diag] registered providers visible to router: ${[...providerIds].join(', ') || '(none)'}`);
    } catch (e) {
      routerLog('[diag] version diagnostics failed:', e);
    }
    load();
    metricsModule.loadModelMap(extDir);
    loadCache();
    sessionStart = Date.now();
    
    escalation.reset();
    
    await discoverKeys();

    await registerGroupModels(ctx);
    scan().catch(() => {});

    // Footer
    ctx.ui.setFooter((tui, theme, fd) => {
      const unsub = fd.onBranchChange(() => tui.requestRender());
      const timer = setInterval(() => tui.requestRender(), 30000);
      return {
        dispose() {
          unsub();
          clearInterval(timer);
        },
        invalidate() {},
        render(w: number): string[] {
          const ref = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : '';
          // The router never swaps the session's active model (see driveStream) —
          // ctx.model stays the virtual group model (e.g. "standard/standard") for
          // the whole session. Detect that here so the footer can show the actually
          // resolved model (lastDynamicModel, updated by driveStream on every
          // successful stream) instead of the static virtual model id.
          const groupBase = ctx.model?.id?.replace(/:use-static$/, '');
          const isGroupModel = groupBase ? Object.prototype.hasOwnProperty.call(cfg.model_groups, groupBase) : false;
          const grp = isGroupModel ? groupBase! : ref ? detectGroup(ref) : null;
          const m = ref ? getM(isGroupModel && lastDynamicModel ? lastDynamicModel : ref) : null;
          const modelDisplay =
            isGroupModel && lastDynamicModel
              ? lastDynamicModel
              : `${ctx.model?.provider ?? '?'}/${ctx.model?.id ?? '?'}`;
          const rStr = theme.fg('accent', `${grp ?? '—'}/${modelDisplay}`);
          const iStr = m ? theme.fg('warning', `int:${m.gdpval}`) : '';
          const tStr = m ? theme.fg('success', `tps:${Math.round(m.throughput_tps)}`) : '';

          let inp = 0,
            out = 0,
            cost = 0;
          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === 'message' && e.message.role === 'assistant') {
              const a = e.message as AssistantMessage;
              inp += a.usage.input;
              out += a.usage.output;
              cost += a.usage.cost.total;
            }
          }
          const u = ctx.getContextUsage(),
            pct = u?.percent ?? 0;
          const pCol = pct > 75 ? 'error' : pct > 50 ? 'warning' : 'success';
          const tok = [
            theme.fg('accent', `${fmt(inp)}/${fmt(out)}`),
            theme.fg('warning', `$${cost.toFixed(2)}`),
            theme.fg(pCol, `${pct.toFixed(0)}%`),
          ].join(' ');
          const el = theme.fg('dim', `⏱${fmtTime(Date.now() - sessionStart)}`);
          const pp = process.cwd().split('/');
          const cwd = theme.fg(
            'muted',
            `⌂ ${pp.length > 2 ? pp.slice(-2).join('/') : process.cwd()}`
          );
          const br = fd.getGitBranch();
          const brS = br ? theme.fg('accent', `⎇ ${br}`) : '';
          const rlN = [...rateLimitManager.getLimits().keys()].filter((r) => isLimited(r)).length;
          const rlS = rlN > 0 ? theme.fg('error', `⛔${rlN}`) : '';

          const sep = theme.fg('dim', ' | ');
          const parts = [rStr];
          if (iStr && tStr) parts.push(`${iStr} ${tStr}`);
          parts.push(tok, el, cwd);
          if (brS) parts.push(brS);
          if (rlS) parts.push(rlS);
          return [truncateToWidth(parts.join(sep), w)];
        },
      };
    });
  });


  pi.on('model_select', async (ev) => {
    if (ev.source !== 'restore') activeGroup = null;
    curModel = `${ev.model.provider}/${ev.model.id}`;
  });
  pi.on('turn_start', async (_ev, ctx) => {
    turnStart = Date.now();
    if (ctx.model) curModel = `${ctx.model.provider}/${ctx.model.id}`;
  });

  pi.on('turn_end', async (ev) => {
    if (!curModel || !turnStart) return;
    const ms = Date.now() - turnStart,
      msg = ev.message;
    
    // ── Session Escalation Logic ────────────────────────────────────────
    if (msg?.role === 'user' || msg?.role === 'assistant') {
      const content = typeof msg.content === 'string'
        ? msg.content
        : (msg.content ?? [])
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('');
      escalation.recordTurn(
        msg.role === 'user' ? content : '',
        msg.role === 'assistant' ? content : ''
      );
    }
    
    // ── Metrics & Usage Logging ─────────────────────────────────────────
    if (msg?.role === 'assistant') {
      const txt =
        typeof msg.content === 'string'
          ? msg.content
          : (msg.content ?? [])
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join('');
      const tok = Math.ceil(txt.length / 4);
      if (tok > 0) {
        updateMetrics(curModel, ms, tok, ms);
        recordOk(curModel);
        // Log usage
        if (!cache.usage_log) cache.usage_log = [];
        cache.usage_log.push({ ref: curModel, tokens: tok, ts: Date.now() });
        // Trim log to last 30 days
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        cache.usage_log = cache.usage_log.filter((e) => e.ts > cutoff);
      }
    }
  });

  pi.on('tool_result', async (ev, ctx) => {
    if (ev.isError && curModel) {
      const txt = ev.content?.map((c: any) => c.text ?? '').join('') ?? '';
      if (txt.includes('429') || txt.toLowerCase().includes('rate limit')) {
        const result = recordLimit(curModel);
        if (result.rotated) {
          ctx.ui.notify(
            `🔑 Rate limited — rotated ${splitRef(curModel).provider} to key "${result.newKey}"`,
            'warning'
          );
        }
      }
    }
  });

  let turns = 0;
  pi.on('turn_end', async () => {
    if (++turns % 10 === 0) saveCache();
  });
  pi.on('session_shutdown', async () => saveCache());

  // ── Tools ──────────────────────────────────────────────────────────────

  pi.registerTool({
    name: 'set_model_from_group',
    label: 'Set Model from Group',
    description:
      'Resolve a model group and immediately switch the current session to use the selected model. Combines resolve_model_group + model switch in one step.',
    parameters: Type.Object({ group: Type.String({ description: 'Model group name' }) }) as any,
    async execute(
      _id: string,
      params: { group: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext
    ) {
      load();
      const name = params.group.toLowerCase(),
        res = resolve(name);
      if (!res)
        throw new Error(
          `No models for group "${params.group}". Available: ${Object.keys(cfg.model_groups).join(', ')}`
        );
      for (const ref of res.candidates) {
        const { provider, modelId } = splitRef(ref);
        const model = ctx.modelRegistry.find(provider, modelId);
        if (model && (await pi.setModel(model))) {
          activeGroup = name;
          router.setActiveGroup(name);  // Set active group in router for display
          router.setCurModel(ref);      // Set current model in router for status line
          const m = getM(ref);
          return {
            content: [
              {
                type: 'text',
                text: `${ref} (${name}, gdp:${m.gdpval}, tps:${Math.round(m.throughput_tps)})`,
              },
            ],
            details: { group: name, selected: ref, provider, modelId },
          };
        }
      }
      throw new Error(`No available model in "${name}". Tried: ${res.candidates.join(', ')}`);
    },
  });

  pi.registerTool({
    name: 'resolve_model_group',
    label: 'Resolve Model Group',
    description:
      'Resolve a model group name (strategic, tactical, operational, scout, fallback) to a concrete provider/model. Use this when you need to select a model for a subagent or task and want the router to pick the best one.',
    parameters: Type.Object({
      group: Type.String({
        description:
          'Model group name: strategic, tactical, operational, scout, fallback, or any custom group',
      }),
    }) as any,
    async execute(_id: string, params: { group: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: ExtensionContext) {
      load();
      const name = params.group.toLowerCase(),
        res = resolve(name);
      if (!res)
        throw new Error(
          `Unknown or empty group "${params.group}". Available: ${Object.keys(cfg.model_groups).join(', ')}`
        );
      const { provider, modelId } = splitRef(res.selected);
      const table = res.candidates.map((r, i) => fmtModel(r, i, i === 0)).join('\n');
      return {
        content: [
          {
            type: 'text',
            text: `"${name}" (${cfg.model_groups[name].method}) → ${res.selected}\n\n${table}`,
          },
        ],
        details: {
          group: name,
          selected: res.selected,
          provider,
          modelId,
          candidates: res.candidates,
        },
      };
    },
  });

  pi.registerTool({
    name: 'update_model_metrics',
    label: 'Update Model Metrics',
    description:
      'Update runtime metrics (gdpval, throughput, latency) for a model in the router config.',
    parameters: Type.Object({
      model_ref: Type.String({ description: 'Model reference (provider/model-id)' }),
      gdpval: Type.Optional(Type.Number()),
      throughput_tps: Type.Optional(Type.Number()),
      avg_latency_ms: Type.Optional(Type.Number()),
    }) as any,
    async execute(_id: string, p: { model_ref: string; gdpval?: number; throughput_tps?: number; avg_latency_ms?: number }, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: ExtensionContext) {
      load();
      const e = cfg.model_metrics[p.model_ref] ?? {};
      if (p.gdpval !== undefined) e.gdpval = p.gdpval;
      if (p.throughput_tps !== undefined) e.throughput_tps = p.throughput_tps;
      if (p.avg_latency_ms !== undefined) e.avg_latency_ms = p.avg_latency_ms;
      cfg.model_metrics[p.model_ref] = e;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      // Update metrics cache with new values from config
      const existingMetrics = metricsModule.getM(p.model_ref);
      if (existingMetrics) {
        Object.assign(existingMetrics, e, { last_updated: Date.now() });
      }
      return {
        content: [{ type: 'text', text: `Updated ${p.model_ref}: ${JSON.stringify(e)}` }],
        details: { model_ref: p.model_ref, metrics: e },
      };
    },
  });

  // ── Virtual model groups: register as real pi models ──────────────────

  // ── Streaming helpers (hoisted for early group registration) ─────────

  /**
   * Resolve the host's own streamSimple for a model.
   *
   * pi-ai 0.82.1 removed the module-global API registry — streaming is now owned
   * by the host's ModelRuntime/Provider objects. This is also what makes
   * extension-registered providers (e.g. claude-bridge) visible to the router:
   * calling through the host avoids ever depending on the router's own pi-ai
   * module instance, which could diverge from the host's.
   *
   * Prefers the ModelRuntime (resolves auth, baseUrl and headers exactly like a
   * native pi turn), falls back to the public Provider object.
   */
  function hostStreamSimple(
    model: Model<any>,
    context: Context,
    options: SimpleStreamOptions | undefined
  ): AssistantMessageEventStream | null {
    const registry = sessionCtx?.modelRegistry as any;
    if (!registry) return null;

    const runtime = registry.runtime;
    if (typeof runtime?.streamSimple === 'function') {
      return runtime.streamSimple(model, context, options);
    }

    const provider = registry.getProvider?.(model.provider);
    if (typeof provider?.streamSimple === 'function') {
      return provider.streamSimple(model, context, options);
    }

    // Neither access path resolved — this is the exact interop mismatch this
    // function exists to guard against (host renamed/removed `.runtime` or
    // `.getProvider`). Log distinctly from tryStream's generic "not found"
    // error so it isn't mistaken for an ordinary missing-credentials case.
    routerLog(`[diag] hostStreamSimple: no runtime.streamSimple or getProvider(${model.provider}).streamSimple on modelRegistry — host interface may have changed`);
    return null;
  }

  /**
   * Try streaming from a specific model ref. Returns the stream and a
   * promise that resolves to { ok, hadContent, error? } when the stream
   * finishes or fails.
   */
  // Why a candidate was skipped by tryStream, keyed by ref. driveStream reads
  // this so a silently skipped candidate still shows up in the failure list —
  // otherwise "All 9 candidates failed" lists only 4 and the real reason (model
  // not in Pi's registry, no API key) stays invisible.
  const skipReasons = new Map<string, string>();

  // Local-stream concurrency limiter helpers (counter is module-global above;
  // limit + predicate need `cfg`, which is in scope here).
  function localStreamLimit(): number {
    return cfg.ollama_max_concurrent_streams ?? OLLAMA_MAX_CONCURRENT_STREAMS;
  }
  function isLocalProvider(ref: string): boolean {
    return ref.startsWith('ollama/') || ref.startsWith('lm-studio/');
  }

  /**
   * On-demand registration of a configured free model into Pi's model
   * registry. Statically-configured free models (cfg.providers[provider]
   * .free_models) never go through the scan/cache.available_models path,
   * so registerGroupModels never sees them and tryStream would skip every
   * free model forever. This registers the PROVIDER (if Pi doesn't know it)
   * with just the one model needed, then re-lookup. Returns true if the
   * model is now findable.
   *
   * Conservative: only fires for providers in PROVIDER_MAP with a baseUrl,
   * and only for model IDs explicitly listed in free_models. Never
   * overwrites an existing provider registration (Ü1 invariant).
   */
  function registerFreeModelOnDemand(provider: string, modelId: string): boolean {
    const def = (PROVIDER_MAP as any)[provider];
    if (!def?.baseUrl || !def?.api) return false;
    const freeModels = cfg.providers?.[provider]?.free_models;
    if (!freeModels?.length) return false;
    const ref = `${provider}/${modelId}`;
    if (!freeModels.includes(ref)) return false;
    // Ü1 invariant (HIGH finding, roborev job 302): pi.registerProvider
    // REPLACES the provider's `models` array wholesale (it does not merge),
    // so registering here with just the one on-demand model would silently
    // wipe every other model that provider was registered with (paid or
    // free) and make them unreachable via modelRegistry.find() for the rest
    // of the session. Only register when Pi does not know the provider AT
    // ALL — checking only free_models is not enough (MEDIUM finding, roborev
    // job 305): a provider registered by another path with a models list
    // that doesn't yet include a free model would pass a free-only guard and
    // still get wiped. Use getRegisteredProviderIds (already used at
    // index.ts:1247) for the authoritative 'is the provider known' check.
    const registeredProviderIds: string[] =
      (sessionCtx?.modelRegistry as any)?.getRegisteredProviderIds?.() ?? [];
    if (registeredProviderIds.includes(provider)) return false;
    // Resolve an API key (free models still need a key for the OpenRouter
    // endpoint, just at no cost). Without one we can't register.
    const keys = cfg.providers?.[provider]?.keys;
    let apiKey: string | undefined;
    if (keys?.length) {
      apiKey = resolveKeyValue(keys[activeKeyIdx[provider] ?? 0]?.key);
    } else if (def.authKey) {
      // auth.json key resolution is async in the real path, but we're in a
      // sync helper. If the provider needs auth.json and has no cfg key, we
      // can't resolve synchronously here — bail and let registerGroupModels
      // (which awaits the key) handle it at session start. This on-demand path
      // only fires for providers with a resolvable cfg key.
      return false;
    }
    if (!apiKey) return false;
    try {
      // Register the provider with ALL configured free models at once, not
      // just the one requested — a subsequent on-demand call for a different
      // free model would otherwise find the provider already known (the
      // providerAlreadyKnown guard above) and skip, but the new model wouldn't
      // be in the models list. Registering all free_models up front avoids
      // that and keeps the provider's registration coherent.
      const allFreeModelEntries = freeModels
        .filter((r: string) => r.startsWith(`${provider}/`))
        .map((r: string) => {
          const id = r.slice(provider.length + 1);
          return { id, name: id };
        });
      (pi as any).registerProvider(provider, {
        name: `${provider} (free, on-demand)`,
        baseUrl: def.baseUrl,
        apiKey,
        api: def.api,
        models: allFreeModelEntries,
      });
      routerLog(`[router] On-demand registered ${allFreeModelEntries.length} free model(s) for ${provider} (triggered by ${ref})`);
      return Boolean(sessionCtx?.modelRegistry.find(provider, modelId));
    } catch (e) {
      routerLog(`[router] On-demand registration failed for ${ref}:`, e);
      return false;
    }
  }

  async function tryStream(
    ref: string,
    context: Context,
    options: SimpleStreamOptions | undefined
  ): Promise<{ stream: AssistantMessageEventStream; ref: string } | null> {
    const skip = (reason: string): null => {
      skipReasons.set(ref, reason);
      routerLog(`[diag] tryStream skipped "${ref}": ${reason}`);
      return null;
    };
    skipReasons.delete(ref);
    if (!sessionCtx) return skip('no session context');
    const { provider, modelId } = splitRef(ref);
    // Skip group virtual models to prevent recursion
    if (cfg.model_groups[provider]) return skip(`"${provider}" is a group, not a provider`);
    let realModel = sessionCtx.modelRegistry.find(provider, modelId);
    if (!realModel) {
      // The ref isn't in Pi's model registry. If it's a configured free
      // model (cfg.providers[provider].free_models), register it on demand —
      // statically-configured free models never go through the scan/
      // cache.available_models path, so registerGroupModels never sees them,
      // and without this on-demand registration tryStream would skip every
      // free model forever (the observed 'claude-sonnet-5 dominates, GLM
      // unused' symptom: free models silently dropped from the cascade).
      if (registerFreeModelOnDemand(provider, modelId)) {
        realModel = sessionCtx.modelRegistry.find(provider, modelId);
      }
      if (!realModel)
        return skip(`not registered in Pi's model registry (provider=${provider}, id=${modelId})`);
    }
    if (cfg.model_groups[realModel.provider])
      return skip(`resolved provider "${realModel.provider}" is a group`);
    // Concurrency guard for LOCAL providers (ollama/lm-studio): each local
    // stream loads a full model into RAM; parallel subagent fan-out can
    // request N models at once and exhaust system RAM → OOM crash. When at
    // the limit, soft-fail this candidate so driveStream falls over to the
    // next one (typically a cloud model). Only applies to local providers;
    // cloud (openrouter, mistral, etc.) is never throttled here.
    //
    // The slot is RESERVED here (before any await) so parallel tryStream
    // callers can't all pass the check in the same microtask and then all
    // increment past the limit. If anything below throws before the stream
    // is handed back, the finally in the reservation wrapper releases it.
    let reservedLocalSlot = false;
    if (isLocalProvider(ref)) {
      if (localStreamsInFlight >= localStreamLimit()) {
        return skip(`local_concurrency_limit (${localStreamsInFlight} of ${localStreamLimit()} local streams in flight)`);
      }
      localStreamsInFlight++;
      reservedLocalSlot = true;
    }
    // Diagnostic: log exactly what the router resolved for this ref, so a failure
    // (or success) can be correlated with the model's actual provider/api/baseUrl
    // fields instead of guessing. Remove once claude-bridge routing is confirmed stable.
    routerLog(`[diag] tryStream resolved "${ref}" -> provider=${realModel.provider} id=${realModel.id} api=${(realModel as any).api} baseUrl=${(realModel as any).baseUrl ?? 'n/a'}`);
    const apiKey = await sessionCtx.modelRegistry
      .getApiKeyForProvider(realModel.provider)
      .catch(() => null);
    const isLocal = (PROVIDER_MAP as any)[realModel.provider]?.local ?? false;
    // Providers the router itself does not manage (not in PROVIDER_MAP — e.g. models
    // registered by other extensions like claude-bridge) are not subject to the
    // router-managed API-key requirement. The model was already found in Pi's own
    // model registry, which means Pi/the extension can stream it on its own (same
    // mechanism the /model command uses). Only enforce apiKey/local for providers
    // the router actually registers itself.
    const routerManaged = Boolean((PROVIDER_MAP as any)[realModel.provider]);
    if (routerManaged && !apiKey && !isLocal) {
      if (reservedLocalSlot && localStreamsInFlight > 0) localStreamsInFlight--;
      return skip(`no API key for provider "${realModel.provider}"`);
    }
    // Strip the group's virtual apiKey from options — it must not reach the real provider
    const { apiKey: _drop, ...baseOpts } = options ?? {};
    const streamOpts = apiKey ? { ...baseOpts, apiKey } : baseOpts;
    // MEDIUM finding (roborev job 302): if hostStreamSimple throws
    // synchronously (instead of returning null), the thrown error would
    // propagate past this point and the reserved local slot would leak —
    // driveStream's candidate-loop catch turns it into a null target and
    // `continue`s before ever reaching the try/finally that releases. Wrap
    // the stream creation so a throw releases the slot and re-throws.
    let stream: AssistantMessageEventStream | null;
    try {
      stream = hostStreamSimple(realModel, context, streamOpts);
    } catch (streamBuildErr) {
      if (reservedLocalSlot && localStreamsInFlight > 0) localStreamsInFlight--;
      throw streamBuildErr;
    }
    if (!stream) {
      // Release the reserved slot — no stream to consume, so driveStream's
      // finally won't run. Without this the slot leaks and local routing
      // deadlocks after enough failures.
      if (reservedLocalSlot && localStreamsInFlight > 0) localStreamsInFlight--;
      throw new Error(
        `No stream handler available for "${ref}" (provider=${realModel.provider}, api=${realModel.api})`
      );
    }
    // Acquire the local concurrency slot AFTER the stream object is built
    // but BEFORE it is handed to the caller for consumption. The matching
    // release happens in driveStream's finally block after consumeWithDetection
    // settles — we can't release here because tryStream doesn't consume the
    // stream, it only opens it. (Slot already reserved above, pre-await.)
    routerLog(`[diag] tryStream streaming "${ref}" via host runtime`);
    return { stream, ref };
  }

  /**
   * Consume an upstream stream, forwarding events to a proxy stream.
   * Detects soft failures: error events, or no content tokens within a
   * timeout window after the stream starts.
   *
   * Returns { ok: true } if the stream completed with content,
   * or { ok: false, reason } if it should be retried on another model.
   */
  async function consumeWithDetection(
    upstream: AssistantMessageEventStream,
    proxy: AssistantMessageEventStream,
    timeoutMs: number,
    stallMs: number
  ): Promise<{ ok: boolean; reason?: string; detail?: string | undefined; resetAtMs?: number }> {
    let hadContent = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Stall detection: a single timer guards BOTH the first-token window AND
    // mid-stream stalls. The timer is (re)armed on every received event —
    // not just cleared after the first content token — so a stream that opens
    // the connection, emits some content, then goes silent forever (observed
    // with free/rate-limited OpenRouter proxies) is still aborted and handed
    // to the next candidate. Without the re-arm, the for-await loop would
    // block indefinitely: no error, no close, no timeout, no fallback — the
    // whole session hangs until the user hard-kills Pi.
    //
    // Two windows share one timer: `timeoutMs` before the first content token
    // (first-token wait), and `stallMs` after content has started (mid-stream
    // inactivity). They guard different failure modes and needn't be the same
    // duration — a legitimately slow-but-working provider under load can have
    // silent gaps far longer than the first-token wait, so the stall window is
    // a separate, longer configurable value.
    let resolveTimeout: ((v: 'timeout') => void) | null = null;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      resolveTimeout = resolve;
    });
    const fireTimeout = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      resolveTimeout?.('timeout');
    };
    const armTimer = () => {
      if (timer) clearTimeout(timer);
      const ms = hadContent ? stallMs : timeoutMs;
      timer = setTimeout(fireTimeout, ms);
    };
    const clearTimer = () => {
      if (timer) { clearTimeout(timer); timer = null; }
    };
    // Arm the initial first-token timer.
    armTimer();

    // Rate-limit + overflow detection now live in src/detection.ts (single
    // source of truth). Previously isRateLimitText (here, 15 patterns) and
    // isRateLimitError (driveStream, 7 patterns) diverged; both now go through
    // the unified RATE_LIMIT_PATTERNS table imported above.
    //
    // Race: iterate the stream vs timeout
    let rateLimited = false;
    let rateLimitResetAtMs: number | undefined; // Parsed reset time from the error text (if any)
    let overflowDetected = false; // Provider rejected oversized prompt (overflow text)
    let overflowDetail = ''; // Raw provider text that triggered overflow detection
    let repetitionLoop = false; // Model is stuck regenerating the same phrase
    let repetitionDetail = ''; // The repeating unit + count, for the router-info message
    let providerErrorDetected = false; // Any other provider-reported error event (not rate-limit/overflow)
    let providerErrorDetail = ''; // Raw provider error text, for the router-info message
    let accumulatedText = ''; // Accumulate text_delta to check for rate-limit/overflow/repetition text
    let lastRepetitionCheckLen = 0; // Throttle: only re-run the scan once enough new text has arrived
    const iterPromise = (async (): Promise<'done'> => {
      try {
        for await (const event of upstream) {
          // Re-arm the stall timer on every event — this both cancels the
          // first-token timeout once content starts AND restarts the
          // inactivity window for the rest of the stream. A stream that emits
          // content then goes silent will trip the timer again.
          if (!hadContent) {
            const t = event.type;
            if (
              t === 'text_delta' ||
              t === 'thinking_delta' ||
              t === 'toolcall_start' ||
              t === 'toolcall_delta'
            ) {
              hadContent = true;
            }
          }
          armTimer();
          if (event.type === 'error') {
            clearTimer();
            // Check if this is a rate limit or subscription error from claude-bridge.
            // pi-ai's openai-completions provider puts the message on
            // `.errorMessage` (the assistant-message shape), not `.message` —
            // check both so this works across provider families.
            const errObj = (event as any).error;
            const errorMsg = String(errObj?.errorMessage || errObj?.message || errObj || '');
            if (isRateLimitText(errorMsg)) {
              rateLimited = true;
              // Try to extract the reset time from the error text. This lets
              // the router set a cooldown that exactly matches the provider's
              // window (e.g. 2.5h for a five_hour rate limit), instead of
              // guessing with the escalating backoff schedule and risk
              // re-picking the model before the window actually resets.
              rateLimitResetAtMs = parseResetAtMs(errorMsg);
            }
            // Check if this is a context-overflow rejection (Mistral/OpenAI/etc.)
            if (isOverflowErrorText(errorMsg)) {
              overflowDetected = true;
              overflowDetail = errorMsg;
            }
            // Any other provider-reported error — e.g. pi-ai's "Provider
            // finish_reason: <reason>" when a free OpenRouter model (minimax,
            // north-mini-code, inkling observed in practice) ends its stream
            // with an unrecognized finish_reason like a raw "error" value.
            // This still counts as a failure even when content streamed
            // first (hadContent already true) — without this branch it fell
            // through every check below to the final `return { ok: true }`,
            // silently treating a mid-stream provider error as a successful
            // completion: no cooldown recorded, the same broken model gets
            // picked again next turn, and the failure repeats as an apparent
            // hang/loop.
            if (!rateLimited && !overflowDetected) {
              providerErrorDetected = true;
              providerErrorDetail = errorMsg;
            }
            // Don't forward error events — treat as soft failure so driveStream
            // can try the next candidate without showing an error to the user.
            return 'done';
          }
          // Check text_delta content for rate-limit text. claude-bridge
          // sometimes pushes rate-limit/spend-limit messages as text content
          // (via piUI.notify or as result text), not as error events.
          // When detected, mark rateLimited and DON'T forward the text —
          // driveStream will show a proper 'trying next model' message instead.
          if (event.type === 'text_delta') {
            const delta = String((event as any).delta || (event as any).text || '');
            accumulatedText += delta;
            if (isRateLimitText(delta) || isRateLimitText(accumulatedText)) {
              rateLimited = true;
              // Same reset-time extraction as the error-event branch. The
              // text_delta path is the one claude-bridge actually uses for
              // its `piUI.notify(...)` rate-limit warning, so this is the
              // case that triggers most often in practice.
              rateLimitResetAtMs = parseResetAtMs(accumulatedText) ?? rateLimitResetAtMs;
              clearTimer();
              // Stop consuming — don't forward rate-limit text to the user
              return 'done';
            }
            // Some providers return overflow rejections as text content rather
            // than as an error event. Detect it so driveStream can emit the
            // native overflow error and trigger Pi compaction instead of hanging.
            if (isOverflowDeltaText(delta) || isOverflowDeltaText(accumulatedText)) {
              overflowDetected = true;
              overflowDetail = accumulatedText;
              clearTimer();
              // Stop consuming — don't forward the raw provider error text
              return 'done';
            }
            // Some models (observed with devstral variants) get stuck
            // regenerating the same sentence/phrase verbatim instead of
            // finishing the turn. Left alone this burns the whole context
            // window and surfaces as a hard overflow error, after which the
            // router would just retry the same unhealthy model again. Catch
            // it early as a soft failure instead so the group falls over to
            // the next candidate. Throttled — only rescan once enough new
            // text has arrived, so a long healthy stream isn't rescanned on
            // every single delta.
            if (accumulatedText.length - lastRepetitionCheckLen >= 100) {
              lastRepetitionCheckLen = accumulatedText.length;
              const rep = detectDegenerateRepetition(accumulatedText);
              if (rep.detected) {
                repetitionLoop = true;
                repetitionDetail = `"${(rep.unit ?? '').trim().slice(0, 80)}" x${rep.repeats}`;
                clearTimer();
                // Stop consuming — don't forward more of the repeated text
                return 'done';
              }
            }
          }
          proxy.push(event);
        }
      } catch (err) {
        clearTimer();
        // Stream threw — treat as soft failure
        return 'done';
      }
      clearTimer();
      return 'done';
    })();

    const winner = await Promise.race([iterPromise, timeoutPromise]);

    if (winner === 'timeout') {
      // Timeout fired. Two cases share one timer:
      //  - empty_timeout: no content ever arrived (first-token window expired)
      //  - stall_timeout: content started, then the stream went silent for
      //    the full window (mid-stream stall). Both are soft failures that
      //    hand off to the next candidate; stall_timeout just tells the user
      //    a more accurate reason ("stream stalled" vs "no response").
      return { ok: false, reason: hadContent ? 'stall_timeout' : 'empty_timeout' };
    }

    // Stream completed — check if we actually got content or hit a rate limit
    if (overflowDetected) {
      // Provider rejected the prompt as too large for its context window.
      // This is the runtime counterpart to the pre-flight context-window guard
      // (which relies on a token estimate that can undercount when messages
      // carry tool-result content blocks). Surface it so driveStream can emit
      // the native overflow error and let Pi run compaction, instead of trying
      // every remaining candidate (they share the same oversized prompt).
      return { ok: false, reason: 'context_overflow', detail: overflowDetail || undefined };
    }
    if (rateLimited) {
      // Rate limit or subscription error — soft failure, try next model.
      // Pass through the parsed reset time so recordLimit can set a cooldown
      // that exactly matches the provider's window (instead of the default
      // escalating backoff that might expire too early for long windows).
      // Strip the key when undefined so exactOptionalPropertyTypes is happy.
      return {
        ok: false,
        reason: 'rate_limit_exceeded',
        ...(rateLimitResetAtMs ? { resetAtMs: rateLimitResetAtMs } : {}),
      };
    }
    if (repetitionLoop) {
      // Model is stuck regenerating the same phrase — soft failure, try next
      // model instead of letting it burn the whole context window.
      return { ok: false, reason: 'repetition_loop', detail: repetitionDetail || undefined };
    }
    if (providerErrorDetected) {
      // Any other provider error event (not rate-limit/overflow) — soft
      // failure, try next candidate. Checked before `!hadContent` on purpose:
      // a provider that streams partial content and THEN errors still needs
      // this branch, since hadContent alone would otherwise report success.
      return { ok: false, reason: 'provider_error', detail: providerErrorDetail || undefined };
    }

    if (!hadContent) {
      return { ok: false, reason: 'empty_response' };
    }

    return { ok: true };
  }

  /**
   * Stream with automatic retry on soft failures (empty responses, timeouts).
   * Creates a proxy AssistantMessageEventStream that consumers iterate.
   * On failure, records the model as soft-limited and tries the next candidate.
   */
  function extractLastUserPrompt(context: Context): string {
    try {
      const userMsgs = context.messages.filter((m) => m.role === 'user');
      const last = userMsgs[userMsgs.length - 1];
      if (!last) return '';
      const c = last.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c))
        return c
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('');
    } catch {
      /* context shape unknown */
    }
    return '';
  }

  function estimateContextTokens(context: Context): number {
    let total = 0;
    for (const msg of context.messages) {
      // Content may be a string OR an array of content blocks (text, tool_use,
      // tool_result, image, etc.). For arrays, sum the text representation of
      // every block — a tool_result block can easily carry tens of thousands of
      // tokens (a full file read, a command's stdout). Treating arrays as ''
      // silently produced a 0-token estimate for every tool message, which made
      // the context-window guard in driveStream think a 300K-token conversation
      // (after a 1M-context model) was small enough for a 256K model. The
      // provider then hung for minutes trying to ingest an oversized prompt.
      const c = msg.content;
      let text: string;
      if (typeof c === 'string') {
        text = c;
      } else if (Array.isArray(c)) {
        text = c.map((b: any) =>
          typeof b === 'string'
            ? b
            : b?.text ?? b?.content ?? (b != null ? JSON.stringify(b) : '')
        ).join('');
      } else {
        text = c != null ? String(c) : '';
      }
      total += Math.ceil(text.length / 4); // Rough estimate: 4 chars ≈ 1 token
    }
    return total;
  }

  /**
   * Returns the context window (in tokens) for a model ref, or null if unknown.
   * Uses the model registry's contextWindow property (default 128K in Pi).
   * Small local models (e.g. gemma4:12b @ 8K) will return their actual limit.
   */
  function getModelContextWindow(ref: string): number | null {
    if (!sessionCtx) return null;
    const { provider, modelId } = splitRef(ref);
    try {
      const model = sessionCtx.modelRegistry.find(provider, modelId);
      if (!model) return null;
      const cw = (model as any).contextWindow;
      return typeof cw === 'number' && cw > 0 ? cw : null;
    } catch {
      return null;
    }
  }

  /**
   * Whether the model at `ref` advertises a reasoning/thinking capability.
   * Reasoning models think internally before emitting the first output token,
   * so they need a longer first-token timeout than instant chat models —
   * otherwise an overloaded provider (e.g. Mistral serving glm-5-2) gets
   * aborted mid-thought, producing a false "empty response" and a soft-failure
   * cooldown. The router then re-picks the same model on the next turn (it's
   * still the best-ranked) and the timeout fires again — a silent infinite
   * loop that looks like "model never succeeds" even though the model was
   * just slow.
   */
  function isReasoningModel(ref: string): boolean {
    if (!sessionCtx) return false;
    const { provider, modelId } = splitRef(ref);
    try {
      const model = sessionCtx.modelRegistry.find(provider, modelId) as any;
      if (!model) return false;
      // pi-ai's Model type carries `reasoning?: boolean` when the model
      // supports thinking (not to be confused with SimpleStreamOptions.reasoning,
      // which is a `ThinkingLevel` string on the request side, not the model
      // capability flag read here). Some custom providers may expose it as a
      // `thinking` flag instead, so accept either.
      return Boolean(model.reasoning) || Boolean(model.thinking);
    } catch {
      return false;
    }
  }

  /** First-token timeout to use for a given model ref. */
  function getEmptyResponseTimeout(ref: string): number {
    const base = cfg.empty_response_timeout_ms ?? EMPTY_RESPONSE_TIMEOUT_MS;
    const reasoning = cfg.reasoning_empty_response_timeout_ms ?? REASONING_EMPTY_RESPONSE_TIMEOUT_MS;
    return isReasoningModel(ref) ? reasoning : base;
  }

  /**
   * Mid-stream inactivity timeout (after the first content token) for a given
   * model ref. Separate from the first-token timeout: a legitimately
   * slow-but-working provider under load can have silent gaps far longer than
   * the first-token wait, so reusing the first-token value would misclassify
   * healthy-but-slow streams as stalls. Reasoning models get the same value as
   * non-reasoning here — the gap is already generous (default 180s) and the
   * reasoning distinction only matters for the first token (which they spend
   * thinking before emitting).
   */
  function getStallTimeout(ref: string): number {
    return cfg.stall_timeout_ms ?? STALL_TIMEOUT_MS;
  }

  function isCompactionTurn(context: Context): boolean {
    const currentMessageCount = context.messages.length;
    const currentTokenCount = estimateContextTokens(context);

    // Reset if no previous state (first turn)
    if (previousMessageCount === 0) {
      previousMessageCount = currentMessageCount;
      previousTokenCount = currentTokenCount;
      return false;
    }

    // Check for significant drop in either messages or tokens (>30% reduction)
    const messageDrop = currentMessageCount < previousMessageCount * 0.7;
    const tokenDrop = currentTokenCount < previousTokenCount * 0.7;

    // Also check absolute thresholds for small contexts
    const absoluteMessageDrop = previousMessageCount - currentMessageCount > 5;
    const absoluteTokenDrop = previousTokenCount - currentTokenCount > 500;

    // Update state
    previousMessageCount = currentMessageCount;
    previousTokenCount = currentTokenCount;

    return messageDrop || tokenDrop || absoluteMessageDrop || absoluteTokenDrop;
  }

  function extractLastAssistantSnippet(context: Context): string | undefined {
    // Extract the last assistant response (compact for fast classification)
    // Max 150 chars (matches the limit in classifyPrompt)
    try {
      const assistantMsgs = context.messages.filter((m) => m.role === 'assistant');
      const last = assistantMsgs[assistantMsgs.length - 1];
      if (!last) return undefined;
      const c = last.content as string | Array<{ type: string; text: string }> | unknown;
      if (typeof c === 'string') return c.slice(0, 150);
      if (Array.isArray(c)) {
        const textContent = c
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text as string)
          .join('');
        return textContent.slice(0, 150);
      }
    } catch {
      /* context shape unknown */
    }
    return undefined;
  }

  /**
   * The user message BEFORE the current prompt (i.e. the second-to-last user
   * message), for the classifier's context block. Distinct from
   * extractLastUserPrompt(), which returns the CURRENT prompt being classified.
   */
  function extractPreviousUserMessage(context: Context): string | undefined {
    try {
      const userMsgs = context.messages.filter((m) => m.role === 'user');
      const prev = userMsgs[userMsgs.length - 2];
      if (!prev) return undefined;
      const c = prev.content;
      if (typeof c === 'string') return c.slice(0, 150);
      if (Array.isArray(c)) {
        const textContent = c
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text as string)
          .join('');
        return textContent.slice(0, 150);
      }
    } catch {
      /* context shape unknown */
    }
    return undefined;
  }

  function groupStream(
    model: Model<any>,
    context: Context,
    options?: SimpleStreamOptions
  ): AssistantMessageEventStream {
    const useStaticMatch = model.id.match(/^(.+):use-static$/);
    const useStatic = useStaticMatch !== null;
    const groupName = useStaticMatch ? useStaticMatch[1] : model.id;
    const g = cfg.model_groups[groupName];
    const isDynamic = g?.method === 'dynamic';

    if (!isDynamic) {
      const res = resolve(groupName);
      if (!res) throw new Error(`No available models for group "${groupName}"`);
      // fall through with res below
      const proxy = createAssistantMessageEventStream();
      const candidates = [...res.candidates];
      
      // Cost tracking for static routing
      costTracker.trackRequest(res.selected, 1000, 500);
      
      driveStream(proxy, candidates, context, options, undefined, groupName);
      return proxy;
    }

    // Dynamic group: classify the prompt first, then stream from the resolved group
    const proxy = createAssistantMessageEventStream();
    (async () => {
      let candidates: string[];
      let dynamicLabel: string | undefined;
      // Bare group name the candidates came from, kept separate from the decorated
      // dynamicLabel so driveStream can resolve the fallback cascade.
      let resolvedGroup: string | undefined;
      try {
        // If the last message is a tool result, we're mid-conversation — reuse the same
        // model to avoid "unmatched tool result" errors from pi's bridge. But a fresh
        // HINT from the user must always take priority over this shortcut, otherwise
        // any conversation that has used a tool gets stuck reusing one model forever
        // and HINTs are silently ignored.
        const prompt = extractLastUserPrompt(context);
        const lastMsg = context.messages[context.messages.length - 1];
        const isToolFollowUp =
          lastMsg?.role === 'toolResult' && !!lastDynamicModel && !detectHintDirectly(prompt);
        if (isToolFollowUp) {
          // Track which group actually resolved — driveStream needs the bare name
          // to walk the fallback cascade.
          let followUpGroup = 'fallback';
          let res = resolve(followUpGroup);
          if (!res) {
            const alt = Object.keys(cfg.model_groups).find(
              (k) => cfg.model_groups[k].method !== 'dynamic'
            )!;
            followUpGroup = alt;
            res = resolve(alt);
          }
          if (!res) throw new Error('No fallback model for tool follow-up');
          // Prefer the exact model used in the previous turn
          candidates = [lastDynamicModel, ...res.candidates.filter((r) => r !== lastDynamicModel)];
          await driveStream(proxy, candidates, context, options, undefined, followUpGroup);
          return;
        }

        const lastAssistantSnippet = extractLastAssistantSnippet(context);
        const previousUserMessage = extractPreviousUserMessage(context);

        const dynamicGroupCfg = cfg.model_groups['dynamic'];
        // Strip "ollama/" prefix — callOllama expects the bare model name
        const stripOllama = (ref: string) => ref.replace(/^ollama\//, '');
        const classifyOpts: Parameters<typeof classifyPrompt>[1] = {
          allowStaticFallback: useStatic,
          // Data minimization: opt-in only, see classifier_cloud_fallback doc
          // comment in types.ts. Off by default so a provider's free_models
          // (configured for actual answering fallback) isn't silently reused
          // to also receive raw prompt content for classification.
          allowCloudFallback: dynamicGroupCfg?.classifier_cloud_fallback === true,
          cfg,
          cache,
          context: {
            lastAssistantSnippet,
            previousUserMessage,
            lastCategory: lastClassifiedCategory,
            lastModel: lastDynamicModel || undefined,
            isCompaction: isCompactionTurn(context),  // Pass context for detection
            lastModelLimited: lastDynamicModel ? isLimited(lastDynamicModel) : false,
          },
        };
        if (dynamicGroupCfg?.classifier_model)
          classifyOpts.model = stripOllama(dynamicGroupCfg.classifier_model);
        if (dynamicGroupCfg?.classifier_fallback)
          classifyOpts.fallbackModel = stripOllama(dynamicGroupCfg.classifier_fallback);

        const classification = await classifyPrompt(prompt, classifyOpts);

        // Track the resolved category for next turn's short-prompt momentum
        // ('yes', 'do it', ...). Hint results have no category — leave the
        // prior value in place rather than clearing it, since a hint is a
        // one-off override, not evidence the task category changed.
        if ('category' in classification) {
          lastClassifiedCategory = classification.category;
        }

        // Check for HINT override
        if ('hintType' in classification) {
          if (classification.hintType === 'group') {
            const res = resolve(classification.hintTarget);
            if (res) {
              const hintSeen = new Set<string>(res.candidates);
              const hintFallbacks = cfg.model_groups[classification.hintTarget]?.fallback_groups ?? [];
              for (const fbGroup of hintFallbacks) {
                const fbRes = resolve(fbGroup);
                if (!fbRes) continue;
                for (const ref of fbRes.candidates) {
                  if (!hintSeen.has(ref)) { hintSeen.add(ref); res.candidates.push(ref); }
                }
              }
              candidates = [...res.candidates];
              lastDynamicModel = res.selected;
              dynamicLabel = `HINT: ${classification.hintTarget} → ${res.selected}`;
              const logLine = `${new Date().toISOString()}  ${dynamicLabel}  "${prompt.slice(0, 80).replace(/\n/g, ' ')}"`;
              appendRawLog(logLine);

              // Cost tracking for HINT override
              costTracker.trackRequest(res.selected, 1000, 500);
              await driveStream(
                proxy,
                candidates,
                context,
                options,
                dynamicLabel,
                classification.hintTarget
              );
              return;
            }
            // resolve() always returns null for method:'dynamic' groups (the
            // classifier itself IS that group — hinting "use group dynamic" is
            // a no-op, not an error) and for genuinely unknown group names.
            // Distinguish the two in the log so a stale/typo'd HINT target
            // doesn't look identical to "user asked to re-run classification".
            const hintedGroup = cfg.model_groups[classification.hintTarget];
            if (hintedGroup?.method === 'dynamic') {
              routerLog(`[dynamic] HINT targets the dynamic group itself — falling through to normal classification: ${classification.hintTarget}`);
            } else {
              routerLog(`[dynamic] HINT group not found: ${classification.hintTarget}`);
            }
          } else if (classification.hintType === 'model') {
            // Direct model override — resolve short name (e.g. "mistral-medium-3.5") to
            // fully-qualified "provider/model" ref by searching all discovered models.
            const shortName = classification.hintTarget;
            let resolvedTarget: string;
            // Every ref that satisfies the hint, best first. The same model is often
            // offered by several providers; they are siblings, not alternatives, so
            // they are tried before we ever fall back to a *different* model.
            let hintSiblings: string[] = [];

            // The bare model name the hint refers to, with any provider prefix stripped
            // ("claude-bridge/claude-sonnet-5" -> "claude-sonnet-5").
            const bareName = shortName.includes('/')
              ? shortName.slice(shortName.lastIndexOf('/') + 1)
              : shortName;

            // Collect *every* provider offering this model — never stop at the first
            // match. Picking the first hit made an unusable provider (e.g. `anthropic`
            // without a key) shadow a working one (e.g. `claude-bridge`).
            const matches: string[] = [];
            const addMatch = (ref: string) => {
              if (ref && !matches.includes(ref)) matches.push(ref);
            };
            const namesMatch = (ref: string) =>
              ref === shortName || ref.endsWith('/' + bareName) || ref.split('/').pop() === bareName;

            for (const ref of router.allDiscoveredRefs()) {
              if (namesMatch(ref)) addMatch(ref);
            }

            // Direct registry lookup catches models that getAvailable() filters out
            // (e.g. registered by other extensions). Provider list is derived from what's
            // actually configured/known — never hardcoded, since it differs per setup.
            if (sessionCtx?.modelRegistry) {
              const knownProviders = new Set<string>([
                ...Object.keys(PROVIDER_MAP),
                ...Object.keys(cfg.providers ?? {}),
                ...router.allDiscoveredRefs().map(ref => ref.split('/')[0]),
              ]);
              for (const provider of knownProviders) {
                const model = sessionCtx.modelRegistry.find(provider, bareName);
                if (model) addMatch(`${provider}/${model.id}`);
              }
            }

            // Last resort: scan every group's top models.
            if (!matches.length) {
              const allGroupModels: string[] = [];
              for (const [groupName] of Object.entries(cfg.model_groups)) {
                try {
                  for (const item of router.getTopModels(groupName, 100)) allGroupModels.push(item.ref);
                } catch (e) {
                  // Ignore errors for individual groups
                }
              }
              const viaGroups = resolveShortModelName(bareName, allGroupModels);
              if (viaGroups) {
                addMatch(viaGroups);
                routerLog(`[dynamic] HINT: resolved "${shortName}" to "${viaGroups}" via group scan`);
              }
            }

            if (matches.length) {
              // A fully-qualified hint names an exact provider: honour it first if it
              // works, but keep the siblings so a dead provider cannot kill the hint.
              const ranked = await rankHintCandidates(
                matches,
                cfg.model_groups,
                sessionCtx?.modelRegistry,
                lookupGdp,
                (unusable) => routerLog(`[dynamic] HINT: skipping unusable refs (no handler/credentials): ${unusable.join(', ')}`)
              );
              if (shortName.includes('/') && matches.includes(shortName) && (await isRefUsable(shortName, cfg.model_groups, sessionCtx?.modelRegistry))) {
                hintSiblings = [shortName, ...ranked.filter(r => r !== shortName)];
              } else {
                hintSiblings = ranked;
              }
              resolvedTarget = hintSiblings[0];
              routerLog(
                `[dynamic] HINT "${shortName}" -> ${resolvedTarget}` +
                  (hintSiblings.length > 1 ? ` (siblings: ${hintSiblings.slice(1).join(', ')})` : '')
              );
            } else {
              routerLog(`[dynamic] HINT model "${shortName}" not found in any source; will use as-is and rely on fallback`);
              resolvedTarget = shortName;
              hintSiblings = [shortName];
            }

            // Same model on another provider ranks ahead of any unrelated model.
            candidates = [...hintSiblings];

            // The user explicitly requested this model via HINT (or selected it directly
            // in Pi's model picker, which resolves to the same HINT path on every turn) —
            // a stale cooldown from an earlier, unrelated failure must not silently block
            // this deliberate choice. Auto-generated hints (e.g. compaction model
            // continuity, which the router invents on its own) are a preference, not a
            // deliberate choice, so any cooldown on the target is respected instead.
            const isExplicitHint = classification.origin !== 'auto';
            if (isExplicitHint) {
              candidates.forEach(ref => clearLimit(ref));
            }
            
            // Append fallback models from what's actually registered in Pi (no invented
            // provider prefixes — only real refs from the session's model registry).
            // Their cooldowns are NEVER cleared, explicit hint or not: unlike the HINT
            // target itself, these are auto-appended by the router, not a deliberate
            // choice, so a fresh cooldown from a failure moments ago must still apply.
            // Every turn re-runs HINT resolution (a UI-selected model resolves to a HINT
            // on every message), so clearing fallback cooldowns here used to wipe out the
            // router's own protection on every single turn — the observed symptom was a
            // model that had just hard-failed being retried again within seconds, over
            // and over, looking like the whole session had hung.
            if (sessionCtx?.modelRegistry) {
              // Pi's registry is NOT pre-filtered — it contains models the user
              // excluded (exclude.models / providers / paid_models_from). Because
              // this pool is sorted by GDPval descending, an excluded top-tier
              // model (e.g. claude-opus-5 at 1860) would otherwise land in slot 1
              // of every HINT fallback and quietly burn the very budget the
              // exclude rule was meant to protect. The explicit HINT target itself
              // is honoured regardless — that is a deliberate user choice — but
              // auto-appended fallbacks must respect the exclude rules.
              const exCtx: ExcludeContext | null = cfg.exclude
                ? { rules: cfg.exclude, cfg, cache }
                : null;
              const availableModels = sessionCtx.modelRegistry
                .getAvailable()
                .map((m: any) => `${m.provider}/${m.id}` as string)
                .filter((ref: string) => !exCtx || !isExcluded(ref, exCtx));

              const sortedByGdpval = [...availableModels].sort((a, b) => {
                const gdpvalA = lookupGdp(a) ?? 0;
                const gdpvalB = lookupGdp(b) ?? 0;
                return gdpvalB - gdpvalA;
              });

              // Only offer fallbacks that can actually serve the request, so a provider
              // without credentials cannot consume a fallback slot ahead of a working one.
              // Usability checks run concurrently rather than one-by-one — each may hit
              // the host's async getApiKeyForProvider, and candidates are independent.
              const fallbackPool = sortedByGdpval.filter(ref => !candidates.includes(ref));
              const fallbackUsability = await Promise.all(
                fallbackPool.map(ref => isRefUsable(ref, cfg.model_groups, sessionCtx.modelRegistry))
              );
              const fallbackCandidates = fallbackPool.filter((_, i) => fallbackUsability[i]).slice(0, 5);
              
              if (fallbackCandidates.length) {
                routerLog(`[dynamic] HINT fallback candidates for "${resolvedTarget}": ${fallbackCandidates.join(', ')}`);
                candidates.push(...fallbackCandidates);
              }
            }
            
            lastDynamicModel = resolvedTarget;
            dynamicLabel = `HINT: ${classification.hintTarget}`;
            const logLine = `${new Date().toISOString()}  ${dynamicLabel}  ${resolvedTarget}  "${prompt.slice(0, 80).replace(/\n/g, ' ')}"`;
            appendRawLog(logLine);
            costTracker.trackRequest(resolvedTarget, 1000, 500);
            // Every other driveStream call site passes a bare group name so that,
            // if every candidate fails, getFallbackGroup() can cascade to a
            // lower tier instead of just hard-failing. This one used to pass
            // none (groupName undefined), so a direct-model HINT override (the
            // resolved model + its siblings + up to 5 auto-appended fallbacks)
            // had NO cascade at all once all of those failed — dead end straight
            // to "All N candidates failed". Approximate the model's natural
            // group from its GDPval, mirroring the tiering the classifier uses
            // for escalation (expensive→strategic, medium→tactical, cheap→scout),
            // so the cascade still lands somewhere sensible for this model.
            const resolvedGdpval = lookupGdp(resolvedTarget) ?? 0;
            const hintStartGroup =
              resolvedGdpval >= 700 ? 'strategic' : resolvedGdpval >= 300 ? 'tactical' : 'scout';
            await driveStream(proxy, candidates, context, options, dynamicLabel, hintStartGroup);
            return;
          }
        }
        
        // For normal classification (not HINT), map the category to a group.
        // (The earlier separate cost-tier overlay was removed; the group's own
        // min_gdpval/max_cost settings are the cost/quality gate.)
        // Type assertion: if it's not a HINT, it must have a category
        const normalClassification = classification as ClassificationResult;
        
        // ── Session Escalation: Override group with escalation level ────────
        let targetGroup: string;
        if (escalation.level !== 'operational') {
          targetGroup = escalation.level;
          routerLog(`[escalation] Using escalated group: ${targetGroup} (level: ${escalation.level})`);
        } else {
          targetGroup = getGroupForCategory(normalClassification.category);
        }

        // Collect candidates: target group first, then fallback_groups in order (deduped)
        let res = resolve(targetGroup);
        resolvedGroup = targetGroup;
        if (!res) {
          res = resolve('fallback');
          resolvedGroup = 'fallback';
        }
        if (!res) throw new Error(`No models for dynamic target "${targetGroup}"`);

        const seen = new Set<string>(res.candidates);
        const fallbackCandidates: string[] = [];
        const groupFallbacks = cfg.model_groups[targetGroup]?.fallback_groups ?? [];
        for (const fbGroup of groupFallbacks) {
          const fbRes = resolve(fbGroup);
          if (!fbRes) continue;
          for (const ref of fbRes.candidates) {
            if (!seen.has(ref)) { seen.add(ref); fallbackCandidates.push(ref); }
          }
        }

        candidates = [...res.candidates, ...fallbackCandidates];
        lastDynamicModel = res.selected;
        dynamicLabel = `${normalClassification.category} → ${targetGroup}`;
        const logLine = `${new Date().toISOString()}  ${dynamicLabel}  ${res.selected}  "${prompt.slice(0, 80).replace(/\n/g, ' ')}"`;
        appendRawLog(logLine);
        costTracker.trackRequest(res.selected, 1000, 500);
      } catch (err) {
        routerLog('[dynamic] classification failed, using fallback:', err);
        resolvedGroup = 'fallback';
        let fb = resolve('fallback');
        if (!fb) {
          const alt = Object.keys(cfg.model_groups).find(
            (k) => cfg.model_groups[k].method !== 'dynamic'
          )!;
          resolvedGroup = alt;
          fb = resolve(alt);
        }
        if (!fb) {
          pushStreamError(proxy, `[router] Dynamic routing failed: ${err}`);
          return;
        }
        candidates = [...fb.candidates];
      }
      await driveStream(proxy, candidates, context, options, dynamicLabel, resolvedGroup);
    })();
    return proxy;
  }

  /**
   * Push a router info message as proper text_delta events with the required
   * `contentIndex` and `partial` fields. Without `partial` (which must be a
   * valid AssistantMessage with `role`), Pi's compaction crashes with:
   *   'Cannot read properties of undefined (reading role)'
   * Every text_delta MUST be wrapped in text_start/text_end to form a complete
   * content block, otherwise the proxy stream produces malformed messages.
   */
  // Rate-limit error detection for fallback logic.
  // Only treat REAL rate-limit errors as triggering fallback.
  // Rate-limit detection now uses the unified isRateLimitText from
  // src/detection.ts. Previously this was a SECOND, divergent scanner
  // (7 patterns) that disagreed with consumeWithDetection's scanner (15
  // patterns). Both paths now share one pattern table — no more divergence.
  //
  // empty_response/empty_timeout are NOT rate limits because they can
  // be transient overloads (especially for free models) — triggering a
  // fallback cascade on every empty response would exhaust all tiers
  // when a simple retry would suffice.

  function driveStream(
    proxy: AssistantMessageEventStream,
    candidates: string[],
    context: Context,
    options: SimpleStreamOptions | undefined,
    label?: string,
    // The raw group name the candidates came from. MUST be kept separate from
    // `label`, which is a decorated display string ("code_complex → tactical",
    // "HINT: tactical → openrouter/x:free"). getFallbackGroup needs a bare group
    // name; feeding it the label made every lookup miss and left the whole
    // fallback cascade unreachable.
    groupName?: string,
    // Groups already tried earlier in this cascade — prevents infinite recursion
    // when two groups' auto-generated fallback_groups reference each other
    // (e.g. tactical ⇄ strategic), which previously crashed with "Maximum call
    // stack size exceeded" whenever both groups' candidates failed.
    visitedGroups?: Set<string>
  ): Promise<void> {
    return (async () => {
      // Preserve the active group (e.g., 'dynamic') for display purposes
      if (activeGroup) {
        router.setActiveGroup(activeGroup);
      }
      let lastError: string | undefined;
      // Track every failure, not just the last one, so the final error message doesn't
      // hide earlier (possibly more relevant) failures behind a random last candidate.
      // The ref is carried alongside the message rather than re-parsed out of it:
      // refs legitimately contain colons (openrouter/qwen/qwen3-4b:free), so any
      // split on the first ':' loses exactly the free-model refs we most need to
      // report on.
      const allErrors: { ref: string; message: string }[] = [];
      const pushError = (ref: string, message: string): void => {
        lastError = `${ref}: ${message}`;
        allErrors.push({ ref, message });
      };

      // Track how many candidates were skipped ONLY because their context window
      // is smaller than the current conversation. If EVERY failure is a
      // context-window skip (no other error types), the conversation overflowed
      // every available model — we emit a native-style overflow error so Pi's
      // own compaction kicks in (it recognises the "prompt is too long" pattern
      // via @earendil-works/pi-ai/utils/overflow). Without this, a session that
      // grew under a 1M-context model (e.g. 170K tokens, 17% of 1M) freezes on
      // switch to a Dynamic group: every candidate is skipped before the request
      // ever reaches a provider, so no provider ever returns an overflow error,
      // so Pi never compacts, so nothing ever fits — an infinite skip loop.
      let contextOverflowSkips = 0;
      // Track candidates skipped ONLY because they're in cooldown. If EVERY
      // candidate across EVERY group in the cascade is in cooldown (total
      // cooldown collapse), there is no useful fallback — every group draws
      // from overlapping candidate pools. Rather than emit a generic "All N
      // candidates failed" that surfaces as Pi's opaque "Unknown error", we pick
      // the candidate with the shortest remaining cooldown and try it anyway
      // (the cooldown is a heuristic, not a hard provider-side limit). This
      // keeps the session responsive instead of hard-failing.
      let cooldownSkips = 0;

      // Estimate the conversation token count ONCE — used to skip models whose
      // context window is too small for the current context (e.g. an 8K local
      // model can't compact a 30K-token conversation).
      const contextTokens = estimateContextTokens(context);

      // Iterate every candidate in order; skip limited or unregistered ones without
      // consuming the remainder. This ensures all group models are tried even if some
      // are not yet in Pi's session registry or are temporarily rate-limited.
      for (let i = 0; i < candidates.length; i++) {
        const ref = candidates[i];
        if (isLimited(ref)) {
          pushError(ref, `skipped, still in cooldown (${router.limitSecs(ref)}s remaining)`);
          cooldownSkips++;
          continue;
        }
        // Context-window guard: skip models whose context window is smaller than
        // the current conversation. This prevents timeout/failure when compacting
        // large conversations with small-context models (e.g. gemma4:12b @ 8K).
        const ctxWindow = getModelContextWindow(ref);
        if (ctxWindow && contextTokens > ctxWindow) {
          pushError(ref, `skipped, context window ${ctxWindow} < ${contextTokens} tokens needed`);
          contextOverflowSkips++;
          continue;
        }
        const target = await tryStream(ref, context, options).catch((err) => {
          // Filter out expected/transient errors to reduce noise
          const errorMsg = String(err.message || err);
          const isExpectedError = isExpectedTransientError(errorMsg);
          if (!isExpectedError) {
            console.log(`[router] Skipping ${ref}: ${errorMsg}`);
          }
          // Always record the real reason, even for "expected" errors, so the final
          // error message reflects what actually happened instead of "no candidates".
          pushError(ref, errorMsg);
          recordSoftFailure(ref);
          // Notify user about hard failures so they know we tried alternatives
          pushRouterInfo(proxy, `> [router] Trying next model (${ref} unavailable: ${errorMsg})\n\n`);
          return null;
        });
        if (!target) {
          // tryStream returned null without throwing — record WHY, otherwise this
          // candidate vanishes from the failure list and the user sees
          // "All 9 candidates failed" with only 4 entries.
          const why = skipReasons.get(ref);
          if (why) pushError(ref, why);
          // A skip is a failure too — without this, structurally-broken candidates
          // (not in Pi's registry, no API key, provider is a group) never accrue a
          // cooldown or a model-health malus. They get re-tried on literally every
          // single request forever, which at high request volume (long subagent
          // sessions) turned into over a million repeated "not registered" log
          // lines in one session. recordSoftFailure both starts the isLimited()
          // cooldown ladder (so the next request skips this ref instantly, before
          // ever calling tryStream again) and demotes it via model-health scoring.
          recordSoftFailure(ref);
          continue;
        }

        // Show which model is actually being used
        const prefix = label ? `${label} · ${ref}` : ref;
        pushRouterInfo(proxy, `> [router] ${prefix}\n\n`);

        // Update the status line as soon as the stream was created successfully —
        // waiting for the stream to finish would leave the previous model displayed
        // for the whole turn. Candidates that fail in tryStream never get here, so
        // the line still never shows a model that was skipped outright.
        //
        // Deliberately never call pi.setModel() here: that replaces the *session's*
        // active model, which for group routing is the virtual group model (e.g.
        // "standard/standard"). Swapping it for the resolved concrete model fires
        // model_select, which clears activeGroup and permanently routes future
        // turns straight to that one model instead of back through groupStream —
        // group routing then silently stops after the first request. Track the
        // resolved ref only in the router's own state and the module-level
        // curModel/lastDynamicModel used for metrics attribution and the footer.
        router.setCurModel(ref);
        router.setActiveGroup(activeGroup);
        curModel = ref;
        lastDynamicModel = ref;

        try {
          const result = await consumeWithDetection(target.stream, proxy, getEmptyResponseTimeout(ref), getStallTimeout(ref));

          if (result.ok) {
            // Success — record healthy, proxy completes via the pushed "done" event
            recordOk(ref);
            return;
          }

          // Rate-limit / spend-limit failure — record a HARD limit (not soft)
          // so the model is properly skipped in future attempts and API keys
          // are rotated. Without this, the router only records a short soft
          // backoff and keeps retrying the same rate-limited model.
          //
          // The actual recording (hard cooldown + key rotation vs. short soft
          // backoff) is delegated to the shared recordStreamFailure() helper,
          // which the force-retry path also uses — so the two paths can't drift
          // apart on escalation policy. Each branch still owns its own
          // user-facing message.
          if (result.reason === 'rate_limit_exceeded') {
            const rlResult = recordStreamFailure(ref, String(result.reason), result.resetAtMs);
            pushError(ref, 'rate_limit_exceeded');
            const nextRef = candidates.slice(i + 1).find(r => !isLimited(r));
            const suffix = nextRef ? `, trying ${nextRef} …` : '';
            const keyMsg = rlResult.rotated ? ` (key rotated to ${rlResult.newKey})` : '';
            // If we parsed a reset time, surface it so the user can see when
            // this model is expected to be available again (instead of just
            // the generic "rate limit" message and a mystery cooldown).
            const resetMsg = result.resetAtMs
              ? ` (resets ${new Date(result.resetAtMs).toLocaleString()})`
              : '';
            pushRouterInfo(proxy, `> [router] ${ref} — rate limit/spend limit reached${resetMsg}${keyMsg}${suffix}\n\n`);
            continue;
          }

          // The provider itself rejected the prompt as too large for its context
          // window (detected in consumeWithDetection from the error/text content,
          // not from the pre-flight token estimate). This is a definitive signal —
          // unlike the pre-flight guard's estimate, which can undercount when
          // messages carry tool-result content blocks, the provider has actually
          // measured the real prompt size. Emit the native overflow error right
          // away instead of burning time on the remaining candidates (they were
          // ranked by GDPval/cost, not context window, so trying them in order
          // could mean minutes of hangs on more undersized models before reaching
          // one — if any — that's actually large enough).
          if (result.reason === 'context_overflow') {
            pushError(ref, 'context_overflow (provider rejected prompt as too large)');
            recordSoftFailure(ref);
            pushStreamError(
              proxy,
              `[router] ${ref} rejected the prompt as too large for its context window — triggering compaction.`,
              // Prefer the provider's own overflow text (it has the real measured
              // token count) over the router's estimate, which can be inaccurate
              // for the reasons documented on estimateContextTokens().
              result.detail
                ? `prompt is too long: ${result.detail}`
                : `prompt is too long: ${contextTokens} tokens exceeds the maximum context length`
            );
            return;
          }

          // Model got stuck regenerating the same phrase instead of finishing
          // the turn. Unlike context_overflow this isn't a prompt-size problem —
          // there's no point signalling compaction — so just demote the model
          // via the normal soft-failure health penalty and move to the next
          // candidate, same as an empty response.
          if (result.reason === 'repetition_loop') {
            pushError(ref, `repetition_loop (${result.detail ?? 'stuck repeating output'})`);
            recordSoftFailure(ref);
            const nextRef = candidates.slice(i + 1).find(r => !isLimited(r));
            const suffix = nextRef ? `, trying ${nextRef} …` : '';
            pushRouterInfo(
              proxy,
              `> [router] ${ref} — stuck in a repetition loop (${result.detail ?? 'loop detected'})${suffix}\n\n`
            );
            continue;
          }

          // Soft failure — record and try next candidate
          //
          // IMPORTANT: For cloud providers (openrouter, etc.), an empty_response
          // or empty_timeout can be a rate-limit, auth error, or just a
          // transient overload. The right response depends on the model type:
          //
          // - FREE models (":free" suffix): These are often just overloaded
          //   (free tier has low priority). Use a SHORT soft backoff so they
          //   get retried on the next turn without permanently blocking them.
          //
          // - PAID cloud models: An empty response is more likely a real
          //   rate-limit (429) or auth error. Use a HARD cooldown.
          //
          // The escalation decision (hard cooldown + key rotation for a paid
          // cloud empty response, short soft backoff otherwise) is delegated
          // to the shared recordStreamFailure() helper used by the force-retry
          // path too. This branch keeps its own user-facing message.
          const isCloudProvider = !ref.startsWith('ollama/') && !ref.startsWith('lm-studio/');
          const isEmptyFailure = result.reason === 'empty_response'
            || result.reason === 'empty_timeout'
            || result.reason === 'stall_timeout';
          const isFreeModel = ref.includes(':free');
          if (isCloudProvider && isEmptyFailure && !isFreeModel) {
            // Paid cloud model — treat as rate-limit (hard cooldown)
            const rlResult = recordStreamFailure(ref, String(result.reason), result.resetAtMs);
            pushError(ref, `${result.reason} (treated as rate-limit)`);
            const nextRef = candidates.slice(i + 1).find(r => !isLimited(r));
            const suffix = nextRef ? `, trying ${nextRef} …` : '';
            const keyMsg = rlResult.rotated ? ` (key rotated to ${rlResult.newKey})` : '';
            const paidLabel = result.reason === 'stall_timeout'
              ? 'stream stalled (likely rate limit)'
              : 'empty response (likely rate limit)';
            const resetMsg = result.resetAtMs
              ? ` (resets ${new Date(result.resetAtMs).toLocaleString()})`
              : '';
            pushRouterInfo(proxy, `> [router] ${ref} — ${paidLabel}${resetMsg}${keyMsg}${suffix}\n\n`);
            continue;
          }

          // Local model soft failure — short backoff only
          pushError(ref, String(result.reason));
          recordSoftFailure(ref);

          // Notify the user about the empty response, with next candidate hint if available
          const reason = result.reason === 'empty_timeout'
            ? 'no response within timeout'
            : result.reason === 'stall_timeout'
              ? 'stream stalled mid-response'
              : result.reason === 'provider_error'
                ? `provider error${result.detail ? `: ${result.detail}` : ''}`
                : 'empty response from model';
          const nextRef = candidates.slice(i + 1).find(r => !isLimited(r));
          const suffix = nextRef ? `, trying ${nextRef} …` : '';
          pushRouterInfo(proxy, `> [router] ${ref} — ${reason}${suffix}\n\n`);
        } catch (streamError) {
          // Hard failure (e.g., "No API provider registered") — treat as soft failure
          const errorMsg = streamError instanceof Error ? streamError.message : String(streamError);
          pushError(ref, errorMsg);
          recordSoftFailure(ref);
          const nextRef = candidates.slice(i + 1).find(r => !isLimited(r));
          const suffix = nextRef ? `, trying ${nextRef} …` : '';
          pushRouterInfo(proxy, `> [router] ${ref} — error: ${errorMsg}${suffix}\n\n`);
        } finally {
          // Release the local concurrency slot acquired in tryStream. Must
          // run on every path: success (return), soft-failure (continue),
          // and hard-failure (catch). Cloud providers were never counted and
          // are never released — guarded by isLocalProvider(ref).
          if (isLocalProvider(ref) && localStreamsInFlight > 0) localStreamsInFlight--;
        }
      }

      // All retries exhausted — try a fallback group if one is configured.
      // Previously, fallback only fired when ALL errors were rate-limit related.
      // But that's too narrow: if mixed errors (empty_response, rate_limit,
      // soft failures) all fail, the user still needs a working model. Now we
      // fire the fallback cascade whenever ALL candidates failed, regardless
      // of the specific error type. The fallback group's own candidates will
      // be filtered by isLimited() so rate-limited models are still skipped.
      const allFailed = allErrors.length > 0;

      // Resolve the cascade from the RAW group name, never from `label`.
      // `label` is a display string ("code_complex → tactical") that matches no
      // group, so keying off it made getFallbackGroup return null every single
      // time and the cascade below was unreachable dead code.
      //
      // This MUST run before the context-overflow short-circuit below. A
      // group's own candidate list is filtered by min_gdpval/max_cost, not by
      // context window, so it's entirely possible for a lower-priority
      // fallback group to contain a model with a larger context window than
      // anything in the current group — walking the cascade first gives that
      // model a chance before giving up and asking Pi to compact.
      if (allFailed && groupName) {
        const visited = visitedGroups ?? new Set<string>();
        visited.add(groupName);
        const fallbackGroup = getFallbackGroup(groupName, cfg.model_groups, visited);
        if (fallbackGroup) {
          const fb = resolve(fallbackGroup);
          if (fb?.candidates?.length) {
            pushRouterInfo(proxy, `> [router] All models in ${groupName} failed, trying ${fallbackGroup}...\n\n`);
            // Recursively try the fallback group
            await driveStream(
              proxy,
              fb.candidates,
              context,
              options,
              `${label ?? groupName}→${fallbackGroup}`,
              fallbackGroup,
              visited
            );
            return;
          }
        }
      }

      // Context-overflow short-circuit: if EVERY candidate was skipped because
      // its context window is too small for the current conversation, AND the
      // fallback cascade above is exhausted (no further group to try, or none
      // configured), asking the user to wait for yet more failures is
      // pointless. Emit a native-style overflow error (the "prompt is too
      // long" pattern that @earendil-works/pi-ai/utils/overflow recognises).
      // Pi will detect it, run its own compaction with an appropriate model,
      // and retry — exactly the path that already works when a provider
      // returns a real overflow error. Without this, a session that grew
      // under a large-context model (e.g. 170K tokens gathered under a 1M
      // model like Gemini 2.5 Pro) would otherwise freeze on switch to a
      // Dynamic group: every candidate in every group gets skipped before any
      // request ever reaches a provider, so no provider ever returns an
      // overflow error, so Pi's native compaction never fires.
      if (allFailed && contextOverflowSkips > 0 && contextOverflowSkips === allErrors.length) {
        pushStreamError(
          proxy,
          `[router] Conversation (${contextTokens} tokens) exceeds every available model's context window — triggering compaction.`,
          // errorMessage is what Pi's isContextOverflow() inspects. The exact
          // phrasing matches the Anthropic overflow pattern, which is the most
          // reliably-detected one in @earendil-works/pi-ai/utils/overflow.
          `prompt is too long: ${contextTokens} tokens exceeds the maximum context length of available models`
        );
        return;
      }

      // Total cooldown collapse: this check runs per driveStream invocation,
      // i.e. per group — in a multi-group cascade it only fires for the LAST
      // group actually reached (the fallback-cascade block above already
      // returned if an earlier group had somewhere left to fall back to). By
      // the time we get here, every candidate in THIS group's list is in
      // cooldown and no other (non-cooldown) error occurred, and there is no
      // further group to try. Retrying within this same group is still useful
      // — they share the same candidate pool as any later group would have
      // anyway — pick the candidate with the shortest remaining cooldown and
      // try it anyway: the cooldown is a router-internal heuristic, not a hard
      // provider limit, so the request may well succeed. This keeps long
      // sessions responsive instead of deadlocking until the longest cooldown
      // expires.
      //
      // Also logs the collapse for post-hoc analysis (how often, which refs).
      if (allFailed && cooldownSkips > 0 && cooldownSkips === allErrors.length) {
        // Find the candidate with the shortest remaining cooldown across the
        // whole candidate list (not just allErrors — same content here, but be
        // explicit about scanning the source of truth).
        let bestRef: string | null = null;
        let bestSecs = Number.POSITIVE_INFINITY;
        for (const ref of candidates) {
          const secs = router.limitSecs(ref);
          if (secs < bestSecs) {
            bestSecs = secs;
            bestRef = ref;
          }
        }
        if (bestRef) {
          routerLog(
            `[router] Total cooldown collapse — all ${candidates.length} candidate(s) in ` +
              `cooldown. Force-retrying ${bestRef} (${bestSecs}s remaining, shortest). `
          );
          pushRouterInfo(
            proxy,
            `> [router] All models in cooldown, retrying ${bestRef} (shortest cooldown, ${bestSecs}s)...\n\n`
          );
          // Bypass the isLimited() guard by calling tryStream directly. If it
          // succeeds, consume the stream exactly like the main loop does —
          // otherwise we'd return a target that nobody consumes and Pi would
          // hang waiting for output that never arrives.
          router.setCurModel(bestRef);
          router.setActiveGroup(activeGroup);
          curModel = bestRef;
          lastDynamicModel = bestRef;
          const target = await tryStream(bestRef, context, options).catch((err) => {
            const errorMsg = err instanceof Error ? err.message : String(err);
            pushError(bestRef!, errorMsg);
            // A hard failure here isn't necessarily a soft cooldown-worthy issue
            // (could well be a real rate-limit/auth error that just didn't come
            // through as a normal result.reason) — same escalation as the main
            // loop's stream-error branch below, which also has no result.reason
            // to branch on and falls back to recordSoftFailure. Kept consistent.
            recordSoftFailure(bestRef!);
            return null;
          });
          if (target) {
            try {
              const result = await consumeWithDetection(target.stream, proxy, getEmptyResponseTimeout(bestRef), getStallTimeout(bestRef));
              if (result.ok) {
                recordOk(bestRef);
                return;
              }
              pushError(bestRef, String(result.reason));
              // The provider rejected the force-retried prompt as too large for
              // its context window. Mirror the main loop's context_overflow
              // branch: emit the native-style overflow error (the pattern Pi's
              // isContextOverflow() recognises) and return, so compaction fires —
              // instead of falling through to the generic "All candidates failed"
              // emit, which has no overflow-pattern errorMessage and so would
              // never trigger compaction even though the provider definitively
              // measured the prompt as oversized.
              if (result.reason === 'context_overflow') {
                pushError(bestRef, 'context_overflow (provider rejected prompt as too large)');
                recordSoftFailure(bestRef);
                pushStreamError(
                  proxy,
                  `[router] ${bestRef} rejected the prompt as too large for its context window — triggering compaction.`,
                  result.detail
                    ? `prompt is too long: ${result.detail}`
                    : `prompt is too long: ${contextTokens} tokens exceeds the maximum context length`
                );
                return;
              }
              if (result.reason === 'repetition_loop') {
                pushError(bestRef, `repetition_loop (${result.detail ?? 'stuck repeating output'})`);
                recordSoftFailure(bestRef);
                pushRouterInfo(
                  proxy,
                  `> [router] ${bestRef} — stuck in a repetition loop (${result.detail ?? 'loop detected'})\n\n`
                );
              } else {
                // Escalate exactly like the main loop: a real rate-limit or an
                // empty response from a paid cloud model gets a hard cooldown +
                // key rotation, not just a short soft backoff. Without this, a
                // force-retried candidate that's still genuinely rate-limited
                // gets re-force-retried almost immediately on the next total
                // collapse, defeating the hard-cooldown/key-rotation policy the
                // rest of the router relies on. Capture the result so a key
                // rotation is surfaced to the user, mirroring the main loop's
                // "(key rotated to X)" router-info lines.
                const frResult = recordStreamFailure(bestRef, String(result.reason), result.resetAtMs);
                if (frResult.hardLimited) {
                  const keyMsg = frResult.rotated ? ` (key rotated to ${frResult.newKey})` : '';
                  const reasonTxt = String(result.reason);
                  const labelTxt = reasonTxt === 'rate_limit_exceeded'
                    ? 'rate limit/spend limit reached'
                    : reasonTxt === 'stall_timeout'
                      ? 'stream stalled (likely rate limit)'
                      : 'empty response (likely rate limit)';
                  const resetMsg = result.resetAtMs
                    ? ` (resets ${new Date(result.resetAtMs).toLocaleString()})`
                    : '';
                  pushRouterInfo(proxy, `> [router] ${bestRef} — ${labelTxt}${resetMsg}${keyMsg}\n\n`);
                }
              }
            } catch (streamError) {
              const errorMsg = streamError instanceof Error ? streamError.message : String(streamError);
              pushError(bestRef, errorMsg);
              recordSoftFailure(bestRef);
            } finally {
              // Release the local concurrency slot acquired in tryStream for
              // the force-retry candidate. Same guard as the main loop's finally.
              if (isLocalProvider(bestRef!) && localStreamsInFlight > 0) localStreamsInFlight--;
            }
          }
          // If the force-retry failed, fall through to the normal error-emit
          // below — no worse than the current behaviour.
        }
      }

      // All retries exhausted — push an error event listing every failure so the
      // real cause isn't hidden behind whichever candidate happened to fail last.
      const availableModels = router.allDiscoveredRefs().slice(0, 10).join(', ');
      const modelSuffix = router.allDiscoveredRefs().length > 10 ? '...' : '';
      const hintInfo = label ? `[HINT] ${label}\n` : '';
      // Annotate each failure with the model's recent failure streak, so a
      // persistently broken provider is obvious instead of looking like a
      // one-off glitch.
      const failureList = allErrors.length
        ? allErrors
            .map(({ ref, message }) => {
              const streak = failureStreak(cache, ref);
              return `  - ${ref}: ${message}${streak > 1 ? ` [${streak}× in Folge]` : ''}`;
            })
            .join('\n')
        : '  (no candidates attempted)';
      pushStreamError(
        proxy,
        `[router] All ${candidates.length} candidate(s) failed:\n${failureList}\n${hintInfo}Available: ${availableModels}${modelSuffix}`
      );
    })().catch((err) => {
      // Unhandled error in the async driver — surface it
      pushStreamError(proxy, `[router] Stream error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * Registers discovered model providers with Pi's model registry.
   *
   * RESPONSIBILITY: bridge the router's discovery (cache.available_models +
   * PROVIDER_MAP) into Pi by calling `pi.registerProvider` for each provider
   * the router knows about but Pi doesn't yet. Runs on session_start, after
   * the scan has populated cache.available_models.
   *
   * DESIGN (resolved architecture problems B1, Ü1, B2):
   *
   * B1 — real per-model capabilities, not hardcoded. Each model is
   *   registered with the REAL capabilities the scan captured (in
   *   cache.available_models[].capabilities — see src/capabilities.ts):
   *   Mistral `capabilities.vision/reasoning`/`max_context_length`, OpenRouter
   *   `architecture.input_modalities`/`context_length`, Ollama `/api/show`
   *   `model_info.*.context_length` + capabilities array. Conservative defaults
   *   apply when a field wasn't reported (vision: false unless confirmed —
   *   never claim what we don't know; this prevented the GLM-5-2 422 "Image
   *   input is not enabled" failure). Previously every model got
   *   `reasoning:true, input:['text','image'], contextWindow:200_000` — wrong.
   *
   * Ü1 — never overwrites an existing Pi registration. A provider is only
   *   registered when Pi does NOT know it yet (`modelRegistry.find` returns
   *   nothing for every model of that provider). Protects `models.json`
   *   entries (with `compat` flags), extension providers, and Pi-native
   *   providers from being clobbered. Previously the router silently
   *   overwrote `models.json` entries, destroying user-curated `compat` flags.
   *
   * B2 — optional per-provider model filter. PROVIDER_MAP entries may set
   *   `modelFilter: "<regex>"` to constrain which scanned model ids are kept.
   *   Generic and user-configurable (not a hardcoded special case, per
   *   Leitplanke 1). Applied in the scan, not here.
   *
   * INPUT CONTRACT: `ctx` is Pi's session context (carries modelRegistry).
   * Reads `cfg.providers` (keys), PROVIDER_MAP (baseUrl/api/authKey), and
   * `cache.available_models` (the scan result, including per-model
   * capabilities).
   *
   * OUTPUT CONTRACT: side-effect only — calls `pi.registerProvider`. Returns
   * nothing. Failures are swallowed per-provider (the `catch {}` around each
   * registerProvider call) — a broken provider does not block the others.
   *
   * SIDE EFFECTS: mutates Pi's model registry (registerProvider). Does NOT
   * mutate cfg/cache. The Ollama block (below) registers Ollama with real
   * `num_ctx` from `/api/show` ONLY when Pi doesn't know Ollama — consistent
   * with Ü1 (never overwrites).
   * prior Ollama registration with one carrying providerOptions.num_ctx —
   * intentional (see that block's comment) but inconsistent with Ü1.
   *
   * INVARIANTS:
   *   - Providers in SKIP_REGISTRATION (anthropic/openai/google + any added
   *     at runtime) are never registered by this function.
   *   - Providers without baseUrl+api in PROVIDER_MAP are skipped (Ollama,
   *     lm-studio — they're registered by their own extensions or by the
   *     dedicated Ollama block below).
   *   - A provider with no resolvable API key (neither cfg.keys nor auth.json
   *     authKey) is skipped.
   */
  async function registerGroupModels(ctx: any) {
    // B1/Ü1 fix: previously this registered every discovered provider with
    // hardcoded, same-for-all-models capabilities (reasoning: true,
    // input: ['text','image'], contextWindow: 200_000, maxTokens: 64_000) and
    // SILENTLY OVERWROTE any registration Pi already had (from models.json or
    // another extension) — destroying user-curated compat flags like the
    // mistral-zai/glm-5-2 entry that had supportsStore:false / maxTokensField.
    // That overwrite caused the 422 compaction failures.
    //
    // Now: (Ü1) only register a provider when Pi does NOT know it yet —
    // never overwrite an existing registration (per Leitplanke 3: don't touch
    // Pi's models.json). (B1) use the REAL per-model capabilities the scan
    // captured into cache.available_models.capabilities, with conservative
    // defaults (vision: false, reasoning: false) when the provider didn't
    // report them — so a model is never falsely advertised as vision-capable.

    for (const [provId, def] of Object.entries(PROVIDER_MAP)) {
      if (!def.baseUrl || !def.api) continue;
      if (SKIP_REGISTRATION.has(provId)) continue;
      // Keys can come from router-config.json OR from auth.json (via authKey).
      const keys = cfg.providers?.[provId]?.keys;
      let rawKey: string | undefined;
      let apiKey: string | undefined;
      if (keys?.length) {
        rawKey = keys[activeKeyIdx[provId] ?? 0].key;
        apiKey = resolveKeyValue(rawKey);
        if (!apiKey || (apiKey === rawKey && rawKey.startsWith('__local__'))) continue;
      } else if (def.authKey) {
        apiKey = await sessionCtx?.modelRegistry?.getApiKeyForProvider?.(def.authKey)
          .catch(() => null) ?? undefined;
        if (!apiKey) continue;
      } else {
        continue;
      }

      // Collect this provider's models (with capabilities) from the scan cache.
      const provModels = (cache.available_models ?? [])
        .filter((m) => m.provider === provId);
      if (!provModels.length) continue;

      // Ü1: if Pi already knows ANY of this provider's models, do NOT register.
      // This protects models.json entries (with compat flags) and
      // extension-provided providers from being overwritten. The previous
      // "alreadyRegistered + existingKey" check only protected providers with
      // a resolvable key; it missed models.json entries using env-var
      // placeholder keys. "Pi knows it" is the correct, conservative gate.
      const piKnowsProvider = provModels.some((m) =>
        Boolean(ctx.modelRegistry.find(provId, m.id))
      );
      if (piKnowsProvider) continue;

      try {
        (pi as any).registerProvider(provId, {
          baseUrl: def.baseUrl,
          apiKey,
          api: def.api,
          // B1: use REAL per-model capabilities from the scan, with conservative
          // defaults when the provider didn't report a field. Previously every
          // model got reasoning:true + input:['text','image'] + 200k ctx — which
          // falsely advertised vision on glm-5-2 (causing 422) and a wrong ctx
          // window on every model. Now: vision only when the provider confirms
          // it (default false — never claim what we don't know), reasoning only
          // when confirmed, contextWindow/maxTokens only when reported (Pi's
          // own defaults apply otherwise, which are saner than our old 200k/64k).
          models: provModels.map((m) => {
            const caps = m.capabilities ?? {};
            const input: string[] = caps.vision === true ? ['text', 'image'] : ['text'];
            const entry: Record<string, unknown> = {
              id: m.id,
              name: `${provId}/${m.id}`,
              reasoning: caps.reasoning === true,
              input,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            };
            if (typeof caps.contextWindow === 'number') entry.contextWindow = caps.contextWindow;
            if (typeof caps.maxTokens === 'number') entry.maxTokens = caps.maxTokens;
            return entry;
          }),
        });
      } catch {
        /* provider already registered or config error */
      }
    }

    // Ollama registration. Ollama defaults to num_ctx=32768 when the request
    // omits options.num_ctx; many models support far more (qwen3.5→262K,
    // gemma4→131K), so prompts >32K truncate unless num_ctx is sent.
    //
    // Per Guardrail 3 + Ü1, this must NOT overwrite an existing Ollama
    // registration. If Pi already knows Ollama — from ANY source (another
    // extension, or models.json) — we assume that registration is
    // authoritative. We only register when Pi does NOT know Ollama at all
    // (e.g. a setup where no other extension provides Ollama, or Ollama wasn't
    // running at their session_start). num_ctx comes from the REAL
    // capabilities the scan captured live from Ollama's /api/show (see
    // src/ollama-context.ts + src/capabilities.ts) — no hardcoded table, no
    // dependency on any specific Ollama extension.
    //
    // KNOWN EFFECT: if some OTHER extension registered Ollama WITHOUT
    // num_ctx, the truncation bug returns for that setup. The proper fix is
    // then in that extension (or the user's models.json), not in the router
    // overwriting Pi's registry. The router refuses to paper over another
    // extension's bug by clobbering Pi's registration.
    try {
      const ollamaModels = (cache.available_models ?? [])
        .filter((m) => m.provider === 'ollama');
      if (ollamaModels.length > 0) {
        const piKnowsOllama = ollamaModels.some((m) =>
          Boolean(ctx.modelRegistry.find('ollama', m.id))
        );
        if (!piKnowsOllama) {
          // Pass the full models (with capabilities) so num_ctx comes from
          // the real /api/show values, not a hardcoded table.
          const providerModels = buildOllamaProviderModels(ollamaModels);
          (pi as any).registerProvider('ollama', {
            name: 'Ollama (local)',
            baseUrl: 'http://localhost:11434/v1',
            apiKey: 'ollama',
            api: 'openai-completions',
            models: providerModels,
          });
          routerLog(`[router] Registered Ollama with providerOptions.num_ctx for ${providerModels.length} model(s) (Pi did not know Ollama)`);
        }
      }
    } catch (e) {
      routerLog('[router] Ollama registration failed:', e);
    }

    // Re-register group providers with updated resolution info
    registerGroupProviders();
  }

  // ── Command: /router ───────────────────────────────────────────────────

  pi.registerCommand('router', {
    description: 'Model router status. Usage: /router [group|scan|cost]',
    getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
      // Sub-command + group name completion (TAB-friendly).
      const subcommands: AutocompleteItem[] = [
        { value: 'scan', label: 'scan', description: 'Re-discover models, re-scrape GDPval, regenerate config' },
        { value: 'cost', label: 'cost', description: 'Show accumulated cost-tracker summary' },
      ];
      const groupNames: AutocompleteItem[] = Object.keys(cfg.model_groups ?? {}).map((g) => {
        const desc = cfg.model_groups?.[g]?.description;
        return desc
          ? { value: g, label: g, description: desc }
          : { value: g, label: g };
      });
      const all = [...subcommands, ...groupNames];
      const prefix = argumentPrefix.toLowerCase();
      const filtered = prefix
        ? all.filter((a) => a.value.toLowerCase().startsWith(prefix))
        : all;
      return filtered.length ? filtered : null;
    },
    handler: async (args, ctx) => {
      load();
      const arg = args?.trim();
      
      // Temporarily set session context so allDiscoveredRefs() can access modelRegistry
      // This allows /router command to show models from Pi's registry even outside a session
      const previousSessionCtx = sessionCtx;
      
      try {
        if (ctx.modelRegistry) {
          sessionCtx = ctx;
          router.setSessionCtx(ctx);
        }
        
        if (arg === 'scan') {
          ctx.ui.notify('Scanning...');
          await scan(true);
          ctx.ui.notify(
            `Done. ${Object.keys(metricsModule.getGdpval()).length} scores, ${cache.available_models?.length ?? 0} models.`
          );
          return;
        }

        if (arg === 'cost') {
          // On-demand snapshot via ctx.ui.notify — same channel as the rest of
          // /router's output. Previously cost-tracker.ts printed unconditional
          // console.log/warn on every request and on the daily/exit summary,
          // which bypasses ctx.ui.notify entirely and corrupts the TUI's input
          // prompt rendering. That automatic output is now opt-in only (via
          // DEBUG_COST_TRACKER=true); this command is the supported way to see
          // costs on demand, and formatSummary() does NOT reset metrics, so
          // repeated calls keep showing the same accumulating totals.
          ctx.ui.notify(costTracker.formatSummary(), 'info');
          return;
        }

        if (arg && cfg.model_groups[arg]) {
          const g = cfg.model_groups[arg],
            res = resolve(arg);
          const desc =
            g.method === 'pipeline'
              ? `pipeline(${g.pipeline!.map((s) => `${s.method}:${s.top_k ?? '∞'}`).join('→')})`
              : g.method;
          const lines = [`${arg} | ${desc}`, g.description ?? '', ''];
          if (res) res.candidates.forEach((r, i) => lines.push(fmtModel(r, i, i === 0)));
          else lines.push('(no available models)');
          ctx.ui.notify(lines.filter(Boolean).join('\n'), 'info');
          return;
        }

      // Overview with table
      const lines: string[] = ['Model Router', ''];

      // Group tables with top 5 models (3 available + up to 2 limited)
      for (const [groupName, g] of Object.entries(cfg.model_groups)) {
        const top = getTopModels(groupName, 5);
        const method =
          g.method === 'pipeline'
            ? g.pipeline!.map((s) => `${s.method}${s.top_k ? `:${s.top_k}` : ''}`).join(' → ')
            : g.method === 'best'
              ? 'best gdpval'
              : g.method === 'tiered'
                ? g.min_gdpval != null
                  ? `tiered ≥${g.min_gdpval}`
                  : `tiered ≥${g.min_gdpval_pct ?? 0}%`
                : g.method === 'dynamic'
                  ? 'dynamic (content-based)'
                  : g.method;
        const active = curModel && allDiscoveredRefs().includes(curModel);
        const activeMarker = active ? ' ◀' : '';


        // Add fallback groups info if present
        const fallbackInfo = g.fallback_groups && g.fallback_groups.length > 0 
          ? ` (\u2192 ${g.fallback_groups.join(' \u2192 ')})`
          : '';

        // Group header
        lines.push(`┌─ ${groupName}${activeMarker} `.padEnd(72, '─') + ` ${method}${fallbackInfo} ─`);

        if (top.length === 0 && g.method === 'dynamic') {
          const cats = [
            'code_simple→operational',
            'code_complex→tactical',
            'design→strategic',
            'planning→tactical',
            'exploration→scout',
          ];
          lines.push('│ Routes per prompt via Ollama (gemma2:2b):');
          cats.forEach((c) => lines.push(`│   ${c}`));
        } else if (top.length === 0) {
          lines.push('│ (no models configured)');
        } else {
          // Compute max model name width (capped at 38)
          const MW = Math.min(38, Math.max(5, ...top.map((t) => t.ref.length)));

          // Table header
          lines.push(
            `│ ${'#'.padEnd(3)} ${'Model'.padEnd(MW)}  ${'GDP'.padStart(4)}  ${'Lat'.padStart(5)}  ${'TPS'.padStart(4)}  ${'Cost I/O'.padStart(11)}  ${'Usage 1d/7d/30d'.padStart(15)}  ${'Budg'.padStart(6)}  Status`
          );
          lines.push(
            `│ ${'─'.padEnd(3)} ${'─'.repeat(MW)}  ${'────'}  ${'─────'}  ${'────'}  ${'───────────'}  ${'───────────────'}  ${'──────'}  ──────`
          );

          for (const { ref, limited, rank } of top) {
            const m = getM(ref);
            const prov = ref.split('/')[0];
            const mux = costMux(prov);
            const cost = effCost(ref);
            const price = lookupPrice(ref);
            const modelShort = ref.length > MW ? '…' + ref.slice(-(MW - 1)) : ref;
            const isActive = curModel === ref;
            const statusParts: string[] = [];
            if (limited) statusParts.push(`⛔${limitSecs(ref)}s`);
            if (mux > 1) statusParts.push(`×${mux}`);
            if (isActive) statusParts.push('●');
            const status = statusParts.join(' ') || (limited ? '' : 'active');

            const costDisplay = price && price.input !== 'unknown' && price.output !== 'unknown'
              ? `$${typeof price.input === 'number' ? price.input.toFixed(1) : '?'}/$${typeof price.output === 'number' ? price.output.toFixed(1) : '?'}`
              : cost !== 'unknown' && typeof cost === 'number'
                ? `$${cost.toFixed(1)}`
                : 'unknown';

            // Add budget info for subscription providers
            const budgetInfo = cache.budget_cache?.[prov];
            let budgetDisplay = '';
            if (budgetInfo && budgetInfo.window_reset && budgetInfo.remaining_tokens !== undefined) {
              const now = Date.now();
              if (now < budgetInfo.window_reset) {
                const remaining = budgetInfo.remaining_tokens;
                const windowType = budgetInfo.window_type ?? 'monthly';
                budgetDisplay = `${Math.round(remaining)}${windowType.substring(0, 1)}`;
              }
            }

            const u1 = getUsage(ref, 1),
              u7 = getUsage(ref, 7),
              u30 = getUsage(ref, 30);
            const usageDisplay = `${fmt(u1)}/${fmt(u7)}/${fmt(u30)}`;

            const sel = rank === 0 ? ' ←' : '';
            lines.push(
              `│ ${String(rank + 1).padEnd(3)} ${modelShort.padEnd(MW)}  ${String(m.gdpval).padStart(4)}  ${String(Math.round(m.avg_latency_ms)).padStart(5)}  ${String(Math.round(m.throughput_tps)).padStart(4)}  ${costDisplay.padStart(11)}  ${usageDisplay.padStart(15)}  ${budgetDisplay.padStart(6)} ${status}${sel}`
            );
          }
        }
        lines.push('│');
      }

      // Rate-limited summary
      const rl = [...rateLimitManager.getLimits().keys()].filter((r) => isLimited(r));
      if (rl.length) {
        lines.push('├─ Rate Limited '.padEnd(72, '─'));
        for (const r of rl) {
          const { provider, modelId } = splitRef(r);
          lines.push(`│ ⛔ ${provider}/${modelId} (${limitSecs(r)}s remaining)`);
        }
      }

      lines.push('└' + '─'.repeat(71));
      lines.push('', '/router <group> | scan | cost');
      ctx.ui.notify(lines.join('\n'), 'info');
      } finally {
        // Always restore previous session context
        sessionCtx = previousSessionCtx;
        router.setSessionCtx(previousSessionCtx);
      }
    },
  });

  pi.on('session_shutdown', () => {
    sessionCtx = null;
    router.setSessionCtx(null);
  });

  // Cleanup CostTracker on process exit
  process.on('exit', () => costTracker.destroy());
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));

  // Export groupStream for testing
  (defaultExport as any).groupStream = groupStream;
};

export default defaultExport;
