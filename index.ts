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
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import type { Config, Cache, Metrics, Defaults } from './src/types.ts';
import { PROVIDER_MAP, SKIP_REGISTRATION } from './src/providers.ts';
import { splitRef, stripDateSuffix, resolveShortModelName, baseTokens } from './src/utils.ts';
import { isRefUsable, rankHintCandidates } from './src/hint-resolution.ts';
import { RateLimitManager } from './src/rate-limit.ts';
import { DiscoveryManager } from './src/discovery.ts';
import * as metricsModule from './src/metrics.ts';
import { lookupGdp } from './src/metrics.ts';
import { CacheManager } from './src/cache.ts';
import { matchModelsWithLLMBatched, isPlausibleMatch, type GdpvalEntry } from './src/model-matcher.ts';
import { callLocalLlm, type LocalLlmDeps } from './src/local-llm.ts';
import { isExcluded, type ExcludeContext } from './src/exclude.ts';
import { loadLayeredConfig } from './src/config-loader.ts';
import { Router } from './src/routing.ts';
import { classifyPrompt, detectHintDirectly, getGroupForCategory, ClassificationResult } from './src/content-classifier.ts';
import { SessionEscalation } from './src/escalation.ts';
import { costTracker } from './src/cost-tracker.ts';
import { BudgetTracker, initBudgetTracker } from './src/budget-tracker.ts';

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
const GDPVAL_URL = _defaults.gdpval_url;

// ── Extension ──────────────────────────────────────────────────────────────

const HOME_LOG_PATH = path.join(homedir(), '.pi', 'logs', 'router.log');
// Project-local log path, mirrored under the current project's .pi/logs/ directory
// (same convention the claude-bridge extension uses) so logs live alongside the
// project instead of only in the global home directory.
let projectLogPath: string | null = null;
function setProjectLogDir(cwd: string | undefined): void {
  projectLogPath = cwd ? path.join(cwd, '.pi', 'logs', 'router.log') : null;
}
const ensuredDirs = new Set<string>();
function ensureLogDirFor(logPath: string): void {
  const dir = path.dirname(logPath);
  if (ensuredDirs.has(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
  ensuredDirs.add(dir);
}
function writeLogLine(line: string): void {
  try {
    ensureLogDirFor(HOME_LOG_PATH);
    fs.appendFileSync(HOME_LOG_PATH, line + '\n');
  } catch {}
  if (projectLogPath) {
    try {
      ensureLogDirFor(projectLogPath);
      fs.appendFileSync(projectLogPath, line + '\n');
    } catch {}
  }
}
function routerLog(msg: string, extra?: unknown): void {
  const suffix = extra ? ` ${extra instanceof Error ? (extra.stack ?? extra.message) : String(extra)}` : '';
  writeLogLine(`${new Date().toISOString()}  ${msg}${suffix}`);
}
function appendRawLog(line: string): void {
  writeLogLine(line);
}

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
  let budgetTracker: BudgetTracker;
  // gdpval/modelMap/lookupGdp state lives in metrics.ts (single source of truth).
  let scanning = false;
  let sessionStart = Date.now();
  let turnStart = 0;
  let curModel = '';
  let activeGroup: string | null = null;
  let lastDynamicModel = '';
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
        // Prüfe ob die dynamische Konfiguration gültig ist (hat _dynamic Metadaten)
        if (dynamicCfg._dynamic && dynamicCfg.model_groups) {
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
    // Falls dynamische Konfiguration geladen wurde und eigene gdpval_builtin hat,
    // füge sie hinzu (NACH setConfig/setCache, damit sie nicht überschrieben werden)
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
    budgetTracker = initBudgetTracker(cfg, cache);
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
    if (budgetTracker) {
      budgetTracker.updateCache(cache);
    }
  }

  function saveCache() {
    // Update cache with latest budget info before saving
    if (budgetTracker) {
      cache = budgetTracker.getCache();
    }
    cacheManager.saveCache(cache);
  }

  // ── Key Discovery ───────────────────────────────────────────────────────

  async function discoverKeys() {
    await discoveryManager.discoverKeys();
    cache = discoveryManager.getCache();
    metricsModule.setCache(cache);
    rateLimitManager.updateCache(cache);
  }

  // ── Budget Tracking ─────────────────────────────────────────────────────

  /**
   * Refresh budget info for all subscription providers
   */
  async function refreshBudgets() {
    if (!budgetTracker) return;
    
    const subscriptionProviders = Object.entries(cfg.providers ?? {})
      .filter(([prov, config]) => config.billing === 'subscription')
      .map(([prov]) => prov);
    
    // Refresh budget for each subscription provider
    for (const prov of subscriptionProviders) {
      try {
        await budgetTracker.refreshBudget(prov);
        routerLog(`[budget] Refreshed budget for ${prov}`);
      } catch (error) {
        routerLog(`[budget] Error refreshing budget for ${prov}:`, error);
      }
    }
    
    // Update cache with new budget info
    cache = budgetTracker.getCache();
    saveCache();
  }

  /**
   * Check if a model has available budget (synchronous, uses cache)
   */
  function hasModelBudget(ref: string): boolean {
    if (!budgetTracker) return true;
    
    const prov = ref.split('/')[0];
    const billing = cfg.providers?.[prov]?.billing ?? PROVIDER_MAP[prov]?.billing ?? 'pay_per_token';
    
    // Local and pay-per-token providers always have budget
    if (PROVIDER_MAP[prov]?.local || billing === 'pay_per_token') {
      return true;
    }
    
    // Check cached budget
    const budget = cache.budget_cache?.[prov];
    if (!budget) {
      // No cached info - assume available
      return true;
    }
    
    // Check if window has reset
    const now = Date.now();
    if (budget.window_reset && now >= budget.window_reset) {
      // Window reset - need to refresh
      return true; // Assume available until we can refresh
    }
    
    return (budget.remaining_tokens ?? 0) > 0;
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
    opts?: { headers?: Record<string, string>; timeoutMs?: number }
  ): Promise<any> {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'pi-model-dynamic-router/1.0', ...opts?.headers },
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 20_000),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

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
          for (const m of d.models ?? []) {
            const id = m.name;
            if (!id) continue;
            const existing = models.find((x) => x.provider === 'ollama' && x.id === id);
            if (!existing) models.push({ id, provider: 'ollama', cost_per_m: 0 });
          }
        } catch {}
        // Scan direct API providers with modelsUrl (anthropic, openai, etc.)
        const providerScans = Object.entries(PROVIDER_MAP)
          .filter(([, def]) => def.modelsUrl && def.authHeader)
          .map(async ([provId, def]) => {
            const keys = cfg.providers?.[provId]?.keys;
            if (!keys?.length) return;
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
                  const existing = models.find((x) => x.provider === provId && x.id === id);
                  if (!existing) models.push({ id, provider: provId, cost_per_m: 0 });
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
   * Generiert eine dynamische Router-Konfiguration basierend auf den gescanten Modellen
   * und den Einstellungen aus router-config.json
   * 
   * KORRIGIERT: Behebt das Problem, dass kostenlose Modelle (free_models) nicht in die
   * dynamische Konfiguration aufgenommen wurden, was dazu führte, dass immer das gleiche
   * Modell (Qwen3-32B-TEE) verwendet wurde.
   */
  async function generateDynamicConfig(force = false): Promise<void> {
    try {
      // Modelle, die Pi bereits registriert hat (z.B. über Provider ohne PROVIDER_MAP-Eintrag
      // wie claude-bridge) — damit sie trotzdem als Routing-Kandidaten in Frage kommen.
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
      
      // 1. Alle verfügbaren Modelle holen (aus Cache)
      const scannedModels = cache.available_models ?? [];
      
      // 2. STATISCHE free_models aus der Konfiguration laden (wichtig für kostenlose Modelle!)
      // Diese Modelle werden NICHT gescannt, sondern direkt aus router-config.json genommen
      const staticFreeModels: string[] = [];
      const staticFreeModelsLookup = new Set<string>();
      for (const [provId, provConfig] of Object.entries(staticCfg.providers ?? {})) {
        if (provConfig.free_models && Array.isArray(provConfig.free_models)) {
          for (const freeModel of provConfig.free_models) {
            // Normalisiere den Modell-Ref (Provider/Modell-Id)
            const normalizedModel = freeModel.startsWith(`${provId}/`) ? freeModel : `${provId}/${freeModel}`;
            staticFreeModels.push(normalizedModel);
            staticFreeModelsLookup.add(normalizedModel);
            // Füge auch die non-prefixed Version hinzu, falls vorhanden
            if (normalizedModel.includes('/')) {
              const nonPrefixed = normalizedModel.split('/').slice(1).join('/');
              staticFreeModelsLookup.add(nonPrefixed);
            }
          }
        }
      }
      
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

      // 2c. Globale Ausschluss-Regeln anwenden (personalisierte Support-Liste).
      // Schließt Provider, Modell-Muster und bezahlte Modelle bestimmter
      // Provider aus — auf ALLE Gruppen wirkend, vor dem Scoring.
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

      // Registriere einen leichtgewichtigen Provider-Stub für jeden registry-entdeckten
      // Provider, den der Router sonst nicht kennt (z.B. claude-bridge). Ohne diesen Eintrag
      // erkennt stripProvider() das Prefix nicht und GDPval/Preis-Inferenz über den
      // Basis-Modellnamen (z.B. "claude-sonnet-5") schlägt fehl.
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

      const modelsWithMetadata = effectiveModelRefs.map(ref => {
        const gdpval = lookupGdp(ref) ?? 0;
        const cost = effCost(ref);
        const price = lookupPrice(ref);
        
        // Prüfe ob ein Modell token-basiert ist (pay_per_token)
        const prov = ref.split('/')[0];
        const isTokenBased = (cfg.providers?.[prov]?.billing ?? PROVIDER_MAP[prov]?.billing) === 'pay_per_token';
        
        // Prüfe ob es ein kostenloses Modell ist (NUR für token-basierte Modelle!)
        // Subscription-Modelle sind NICHT "kostenlos" im Sinne von Cost-Routing
        const isFreeModel = staticFreeModelsLookup.has(ref) ||
                          (price && price.input === 0 && price.output === 0) ||
                          ref.includes(':free') ||
                          (cost === 0 && isTokenBased);
        
        return { ref, gdpval, cost, price, isFreeModel };
      }).filter(m => {
        // Always keep static models (they're explicitly configured in router-config.json)
        if (staticModelRefs.has(m.ref)) return true;
        // For other models, require GDPval > 0
        return m.gdpval > 0;
      });
      
      if (!modelsWithMetadata.length) {
        routerLog('[router] No models with GDPval scores, skipping dynamic config generation');
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
        let filteredModels = [...modelsWithMetadata];
        
        // GDPval Filter
        if (groupConfig.min_gdpval !== undefined) {
          filteredModels = filteredModels.filter(m => m.gdpval >= groupConfig.min_gdpval!);
        }
        
        // Kosten Filter (max_cost_per_m) - KORRIGIERT: Berücksichtige auch free_models
        if (groupConfig.max_cost_per_m !== undefined) {
          filteredModels = filteredModels.filter(m => {
            const prov = m.ref.split('/')[0];
            const isTokenBased = (cfg.providers?.[prov]?.billing ?? PROVIDER_MAP[prov]?.billing) === 'pay_per_token';
            
            // Kostenlose token-basierte Modelle immer erlauben
            if (m.isFreeModel && isTokenBased) return true;
            
            // Subscription-Modelle: Immer durchlassen (werden nach GDPval sortiert, nicht nach Kosten)
            if (!isTokenBased) return true;
            
            const price = m.price;
            // Exclude models with unknown prices
            if (!price || price.input === 'unknown' || price.output === 'unknown') return false;
            // Only include if input price is a number and within limit
            if (typeof price.input !== 'number') return false;
            return price.input <= groupConfig.max_cost_per_m!;
          });
        }
        
        // Kosten Filter (max_cost) - KORRIGIERT: Berücksichtige auch free_models
        // WICHTIG: Für max_cost=0 Gruppen (trivial, simple) NUR token-basierte kostenlose Modelle zulassen
        // Subscription-Modelle sind NICHT kostenlos im Sinne von Cost-Routing
        if (groupConfig.max_cost !== undefined) {
          filteredModels = filteredModels.filter(m => {
            const prov = m.ref.split('/')[0];
            const isTokenBased = (cfg.providers?.[prov]?.billing ?? PROVIDER_MAP[prov]?.billing) === 'pay_per_token';
            
            // Für max_cost=0: NUR token-basierte kostenlose Modelle
            if (groupConfig.max_cost === 0) {
              return m.isFreeModel && isTokenBased;
            }
            
            // Für andere max_cost Werte: Kostenlose Modelle immer erlauben
            if (m.isFreeModel) return true;
            
            // Exclude models with unknown costs
            if (m.cost === 'unknown') return false;
            return m.cost <= groupConfig.max_cost!;
          });
        }
        
        // 7. Sortierung basierend auf Gruppen-Methode
        let sortedGroupModels = [...filteredModels];
        
        if (groupConfig.method === 'best' || groupConfig.method === 'max_gdpval') {
          // Verwende Multi-Metrik-Scoring für 'best'-Methode
          sortedGroupModels.sort((a, b) => {
            const scoreB = metricsModule.calculateScore(b.ref, groupName, cfg);
            const scoreA = metricsModule.calculateScore(a.ref, groupName, cfg);
            return scoreB - scoreA;
          });
        } else if (groupConfig.method === 'min_cost') {
          // KORRIGIERT: Kostenlose Modelle zuerst, dann nach Kosten sortieren
          sortedGroupModels.sort((a, b) => {
            // Kostenlose Modelle haben Priorität
            if (a.isFreeModel && !b.isFreeModel) return -1;
            if (!a.isFreeModel && b.isFreeModel) return 1;
            
            // Dann nach Kosten (handle 'unknown' costs)
            const costA = a.cost;
            const costB = b.cost;
            if (costA === 'unknown' && costB === 'unknown') {
              // Bei gleichen unbekannten Kosten: Verwende Multi-Metrik-Score
              const scoreB = metricsModule.calculateScore(b.ref, groupName, cfg);
              const scoreA = metricsModule.calculateScore(a.ref, groupName, cfg);
              return scoreB - scoreA;
            }
            if (costA === 'unknown') return 1; // unknown costs go to the end
            if (costB === 'unknown') return -1;
            if (costA !== costB) return costA - costB;
            
            // Bei gleichen Kosten: Verwende Multi-Metrik-Score
            const scoreB = metricsModule.calculateScore(b.ref, groupName, cfg);
            const scoreA = metricsModule.calculateScore(a.ref, groupName, cfg);
            return scoreB - scoreA;
          });
        } else if (groupConfig.method === 'tiered') {
          // Quality-gated + Multi-Metrik-Scoring
          sortedGroupModels.sort((a, b) => {
            // Erst nach GDPval (Quality Gate)
            if (b.gdpval !== a.gdpval) return b.gdpval - a.gdpval;
            
            // Kostenlose Modelle haben Vorrang bei gleichem GDPval
            if (a.isFreeModel && !b.isFreeModel) return -1;
            if (!a.isFreeModel && b.isFreeModel) return 1;
            
            // Dann nach Multi-Metrik-Score
            const scoreB = metricsModule.calculateScore(b.ref, groupName, cfg);
            const scoreA = metricsModule.calculateScore(a.ref, groupName, cfg);
            if (scoreB !== scoreA) return scoreB - scoreA;
            
            // Dann nach Kosten (handle 'unknown' costs)
            const costA = a.cost;
            const costB = b.cost;
            if (costA === 'unknown' && costB === 'unknown') return 0;
            if (costA === 'unknown') return 1; // unknown costs go to the end
            if (costB === 'unknown') return -1;
            return costA - costB;
          });
        }
        
        // 8. Collect models: static first (highest priority), then dynamic additions
        const modelsToInclude = new Set<string>();

        // Token-signature set for deduplication: same base model = same signature
        // (e.g. "mistral/mistral-medium-3.5" and "mistral/mistral-medium-3-5" share tokens {3,5,medium,mistral})
        const includedSigs = new Set<string>();
        const modelSig = (ref: string) => [...baseTokens(ref)].sort().join('|');

        // 1. Static models from router-config.json — always preserved as-is
        const originalModels = groupConfig.models ?? [];
        for (const origModel of originalModels) {
          // Keep ref exactly as configured — no openrouter/ prefix injection
          const origGdpval = lookupGdp(origModel);

          // Explicit model-map exclusion (mapped to null) — honour it
          if (origGdpval === null) continue;

          // Apply min_gdpval filter (only if GDPval is known and defined)
          if (groupConfig.min_gdpval !== undefined && origGdpval !== undefined && origGdpval !== null && origGdpval < groupConfig.min_gdpval) {
            continue;
          }

          // Match against staticFreeModelsLookup (holds both prefixed and bare forms)
          const isFree = staticFreeModelsLookup.has(origModel);
          const origProv = origModel.split('/')[0];
          const isTokenBased = (cfg.providers?.[origProv]?.billing ?? PROVIDER_MAP[origProv]?.billing) === 'pay_per_token';
          
          // max_cost_per_m filter (skip for non-token-based or non-free models)
          if (groupConfig.max_cost_per_m !== undefined) {
            // Token-basierte kostenlose Modelle immer erlauben
            if (isFree && isTokenBased) {
              // ok
            } else if (!isTokenBased) {
              // Subscription-Modelle immer durchlassen
            } else {
              // Token-basierte bezahlte Modelle: Preis prüfen
              const price = lookupPrice(origModel);
              if (price) {
                // Skip if price contains unknown values
                if (price.input === 'unknown' || price.output === 'unknown') continue;
                if (typeof price.input === 'number' && price.input > groupConfig.max_cost_per_m) continue;
              }
            }
          }
          // max_cost filter (skip for non-token-based or non-free models)
          if (groupConfig.max_cost !== undefined) {
            // Für max_cost=0: NUR token-basierte kostenlose Modelle
            if (groupConfig.max_cost === 0) {
              if (!(isFree && isTokenBased)) continue;
            } else {
              // Für andere max_cost Werte
              if (isFree && isTokenBased) {
                // ok
              } else if (!isTokenBased) {
                // Subscription-Modelle immer durchlassen
              } else {
                const cost = effCost(origModel);
                // Skip if cost is unknown or exceeds max
                if (cost === 'unknown' || (typeof cost === 'number' && cost > groupConfig.max_cost)) continue;
              }
            }
          }

          modelsToInclude.add(origModel);
          includedSigs.add(modelSig(origModel));
        }

        // 2. Add filtered dynamic models — deduplicate by token signature
        for (const model of sortedGroupModels) {
          if (modelsToInclude.has(model.ref)) continue;
          const sig = modelSig(model.ref);
          if (includedSigs.has(sig)) continue; // same base model already present
          modelsToInclude.add(model.ref);
          includedSigs.add(sig);
        }
        
        // 3. Konvertiere zu Array (Reihenfolge: statisch zuerst, dann dynamisch sortiert)
        const finalModels = Array.from(modelsToInclude);
        
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
      const qualityOf = (g: typeof dynamicGroups[string]): number => {
        if (g.method === 'dynamic') return -1;
        if (g.max_cost === 0) return 0;
        if (g.min_gdpval !== undefined) return g.min_gdpval;
        return 750;
      };
      // With dynamic model discovery, all non-dynamic groups are eligible
      const eligibleGroups = Object.entries(dynamicGroups)
        .filter(([, g]) => g.method !== 'dynamic')
        .sort(([, a], [, b]) => qualityOf(a) - qualityOf(b));

      for (const [myIdx, [name]] of eligibleGroups.entries()) {
        const above = eligibleGroups.slice(myIdx + 1).map(([n]) => n);
        const below = eligibleGroups.slice(0, myIdx).reverse().map(([n]) => n);
        dynamicGroups[name].fallback_groups = [...above, ...below];
      }

      // 10. Dynamische Konfiguration speichern
      const dynamicConfig = {
        ...cfg,
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

  function recordLimit(ref: string): { rotated: boolean; newKey?: string } {
    return rateLimitManager.recordLimit(ref, cfg.providers ?? {});
  }

  function recordOk(ref: string) {
    rateLimitManager.recordOk(ref);
  }

  function clearLimit(ref: string): void {
    rateLimitManager.clearLimit(ref);
  }

  /** Record a soft failure (empty response, timeout) — lighter backoff than 429 */
  function recordSoftFailure(ref: string): void {
    rateLimitManager.recordSoftFailure(ref);
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
    const billing =
      cfg.providers?.[prov]?.billing === 'subscription'
        ? 'sub'
        : m.cost_per_m === 0
          ? 'free'
          : 'ppt';
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
    for (const [groupName] of Object.entries(cfg.model_groups)) {
      const res = resolve(groupName);
      const resolvedRef = res?.selected ?? 'none';
      const resolvedMetrics = res ? getM(resolvedRef) : null;

      (pi as any).registerProvider(groupName, {
        baseUrl: 'https://router.local', // not used — streamSimple overrides
        apiKey: 'router-virtual', // not used — streamSimple overrides
        api: `router-group-${groupName}`, // unique per group to avoid overwriting global API providers
        streamSimple: groupStream,
        models: [
          {
            id: groupName,
            name: `${groupName} → ${resolvedRef}`,
            reasoning: true,
            input: ['text', 'image'] as any,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: resolvedMetrics ? 200_000 : 128_000,
            maxTokens: 64_000,
          },
          ...(cfg.model_groups[groupName]?.method === 'dynamic' ? [{
            id: `${groupName}:use-static`,
            name: `${groupName} → ${resolvedRef} (static fallback)`,
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
    
    // Refresh budgets initially and then every 5 minutes
    refreshBudgets().catch(() => {});
    const budgetRefreshInterval = setInterval(() => {
      refreshBudgets().catch(() => {});
    }, 5 * 60 * 1000); // 5 minutes
    
    // Store interval in session context for cleanup
    if (!sessionCtx) {
      sessionCtx = {};
    }
    if (!sessionCtx._budgetRefreshIntervals) {
      sessionCtx._budgetRefreshIntervals = [];
    }
    sessionCtx._budgetRefreshIntervals.push(budgetRefreshInterval);

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
  async function tryStream(
    ref: string,
    context: Context,
    options: SimpleStreamOptions | undefined
  ): Promise<{ stream: AssistantMessageEventStream; ref: string } | null> {
    if (!sessionCtx) return null;
    const { provider, modelId } = splitRef(ref);
    // Skip group virtual models to prevent recursion
    if (cfg.model_groups[provider]) return null;
    const realModel = sessionCtx.modelRegistry.find(provider, modelId);
    if (!realModel) return null;
    if (cfg.model_groups[realModel.provider]) return null;
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
    if (routerManaged && !apiKey && !isLocal) return null;
    // Strip the group's virtual apiKey from options — it must not reach the real provider
    const { apiKey: _drop, ...baseOpts } = options ?? {};
    const streamOpts = apiKey ? { ...baseOpts, apiKey } : baseOpts;
    const stream = hostStreamSimple(realModel, context, streamOpts);
    if (!stream) {
      throw new Error(
        `No stream handler available for "${ref}" (provider=${realModel.provider}, api=${realModel.api})`
      );
    }
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
    timeoutMs: number
  ): Promise<{ ok: boolean; reason?: string }> {
    let hadContent = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;

    // Start a timeout that fires if we never see content
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve('timeout');
      }, timeoutMs);
    });

    // Patterns that indicate a rate-limit / spend-limit / subscription error.
    // These can arrive as error events OR as text_delta content (claude-bridge
    // pushes rate-limit warnings as text via piUI.notify, and some error
    // results with non-success subtype fall through without an error event).
    const RATE_LIMIT_PATTERNS = [
      'rate limit',
      'spend limit',
      'usage credits',
      'out of',
      'limit hit',
      'claude code returned an error',
      'monthly spend',
      'five_hour',
      'five hour',
      'quota',
      'credits',
      'exceeded',
      'overloaded',
      'rate_limit',
    ];
    const isRateLimitText = (text: string): boolean => {
      const lower = text.toLowerCase();
      return RATE_LIMIT_PATTERNS.some((p) => lower.includes(p));
    };

    // Race: iterate the stream vs timeout
    let rateLimited = false;
    let accumulatedText = ''; // Accumulate text_delta to check for rate-limit text
    const iterPromise = (async (): Promise<'done'> => {
      try {
        for await (const event of upstream) {
          // Cancel timeout on first real content
          if (!hadContent) {
            const t = event.type;
            if (
              t === 'text_delta' ||
              t === 'thinking_delta' ||
              t === 'toolcall_start' ||
              t === 'toolcall_delta'
            ) {
              hadContent = true;
              if (timer) {
                clearTimeout(timer);
                timer = null;
              }
            }
          }
          if (event.type === 'error') {
            if (timer) {
              clearTimeout(timer);
              timer = null;
            }
            // Check if this is a rate limit or subscription error from claude-bridge
            const errorMsg = String((event as any).error?.message || (event as any).error || '');
            if (isRateLimitText(errorMsg)) {
              rateLimited = true;
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
              if (timer) {
                clearTimeout(timer);
                timer = null;
              }
              // Stop consuming — don't forward rate-limit text to the user
              return 'done';
            }
          }
          proxy.push(event);
        }
      } catch (err) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        // Stream threw — treat as soft failure
        return 'done';
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return 'done';
    })();

    const winner = await Promise.race([iterPromise, timeoutPromise]);

    if (winner === 'timeout' && !hadContent) {
      // No content within timeout — soft failure
      return { ok: false, reason: 'empty_timeout' };
    }

    // Stream completed — check if we actually got content or hit a rate limit
    if (rateLimited) {
      // Rate limit or subscription error — soft failure, try next model
      return { ok: false, reason: 'rate_limit_exceeded' };
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
      const content = typeof msg.content === 'string' ? msg.content : '';
      total += Math.ceil(content.length / 4); // Rough estimate: 4 chars ≈ 1 token
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
    // Extrahiere die letzte Assistenz-Antwort (kompakt für schnelle Klassifizierung)
    // Max. 150 Zeichen (matcht die Begrenzung in classifyPrompt)
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
      
      // Cost Tracking für statisches Routing
      costTracker.trackRequest(res.selected, 1000, 500);
      
      driveStream(proxy, candidates, context, options);
      return proxy;
    }

    // Dynamic group: classify the prompt first, then stream from the resolved group
    const proxy = createAssistantMessageEventStream();
    (async () => {
      let candidates: string[];
      let dynamicLabel: string | undefined;
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
          const res =
            resolve('fallback') ??
            resolve(
              Object.keys(cfg.model_groups).find((k) => cfg.model_groups[k].method !== 'dynamic')!
            );
          if (!res) throw new Error('No fallback model for tool follow-up');
          // Prefer the exact model used in the previous turn
          candidates = [lastDynamicModel, ...res.candidates.filter((r) => r !== lastDynamicModel)];
          await driveStream(proxy, candidates, context, options);
          return;
        }

        const lastAssistantSnippet = extractLastAssistantSnippet(context);
        
        const dynamicGroupCfg = cfg.model_groups['dynamic'];
        // Strip "ollama/" prefix — callOllama expects the bare model name
        const stripOllama = (ref: string) => ref.replace(/^ollama\//, '');
        const classifyOpts: Parameters<typeof classifyPrompt>[1] = {
          allowStaticFallback: useStatic,
          allowCloudFallback: true,
          cfg,
          cache,
          context: {
            lastAssistantSnippet,
            lastModel: lastDynamicModel || undefined,
            isCompaction: isCompactionTurn(context),  // Pass context for detection
          },
        };
        if (dynamicGroupCfg?.classifier_model)
          classifyOpts.model = stripOllama(dynamicGroupCfg.classifier_model);
        if (dynamicGroupCfg?.classifier_fallback)
          classifyOpts.fallbackModel = stripOllama(dynamicGroupCfg.classifier_fallback);

        const classification = await classifyPrompt(prompt, classifyOpts);
        
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

              // Cost Tracking für HINT-Override
              costTracker.trackRequest(res.selected, 1000, 500);
              await driveStream(proxy, candidates, context, options, dynamicLabel);
              return;
            }
            routerLog(`[dynamic] HINT group not found: ${classification.hintTarget}`);
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

            // The user explicitly requested this model via HINT — a stale cooldown from
            // an earlier, unrelated failure must not silently block this deliberate override.
            candidates.forEach(ref => clearLimit(ref));
            
            // Append fallback models from what's actually registered in Pi (no invented
            // provider prefixes — only real refs from the session's model registry).
            // HINT overrides are user-driven: clear any stale cooldowns on fallbacks too,
            // so a previous cascade failure does not silently prevent the HINT from working.
            if (sessionCtx?.modelRegistry) {
              const availableModels = sessionCtx.modelRegistry.getAvailable().map((m: any) => `${m.provider}/${m.id}` as string);
              
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
                // Clear cooldowns for all fallback candidates as well
                fallbackCandidates.forEach(fb => clearLimit(fb));
              }
            }
            
            lastDynamicModel = resolvedTarget;
            dynamicLabel = `HINT: ${classification.hintTarget}`;
            const logLine = `${new Date().toISOString()}  ${dynamicLabel}  ${resolvedTarget}  "${prompt.slice(0, 80).replace(/\n/g, ' ')}"`;
            appendRawLog(logLine);
            costTracker.trackRequest(resolvedTarget, 1000, 500);
            await driveStream(proxy, candidates, context, options, dynamicLabel);
            return;
          }
        }
        
        // For normal classification (not HINT), get the group with cost tier
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
        const res = resolve(targetGroup) ?? resolve('fallback');
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
        const fb =
          resolve('fallback') ??
          resolve(
            Object.keys(cfg.model_groups).find((k) => cfg.model_groups[k].method !== 'dynamic')!
          );
        if (!fb) {
          proxy.push({
            type: 'error',
            reason: 'error',
            error: {
              role: 'assistant',
              content: [{ type: 'text', text: `[router] Dynamic routing failed: ${err}` }],
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: 'error',
              timestamp: Date.now(),
            } as AssistantMessage,
          } as AssistantMessageEvent);
          return;
        }
        candidates = [...fb.candidates];
      }
      await driveStream(proxy, candidates, context, options, dynamicLabel);
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
  function pushRouterInfo(proxy: AssistantMessageEventStream, text: string, contentIndex: number = 0): void {
    const partial: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'end_turn',
      timestamp: Date.now(),
    } as unknown as AssistantMessage;
    proxy.push({ type: 'text_start', contentIndex, partial } as any);
    proxy.push({ type: 'text_delta', contentIndex, delta: text, partial } as any);
    proxy.push({ type: 'text_end', contentIndex, content: text, partial } as any);
  }

  // Rate-limit error detection for fallback logic.
  // Only treat REAL rate-limit errors as triggering fallback.
  // empty_response/empty_timeout are NOT included here because they can
  // be transient overloads (especially for free models) — triggering a
  // fallback cascade on every empty response would exhaust all tiers
  // when a simple retry would suffice.
  function isRateLimitError(errorMsg: string): boolean {
    const lower = errorMsg.toLowerCase();
    return lower.includes('rate limit') ||
           lower.includes('usage credits') ||
           lower.includes('spend limit') ||
           lower.includes('quota') ||
           lower.includes('limit hit') ||
           lower.includes('rate_limit_exceeded') ||
           lower.includes('overloaded');
  }

  // Fallback group priority: try lower tiers when rate-limited
  const FALLBACK_GROUP_ORDER: string[] = [
    'strategic', 'complex', 'operational', 'tactical', 'simple', 'trivial', 'scout', 'fallback'
  ];

  function getFallbackGroup(currentGroup: string): string | null {
    // Prefer the group's configured fallback_groups (from router-config.json).
    // This allows per-group fallback chains like trivial → [scout, operational, fallback].
    const g = cfg.model_groups[currentGroup];
    if (g?.fallback_groups?.length) {
      for (const fb of g.fallback_groups) {
        if (cfg.model_groups[fb]) return fb;
      }
      // If no configured fallback groups exist in config, fall through to
      // the global order below.
    }
    // Fallback: use the global FALLBACK_GROUP_ORDER for groups without
    // explicit fallback_groups, or if none of the configured ones exist.
    const idx = FALLBACK_GROUP_ORDER.indexOf(currentGroup);
    if (idx === -1) return null;
    for (let i = idx + 1; i < FALLBACK_GROUP_ORDER.length; i++) {
      const group = FALLBACK_GROUP_ORDER[i];
      if (cfg.model_groups[group]) {
        return group;
      }
    }
    return null;
  }

  function driveStream(
    proxy: AssistantMessageEventStream,
    candidates: string[],
    context: Context,
    options: SimpleStreamOptions | undefined,
    label?: string
  ): Promise<void> {
    return (async () => {
      // Preserve the active group (e.g., 'dynamic') for display purposes
      if (activeGroup) {
        router.setActiveGroup(activeGroup);
      }
      let lastError: string | undefined;
      // Track every failure, not just the last one, so the final error message doesn't
      // hide earlier (possibly more relevant) failures behind a random last candidate.
      const allErrors: string[] = [];

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
          allErrors.push(`${ref}: skipped, still in cooldown (${router.limitSecs(ref)}s remaining)`);
          continue;
        }
        // Context-window guard: skip models whose context window is smaller than
        // the current conversation. This prevents timeout/failure when compacting
        // large conversations with small-context models (e.g. gemma4:12b @ 8K).
        const ctxWindow = getModelContextWindow(ref);
        if (ctxWindow && contextTokens > ctxWindow) {
          allErrors.push(`${ref}: skipped, context window ${ctxWindow} < ${contextTokens} tokens needed`);
          continue;
        }
        const target = await tryStream(ref, context, options).catch((err) => {
          // Filter out expected/transient errors to reduce noise
          const errorMsg = String(err.message || err);
          const isExpectedError = errorMsg.toLowerCase().includes('no api provider registered') ||
                                  errorMsg.toLowerCase().includes('rate limit') ||
                                  errorMsg.toLowerCase().includes('usage credits') ||
                                  errorMsg.toLowerCase().includes('spend limit') ||
                                  errorMsg.toLowerCase().includes('out of') ||
                                  errorMsg.toLowerCase().includes('limit hit');
          if (!isExpectedError) {
            console.log(`[router] Skipping ${ref}: ${errorMsg}`);
          }
          // Always record the real reason, even for "expected" errors, so the final
          // error message reflects what actually happened instead of "no candidates".
          lastError = `${ref}: ${errorMsg}`; allErrors.push(lastError);
          recordSoftFailure(ref);
          // Notify user about hard failures so they know we tried alternatives
          pushRouterInfo(proxy, `> [router] Trying next model (${ref} unavailable: ${errorMsg})\n\n`);
          return null;
        });
        if (!target) continue;

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
          const result = await consumeWithDetection(target.stream, proxy, EMPTY_RESPONSE_TIMEOUT_MS);

          if (result.ok) {
            // Success — record healthy, proxy completes via the pushed "done" event
            recordOk(ref);
            return;
          }

          // Rate-limit / spend-limit failure — record a HARD limit (not soft)
          // so the model is properly skipped in future attempts and API keys
          // are rotated. Without this, the router only records a short soft
          // backoff and keeps retrying the same rate-limited model.
          if (result.reason === 'rate_limit_exceeded') {
            const rlResult = recordLimit(ref);
            lastError = `${ref}: rate_limit_exceeded`;
            allErrors.push(lastError);
            const nextRef = candidates.slice(i + 1).find(r => !isLimited(r));
            const suffix = nextRef ? `, versuche ${nextRef} …` : '';
            const keyMsg = rlResult.rotated ? ` (key rotated to ${rlResult.newKey})` : '';
            pushRouterInfo(proxy, `> [router] ${ref} — Rate-Limit/Spend-Limit erreicht${keyMsg}${suffix}\n\n`);
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
          const isCloudProvider = !ref.startsWith('ollama/') && !ref.startsWith('lm-studio/');
          const isEmptyFailure = result.reason === 'empty_response' || result.reason === 'empty_timeout';
          const isFreeModel = ref.includes(':free');
          if (isCloudProvider && isEmptyFailure && !isFreeModel) {
            // Paid cloud model — treat as rate-limit (hard cooldown)
            const rlResult = recordLimit(ref);
            lastError = `${ref}: ${result.reason} (treated as rate-limit)`; allErrors.push(lastError);
            const nextRef = candidates.slice(i + 1).find(r => !isLimited(r));
            const suffix = nextRef ? `, versuche ${nextRef} …` : '';
            const keyMsg = rlResult.rotated ? ` (key rotated to ${rlResult.newKey})` : '';
            pushRouterInfo(proxy, `> [router] ${ref} — leere Antwort (vermutlich Rate-Limit)${keyMsg}${suffix}\n\n`);
            continue;
          }

          // Local model soft failure — short backoff only
          lastError = `${ref}: ${result.reason}`; allErrors.push(lastError);
          recordSoftFailure(ref);

          // Notify the user about the empty response, with next candidate hint if available
          const reason = result.reason === 'empty_timeout'
            ? 'keine Antwort innerhalb des Timeouts'
            : 'leere Antwort vom Modell';
          const nextRef = candidates.slice(i + 1).find(r => !isLimited(r));
          const suffix = nextRef ? `, versuche ${nextRef} …` : '';
          pushRouterInfo(proxy, `> [router] ${ref} — ${reason}${suffix}\n\n`);
        } catch (streamError) {
          // Hard failure (e.g., "No API provider registered") — treat as soft failure
          const errorMsg = streamError instanceof Error ? streamError.message : String(streamError);
          lastError = `${ref}: ${errorMsg}`; allErrors.push(lastError);
          recordSoftFailure(ref);
          const nextRef = candidates.slice(i + 1).find(r => !isLimited(r));
          const suffix = nextRef ? `, versuche ${nextRef} …` : '';
          pushRouterInfo(proxy, `> [router] ${ref} — Fehler: ${errorMsg}${suffix}\n\n`);
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
      
      if (allFailed && label) {
        // Try to fall back to a lower-tier group
        const fallbackGroup = getFallbackGroup(label);
        if (fallbackGroup) {
          const fb = resolve(fallbackGroup);
          if (fb?.candidates?.length) {
            pushRouterInfo(proxy, `> [router] All models in ${label} failed, trying ${fallbackGroup}...\n\n`);
            // Recursively try the fallback group
            await driveStream(proxy, fb.candidates, context, options, `${label}→${fallbackGroup}`);
            return;
          }
        }
      }

      // All retries exhausted — push an error event listing every failure so the
      // real cause isn't hidden behind whichever candidate happened to fail last.
      const availableModels = router.allDiscoveredRefs().slice(0, 10).join(', ');
      const modelSuffix = router.allDiscoveredRefs().length > 10 ? '...' : '';
      const hintInfo = label ? `[HINT] ${label}\n` : '';
      const failureList = allErrors.length
        ? allErrors.map((e) => `  - ${e}`).join('\n')
        : '  (no candidates attempted)';
      const errMsg: AssistantMessage = {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: `[router] All ${candidates.length} candidate(s) failed:\n${failureList}\n${hintInfo}Available: ${availableModels}${modelSuffix}`,
          },
        ],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'error',
        timestamp: Date.now(),
      } as AssistantMessage;
      proxy.push({ type: 'error', reason: 'error', error: errMsg } as AssistantMessageEvent);
    })().catch((err) => {
      // Unhandled error in the async driver — surface it
      const errMsg: AssistantMessage = {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: `[router] Stream error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'error',
        timestamp: Date.now(),
      } as AssistantMessage;
      proxy.push({ type: 'error', reason: 'error', error: errMsg } as AssistantMessageEvent);
    });
  }

  async function registerGroupModels(ctx: any) {
    // Register discovered providers with pi's model registry.
    // Skip providers that have dedicated extensions (CLI OAuth), built-in pi support,
    // or are already registered by another extension.
    // Also skip providers pi knows natively (have built-in models)
    for (const prov of ['anthropic', 'openai', 'google']) SKIP_REGISTRATION.add(prov);

    for (const [provId, def] of Object.entries(PROVIDER_MAP)) {
      if (!def.baseUrl || !def.api) continue;
      if (SKIP_REGISTRATION.has(provId)) continue;
      // Keys can come from router-config.json OR from auth.json (via authKey).
      // Providers like mistral-zai have an authKey but no explicit keys in
      // router-config.json — without this fallback they would never register.
      const keys = cfg.providers?.[provId]?.keys;
      let rawKey: string | undefined;
      let apiKey: string | undefined;
      if (keys?.length) {
        rawKey = keys[activeKeyIdx[provId] ?? 0].key;
        apiKey = resolveKeyValue(rawKey);
        if (!apiKey || (apiKey === rawKey && rawKey.startsWith('__local__'))) continue;
      } else if (def.authKey) {
        // Try to get key from Pi's auth store (auth.json)
        apiKey = await sessionCtx?.modelRegistry?.getApiKeyForProvider?.(def.authKey)
          .catch(() => null) ?? undefined;
        if (!apiKey) continue;
      } else {
        continue;
      }

      // Collect models for this provider from available_models + model_metrics
      const provModels: string[] = [];
      const seen = new Set<string>();
      for (const m of cache.available_models ?? []) {
        if (m.provider === provId && !seen.has(m.id)) {
          provModels.push(m.id);
          seen.add(m.id);
        }
      }
      if (!provModels.length) continue;

      // Skip if provider already has models AND a working API key
      const alreadyRegistered = provModels.some((id) => ctx.modelRegistry.find(provId, id));
      if (alreadyRegistered) {
        const existingKey = await ctx.modelRegistry.getApiKeyForProvider(provId).catch(() => null);
        if (existingKey) continue;
      }

      try {
        (pi as any).registerProvider(provId, {
          baseUrl: def.baseUrl,
          apiKey,
          api: def.api,
          models: provModels.map((id) => ({
            id,
            name: `${provId}/${id}`,
            reasoning: true,
            input: ['text', 'image'] as any,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 64_000,
          })),
        });
      } catch {
        /* provider already registered or config error */
      }
    }

    // Re-register group providers with updated resolution info
    registerGroupProviders();
  }

  // ── Command: /router ───────────────────────────────────────────────────

  pi.registerCommand('router', {
    description: 'Model router status. Usage: /router [group|scan]',
    getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
      // Sub-command + group name completion (TAB-friendly).
      const subcommands: AutocompleteItem[] = [
        { value: 'scan', label: 'scan', description: 'Re-discover models, re-scrape GDPval, regenerate config' },
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
      lines.push('', '/router <group> | scan');
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
