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
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import type { Config, Cache, Defaults } from './src/types.ts';
import { RateLimitManager } from './src/rate-limit.ts';
import { DiscoveryManager } from './src/discovery.ts';
import * as metricsModule from './src/metrics.ts';
import { lookupGdp, lookupContextWindow } from './src/metrics.ts';
import { countSessionErrorsSince } from './src/session-errors.ts';
import { CacheManager } from './src/cache.ts';
import { readRouterVersion } from './src/version.ts';
import { wedgeCooldownText, setWatchdogBreakerTuning } from './src/provider-watchdog.ts';
import {
  recordProviderFailure,
  recordBreakerSkip,
  isProviderOpen,
  resolveBreakerTuning,
  isLocalProviderName,
  type ProviderEvidenceKind,
} from './src/provider-breaker.ts';
import { resyncDynamicFromStatic, collectStaticContributions, registerRegistryProviderStubs, type StaticContributions } from './src/dynamic-config.ts';
import { loadLayeredConfig } from './src/config-loader.ts';
import { Router } from './src/routing.ts';
import { classifyPrompt, detectHintDirectly, getGroupForCategory, setCategoryGroupMapping, ClassificationResult } from './src/content-classifier.ts';
import { SessionEscalation } from './src/escalation.ts';
import { localClassifierPins, resolveLocalClassifierChain } from './src/classifier-local-probe.ts';
import { costTracker } from './src/cost-tracker.ts';
// Shared router logger (D2): the log functions live in src/logger.ts so every
// src/ module can log without reaching for console.* (which bypasses Pi's TUI
// and can land in the user's input field). Re-imported here for index.ts's own use.
import { routerLog, warnLog, errorLog, setLogLevel } from './src/logger.ts';
import { StreamOrchestrator, type StreamOrchestratorContext } from './src/stream-orchestrator.ts';
import { createContextUtils } from './src/context-utils.ts';
import { createLimitGlue } from './src/limit-glue.ts';
import { createModelResolveGlue } from './src/model-resolve-glue.ts';
import { createScanRunner } from './src/scan-runner.ts';
import { createDynamicConfigRunner } from './src/dynamic-config-runner.ts';
import { createFreeModelRegistration } from './src/free-model-registration.ts';
import { createStreamProxy } from './src/stream-proxy.ts';
import { createGroupRegistration } from './src/group-registration.ts';
import { createEventHandlers } from './src/event-handlers.ts';
import { createTools } from './src/tools.ts';
import { createCommands } from './src/commands.ts';

function loadDefaults(extDir: string): Defaults {
  const yamlPath = path.join(extDir, 'router-defaults.yaml');
  return YAML.parse(fs.readFileSync(yamlPath, 'utf-8')) as Defaults;
}

const _defaults = loadDefaults(path.dirname(fileURLToPath(import.meta.url)));
const COST_MUX_AT_HIT = _defaults.cost_mux_at_hit;
const MODELS_TTL = _defaults.models_ttl_ms;
const EMPTY_RESPONSE_TIMEOUT_MS = _defaults.empty_response_timeout_ms;
const REASONING_EMPTY_RESPONSE_TIMEOUT_MS = _defaults.reasoning_empty_response_timeout_ms;
const STALL_TIMEOUT_MS = _defaults.stall_timeout_ms;
const RATE_LIMIT_WAIT_MAX_MS = _defaults.rate_limit_wait_max_ms;
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

// ── Extension ─────────────────────────────────────────────────────────────

/**
 * Fingerprint of the config inputs that legitimately change how many models a
 * scan keeps (exclusions, providers, groups). Stored in the dynamic config so
 * the scan-sanity regression check can tell a deliberate shrink from a collapse.
 */
function dynamicConfigFingerprint(c: Config): string {
  const basis = JSON.stringify({
    exclude: c.exclude ?? null,
    providers: Object.keys(c.providers ?? {}).sort(),
    groups: Object.keys(c.model_groups ?? {}).sort(),
  });
  return createHash('sha1').update(basis).digest('hex').slice(0, 12);
}

const defaultExport = function (pi: ExtensionAPI) {
  const extDir = path.dirname(fileURLToPath(import.meta.url));
  const cfgPath = path.join(extDir, 'router-config.json');
  // Generated state (router-config.dynamic.json, .cache/scan-cache.json)
  // lives next to the extension unless PI_ROUTER_STATE_DIR points elsewhere.
  // The test harness uses this to keep every test file off the checkout.
  // SYNC RULE: every NEW file written under stateDir needs (a) a `!dist/<path>`
  // negation in package.json `files` and (b) an entry in
  // test/package-contents.test.ts STATE_FILES — otherwise the npm package
  // ships runtime state (roborev jobs 634/644).
  const stateDir = process.env.PI_ROUTER_STATE_DIR || extDir;
  // Scan-sanity acceptance of a smaller result requires a "settled" scan:
  // one that runs at least scan_settle_ms after start, when the model registry
  // is certainly loaded. A start-up race can repeat on every session start,
  // but it never produces a settled scan (review 2026-09-27).
  const routerStartedAt = Date.now();
  let settleRetryScheduled = false;
  const SCAN_REFUSAL_MAX_AGE_MS = 24 * 60 * 60_000;

  let cfg: Config;
  let staticCfg: Config; // Static configuration (always from the embedded router-config.json + its layers)
  // Clean-by-construction snapshot of what the static layers declare under
  // the merge keys — taken in load() right after loadLayeredConfig, BEFORE
  // any provider stub registration can mutate the config (review M1, 2026-10-07:
  // a snapshot taken at the write site could be stale or stub-polluted).
  let staticContributions: StaticContributions = {} as StaticContributions;
  // The ONE cache object: never reassigned. loadCache() re-reads disk into it,
  // so every holder (managers, router, metrics) sees the same state.
  const cache: Cache = {};
  let rateLimitManager: RateLimitManager;
  let discoveryManager: DiscoveryManager;
  let cacheManager: CacheManager;
  let router: Router;
  // gdpval/modelMap/lookupGdp state lives in metrics.ts (single source of truth).
  let scanning = false;
  let sessionStart = Date.now();
  // Whether sessionStart was set by THIS process's first session_start (the
  // anchor-reset rule lives in the session_start handler, review M2).
  let sessionAnchorInit = false;
  // Immediate re-render trigger for the footer error counter: pi's
  // setStatus (setExtensionStatus). The COUNT is not state of its own — it
  // is derived from the cache.session_errors ring buffer (entries with
  // ts >= sessionStart) and rendered directly as a footer part by the
  // router's own footer (which replaces pi's built-in footer — the only
  // renderer of extension statuses, review C1). setStatus additionally
  // triggers requestRender so a new error shows up immediately instead of
  // on the next 30s footer tick. One buffer, one anchor, one count: the
  // status line and /router errors stay 1:1 correlatable (owner requirement
  // 2026-09-27).
  let statusUpdater: ((key: string, text: string) => void) | null = null;
  function updateErrorStatusLine(): void {
    const n = countSessionErrorsSince(cache, sessionStart, process.pid);
    try {
      statusUpdater?.('router', n > 0 ? `\u26A0${n} err` : '');
    } catch {
      // No TUI in print/RPC modes — the buffer still records everything.
    }
  }

  // Debounced persistence for the session_errors ring buffer (review M1):
  // saveCache is a synchronous full-file JSON write; a candidate-chain burn
  // (17-18 failures in quick succession, the 2026-09-27 incident pattern)
  // must not trigger 17-18 synchronous writes. 2s coalescing bounds the
  // worst-case loss on a hard crash to one window; session_shutdown and the
  // every-10-turns save cover normal exits.
  let sessionErrorSaveTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleSessionErrorSave(): void {
    if (sessionErrorSaveTimer) return;
    sessionErrorSaveTimer = setTimeout(() => {
      sessionErrorSaveTimer = null;
      try {
        saveCache();
      } catch {
        // Best-effort: the next failure/shutdown save retries.
      }
    }, 2000);
    sessionErrorSaveTimer.unref?.();
  }
  let turnStart = 0;
  // The router's own version, read lazily from package.json on the first
  // load() and logged once per process — so the log identifies WHICH
  // installation is active (important when several installs coexist).
  let routerVersion: string | null = null;
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
  // Initialized early so buildOrchestratorContext can reference it before the
  // full tryStream helpers are defined. tryStream clears and repopulates it.
  let skipReasons = new Map<string, string>();

  const { estimateContextTokens, getModelContextWindow, updateModelContextWindow, getEmptyResponseTimeout, getStallTimeout, getRateLimitWaitMaxMs, extractLastUserPrompt, extractLastAssistantSnippet, isCompactionTurn } = createContextUtils({
    get cfg() { return cfg; },
    get EMPTY_RESPONSE_TIMEOUT_MS() { return EMPTY_RESPONSE_TIMEOUT_MS; },
    get previousMessageCount() { return previousMessageCount; },
    set previousMessageCount(v) { previousMessageCount = v; },
    get previousTokenCount() { return previousTokenCount; },
    set previousTokenCount(v) { previousTokenCount = v; },
    get RATE_LIMIT_WAIT_MAX_MS() { return RATE_LIMIT_WAIT_MAX_MS; },
    get REASONING_EMPTY_RESPONSE_TIMEOUT_MS() { return REASONING_EMPTY_RESPONSE_TIMEOUT_MS; },
    get sessionCtx() { return sessionCtx; },
    get STALL_TIMEOUT_MS() { return STALL_TIMEOUT_MS; },
  });

  const { getM, costMux, isLimited, limitSecs, effCost, clearLimit, recordOk, observeFailure, recordStreamFailure, formatResetMsg, limitFreeDayCap, updateMetrics, lookupPrice, formatBlocklist, getUsage } = createLimitGlue({
    get cache() { return cache; },
    get cacheManager() { return cacheManager; },
    get cfg() { return cfg; },
    get discoveryManager() { return discoveryManager; },
    get rateLimitManager() { return rateLimitManager; },
    get scheduleSessionErrorSave() { return scheduleSessionErrorSave; },
    get updateErrorStatusLine() { return updateErrorStatusLine; },
  });

  const { resolve, detectGroup, fmtModel, getTopModels, allDiscoveredRefs } = createModelResolveGlue({
    get cache() { return cache; },
    get costMux() { return costMux; },
    get discoveryManager() { return discoveryManager; },
    get effCost() { return effCost; },
    get getM() { return getM; },
    get isLimited() { return isLimited; },
    get limitSecs() { return limitSecs; },
    get router() { return router; },
  });

  const { populateLlmMatches, scan } = createScanRunner({
    get cache() { return cache; },
    get cacheManager() { return cacheManager; },
    get cfg() { return cfg; },
    get GDPVAL_URL() { return GDPVAL_URL; },
    get generateDynamicConfig() { return generateDynamicConfig; },
    get MODELS_TTL() { return MODELS_TTL; },
    get saveCache() { return saveCache; },
    get scanning() { return scanning; },
    set scanning(v) { scanning = v; },
    get sessionCtx() { return sessionCtx; },
  });

  const { generateDynamicConfig } = createDynamicConfigRunner({
    get cache() { return cache; },
    get cacheManager() { return cacheManager; },
    get cfg() { return cfg; },
    set cfg(v) { cfg = v; },
    get discoveryManager() { return discoveryManager; },
    set discoveryManager(v) { discoveryManager = v; },
    get dynamicConfigFingerprint() { return dynamicConfigFingerprint; },
    get populateLlmMatches() { return populateLlmMatches; },
    get rateLimitManager() { return rateLimitManager; },
    get router() { return router; },
    set router(v) { router = v; },
    get routerStartedAt() { return routerStartedAt; },
    get SCAN_REFUSAL_MAX_AGE_MS() { return SCAN_REFUSAL_MAX_AGE_MS; },
    get scanning() { return scanning; },
    get sessionCtx() { return sessionCtx; },
    get settleRetryScheduled() { return settleRetryScheduled; },
    set settleRetryScheduled(v) { settleRetryScheduled = v; },
    get stateDir() { return stateDir; },
    get staticCfg() { return staticCfg; },
    get staticContributions() { return staticContributions; },
    get turnStart() { return turnStart; },
  });

  const { registerFreeModelOnDemand } = createFreeModelRegistration({
    get cfg() { return cfg; },
    get pi() { return pi; },
    get sessionCtx() { return sessionCtx; },
    // ADR-0022: the router never resolves keys itself — pi does.
    get resolveApiKey() {
      return async (provider: string) =>
        (await (sessionCtx?.modelRegistry as any)?.getApiKeyForProvider?.(provider).catch?.(
          () => null
        )) ?? null;
    },
  });

  const { groupStream, tryStream, consumeWithDetection, isLocalProvider, localStreamLimit } = createStreamProxy({
    get cfg() { return cfg; },
    get localStreamsInFlight() { return localStreamsInFlight; },
    set localStreamsInFlight(v) { localStreamsInFlight = v; },
    get OLLAMA_MAX_CONCURRENT_STREAMS() { return OLLAMA_MAX_CONCURRENT_STREAMS; },
    get registerFreeModelOnDemand() { return registerFreeModelOnDemand; },
    get resolve() { return resolve; },
    get sessionCtx() { return sessionCtx; },
    get skipReasons() { return skipReasons; },
    set skipReasons(v) { skipReasons = v; },
    get streamOrchestrator() { return streamOrchestrator; },
  });

  const { registerGroupProviders, registerGroupModels } = createGroupRegistration({
    get cache() { return cache; },
    get cfg() { return cfg; },
    get getM() { return getM; },
    get groupStream() { return groupStream; },
    get pi() { return pi; },
    get resolve() { return resolve; },
    get sessionCtx() { return sessionCtx; },
    get contextWindow() { return lookupContextWindow; },
  });

  createEventHandlers({
    get activeGroup() { return activeGroup; },
    set activeGroup(v) { activeGroup = v; },
    get cache() { return cache; },
    get cfg() { return cfg; },
    get curModel() { return curModel; },
    set curModel(v) { curModel = v; },
    get detectGroup() { return detectGroup; },
    get escalation() { return escalation; },
    get extDir() { return extDir; },
    get getM() { return getM; },
    get isLimited() { return isLimited; },
    get lastDynamicModel() { return lastDynamicModel; },
    get load() { return load; },
    get loadCache() { return loadCache; },
    get pi() { return pi; },
    get rateLimitManager() { return rateLimitManager; },
    get recordOk() { return recordOk; },
    get registerGroupModels() { return registerGroupModels; },
    get router() { return router; },
    get saveCache() { return saveCache; },
    get scan() { return scan; },
    get sessionAnchorInit() { return sessionAnchorInit; },
    set sessionAnchorInit(v) { sessionAnchorInit = v; },
    get sessionCtx() { return sessionCtx; },
    set sessionCtx(v) { sessionCtx = v; },
    get sessionStart() { return sessionStart; },
    set sessionStart(v) { sessionStart = v; },
    get statusUpdater() { return statusUpdater; },
    set statusUpdater(v) { statusUpdater = v; },
    get turnStart() { return turnStart; },
    set turnStart(v) { turnStart = v; },
    get updateErrorStatusLine() { return updateErrorStatusLine; },
    get updateMetrics() { return updateMetrics; },
  });

  createTools({
    get activeGroup() { return activeGroup; },
    set activeGroup(v) { activeGroup = v; },
    get cfg() { return cfg; },
    get cfgPath() { return cfgPath; },
    get fmtModel() { return fmtModel; },
    get getM() { return getM; },
    get load() { return load; },
    get pi() { return pi; },
    get resolve() { return resolve; },
    get router() { return router; },
  });

  createCommands({
    get allDiscoveredRefs() { return allDiscoveredRefs; },
    get cache() { return cache; },
    get cacheManager() { return cacheManager; },
    get cfg() { return cfg; },
    get cfgPath() { return cfgPath; },
    get costMux() { return costMux; },
    get curModel() { return curModel; },
    get effCost() { return effCost; },
    get fmtModel() { return fmtModel; },
    get formatBlocklist() { return formatBlocklist; },
    get getM() { return getM; },
    get getTopModels() { return getTopModels; },
    get getUsage() { return getUsage; },
    get isLimited() { return isLimited; },
    get limitSecs() { return limitSecs; },
    get load() { return load; },
    get lookupPrice() { return lookupPrice; },
    get lookupListPrice() { return metricsModule.lookupListPrice; },
    get pi() { return pi; },
    get rateLimitManager() { return rateLimitManager; },
    get resolve() { return resolve; },
    get router() { return router; },
    get scan() { return scan; },
    get sessionCtx() { return sessionCtx; },
    set sessionCtx(v) { sessionCtx = v; },
    get sessionStart() { return sessionStart; },
  });

  // ── Config + Cache ─────────────────────────────────────────────────────

  function load() {
    // Log the active version once per process (first load). load() also
    // runs mid-turn from tools (resolve_model_group, update_model_metrics)
    // and on every session_start, so gating on routerVersion===null keeps
    // the log free of repeats while still emitting exactly once.
    if (routerVersion === null) {
      routerVersion = readRouterVersion();
      routerLog(`[router] pi-model-router v${routerVersion} loaded`);
    }
    // Layered config: embedded defaults → global user override → project override.
    // Deep-merge so users only specify the keys they want to change.
    const { config: layeredCfg, sources } = loadLayeredConfig(extDir, process.cwd(), routerLog);
    setLogLevel(layeredCfg.log_level);
    staticCfg = layeredCfg;
    // Snapshot BEFORE anything can add provider stubs into this object.
    staticContributions = collectStaticContributions(staticCfg);
    if (sources.length > 1) {
      routerLog(`[router] Config loaded from ${sources.length} layer(s): ${sources.join(' → ')}`);
    }

    // Try to load the dynamic configuration
    const dynamicConfigPath = path.join(stateDir, 'router-config.dynamic.json');
    let loadedFromDynamic = false;
    let loadResync: { droppedProviders: string[] } = { droppedProviders: [] };
    
    try {
      if (fs.existsSync(dynamicConfigPath)) {
        const dynamicCfg = JSON.parse(fs.readFileSync(dynamicConfigPath, 'utf-8'));
        // Check whether the dynamic configuration is valid (has _dynamic metadata)
        if (dynamicCfg._dynamic && dynamicCfg.model_groups) {
          // IMPORTANT: user-intent keys (exclude rules, timeout overrides,
          // rate-limit scheduling, delegation, the local-stream limiter, …)
          // must ALWAYS come from staticCfg — the dynamic config can contain
          // stale values if the user changed router-config.json or
          // router-config.user.json in the meantime. Without this re-sync,
          // editing any of these keys has no effect as long as a
          // router-config.dynamic.json exists on disk (the common steady
          // state). The whitelist is a single exported list,
          // DYNAMIC_CONFIG_RESYNC_KEYS (src/dynamic-config.ts), shared with
          // the write site in generateDynamicConfigNow — per-key rationale
          // lives there; DYNAMIC_CONFIG_MERGE_KEYS (providers, model_metrics,
          // gdpval_builtin) are pruned of static-removed entries (the
          // contribution snapshot is taken in load(), before any stub can
          // pollute it), then merged per entry, static winning. Final
          // v1.6.0 review I4: ollama_max_concurrent_streams
          // had been forgotten in both hand-maintained assignment blocks;
          // I5: the shared list + the data-driven staleness test keep the
          // next key from being forgotten the same way.
          loadResync = resyncDynamicFromStatic(dynamicCfg, staticCfg, staticContributions);
          cfg = dynamicCfg;
          loadedFromDynamic = true;
        }
      }
    } catch (error) {
      errorLog('[router] Error loading dynamic configuration, falling back to static config:', error);
    }
    
    // If there is no dynamic configuration, use the static one
    if (!loadedFromDynamic) {
      cfg = staticCfg;
    }

    // Review M2, 2026-10-07: a static `billing` field that a layer removed
    // since the last generation was pruned above — re-register exactly those
    // dropped providers as registry stubs so the provider keeps its
    // subscription billing until the next regeneration (up to 30 days away).
    // ONLY the dropped ones: stubbing every unknown provider at load time
    // would reorder tiered groups (subscription ahead of local) before the
    // first regeneration (regression caught by the ollama-fallback tests).
    if (loadResync.droppedProviders.length && sessionCtx?.modelRegistry) {
      const dropped = new Set(loadResync.droppedProviders);
      const refs: string[] = [];
      for (const m of sessionCtx.modelRegistry.getAvailable()) {
        if (dropped.has(m.provider)) refs.push(`${m.provider}/${m.id}`);
      }
      registerRegistryProviderStubs(cfg, refs);
    }

    // Task-type-balancing Phase 3: install the user's category→group
    // overrides (category_groups) into the classifier. ALWAYS from the
    // static layered config — like exclude/delegation this is user intent,
    // and category_groups is in DYNAMIC_CONFIG_RESYNC_KEYS so a stale
    // dynamic file can never shadow it either.
    setCategoryGroupMapping(staticCfg.category_groups);

    // Breaker tuning for classifier-path observations (review M2 of the
    // Phases 2-4 round): classifyPrompt has no Config in scope, so its
    // local-timeout observations resolve the user's provider_breaker
    // tuning here instead of the code defaults (module-level reference,
    // live on every load() — same pattern as setCategoryGroupMapping).
    setWatchdogBreakerTuning(resolveBreakerTuning(staticCfg.provider_breaker));

    // gdpval state lives in metrics.ts (single source of truth).
    // setConfig + setCache below populate it correctly, including self-healing
    // from cache.gdpval_scores when needed.
    
    // Initialize managers. The backoff schedules are cfg-backed (falling
    // back to the YAML defaults) so they can be tuned per environment — and
    // shrunk in integration tests to exercise the cooldown paths quickly
    // (the collapse-wait test needs sub-5s cooldowns, impossible with the
    // 60s/30s production minimums).
    const backoffSchedule = (cfg.backoff_minutes ?? _defaults.backoff_minutes).map((m) => m * 60_000);
    const softBackoffSchedule = cfg.soft_backoff_ms ?? _defaults.soft_backoff_ms;
    rateLimitManager = new RateLimitManager(backoffSchedule, softBackoffSchedule, COST_MUX_AT_HIT, cache);
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
    // Hand over the shared cache object; loadCache() fills it from disk
    // (review 2026-09-27).
    cacheManager = new CacheManager(stateDir, cache, process.cwd());
    // load() does not only run at boot: tools call it directly
    // (resolve_model_group, update_model_metrics) and EVERY session_start
    // fires it — including subagent sessions, which share this module-level
    // Router while a parent turn is still running. Rebuilding without
    // carrying the turn's pinned driver would silently un-protect the
    // expensive-model read block for the rest of that turn (same carry as
    // the Router rebuild in generateDynamicConfig — see the block there).
    // router is undefined on the very first boot; getTurnDriverRef then has
    // nothing to carry and adoptTurnDriverRef('') is a no-op.
    const carriedTurnDriver = router?.getTurnDriverRef(turnStart) ?? '';
    router = new Router(cfg, cache, rateLimitManager.getLimits());
    if (turnStart > 0) router.noteTurnStart(turnStart);
    router.adoptTurnDriverRef(carriedTurnDriver);
    // load() runs on every session_start (and other reload paths) and replaces
    // the Router instance wholesale, which drops its private sessionCtx field.
    // Without this, group resolution silently falls back to the stale on-disk
    // cache for the rest of the session instead of Pi's live model registry —
    // dynamic discovery would never actually engage. sessionCtx (the module-level
    // variable, set in session_start/session_shutdown) is the source of truth to
    // re-apply here; callers must never need to remember to redo this themselves.
    if (sessionCtx) router.setSessionCtx(sessionCtx);
    metricsModule.setCache(cache);
    // Loop detection's local model: a user pin (classifier_fallback) wins,
    // else the head of the derived local classifier chain (ADR-0025); none
    // disables the LLM leg. Resolved at call time so a scan's fresh probe
    // result is picked up without a reload.
    escalation.setClassifierModel(() => {
      const group = cfg.model_groups?.['dynamic'];
      const pins = localClassifierPins(group);
      return pins.fallbackModel ?? resolveLocalClassifierChain(cache, cfg, pins).primary;
    });
  }

  function loadCache() {
    cacheManager.loadCache();
    metricsModule.setCache(cache);
    rateLimitManager.updateCache(cache);
    router?.updateCache(cache);
  }

  function saveCache() {
    cacheManager.saveCache(cache);
  }

  // ── Key Discovery ───────────────────────────────────────────────────────

  // NOTE (ADR-0022): key discovery was removed — pi owns credential
  // resolution (modelRegistry.getApiKeyForProvider); the router never
  // reads or writes Pi's credential store.


  load();
  metricsModule.loadModelMap(extDir);
  loadCache();
  registerGroupProviders();

  // Build the streaming orchestrator context once all helpers are defined.
  // Fields that change mid-session (cfg, cache) are passed as mutable object
  // references so the orchestrator always reads the current value.
  const buildOrchestratorContext = (): StreamOrchestratorContext => ({
    // NOTE: curModel is deliberately NOT passed here. It changes every turn;
    // a by-value field would snapshot a stale ref while looking like live
    // state. The orchestrator writes the current ref through
    // ctx.router.setCurModel (which hits the live Router instance) — the
    // former ctx.curModel field was write-only dead wiring (final v1.6.0
    // review minor #8).
    get activeGroup() { return activeGroup; },
    set activeGroup(v) { activeGroup = v; },
    get lastDynamicModel() { return lastDynamicModel; },
    set lastDynamicModel(v) { lastDynamicModel = v; },
    get lastClassifiedCategory() { return lastClassifiedCategory; },
    set lastClassifiedCategory(v) { lastClassifiedCategory = v; },
    get sessionCtx() { return sessionCtx; },
    get cfg() { return cfg; },
    get cache() { return cache; },
    // router/rateLimitManager/cacheManager are all reassigned by load() (F10
    // cooldown investigation, 2026-09-02) — load() runs on every session_start
    // AND on every resolve_model_group/update_model_metrics tool call and
    // /router slash-command invocation. A plain (non-getter) property here
    // freezes ctx.router to whichever Router instance existed at
    // buildOrchestratorContext() call time; every later load() call created a
    // NEW Router (wrapping a NEW, empty RateLimitManager Map) without updating
    // this ctx — only one of six load()-adjacent reassignment sites explicitly
    // re-synced streamOrchestrator.ctx.router. The other five left ctx.router
    // silently orphaned, pointing at a Map disconnected from the live
    // rateLimitManager. Result: ctx.isLimited(ref) (a closure that reads the
    // live module-level `rateLimitManager` variable) correctly reported a ref
    // as cooled down, but ctx.router.limitSecs(ref) read the stale, empty map
    // and always reported "0s remaining" — logged as the self-contradictory
    // "skipped, still in cooldown (0s remaining)". Worse, the total-cooldown-
    // collapse force-retry logic (ranks candidates by ctx.router.limitSecs to
    // force-retry the LEAST-cooled-down one) couldn't rank anything correctly
    // against a disconnected map, so it force-retried candidates that were
    // still genuinely rate-limited — the "running in circles" symptom. Getters
    // (matching the existing cfg/cache/activeGroup pattern above) make these
    // three always resolve the CURRENT module-level binding, eliminating the
    // whole staleness class instead of patching each load() call site.
    get router() { return router; },
    get rateLimitManager() { return rateLimitManager; },
    get cacheManager() { return cacheManager; },
    escalation,
    costTracker,
    resolve,
    isLimited,
    clearLimit,
    tryStream,
    estimateContextTokens,
    getModelContextWindow,
    updateModelContextWindow,
    getEmptyResponseTimeout,
    getStallTimeout,
    getRateLimitWaitMaxMs,
    consumeWithDetection,
    isLocalProvider,
    localStreamLimit: () => localStreamLimit(),
    releaseLocalSlot: (ref: string) => {
      if (isLocalProvider(ref) && localStreamsInFlight > 0) localStreamsInFlight--;
    },
    // recordSoftFailure is no longer wired directly: every orchestrator
    // failure site goes through recordStreamFailure (review round 2,
    // Finding 1), which calls it internally for the soft path — one path,
    // one buffer, no bypass.
    recordOk,
    observeFailure,
    // Provider circuit breaker (ADR-0026, plan Phase 2): every soft failure
    // of a D1 evidence kind feeds the breaker. Local refs keep ADR-0016
    // parity (always observed, N=2); cloud refs only while the kill switch
    // (provider_breaker.enabled, default on) is on. Returns true only when
    // this failure newly OPENS the breaker, so the orchestrator narrates
    // once per open.
    observeProviderFailure: (ref: string, reason: string, detail?: string) => {
      const kind = reason as ProviderEvidenceKind;
      if (
        kind !== 'empty_response' && kind !== 'empty_timeout' &&
        kind !== 'stall_timeout' && kind !== 'provider_error'
      ) return false;
      const provider = ref.split('/')[0];
      const tuning = resolveBreakerTuning(cfg.provider_breaker);
      if (!isLocalProviderName(provider) && !tuning.cloudEnabled) return false;
      const newlyOpen = recordProviderFailure(cache, ref, kind, detail, Date.now(), tuning);
      if (newlyOpen) {
        warnLog(`[router] breaker: ${provider} looks wedged — skipping its models for ${wedgeCooldownText(cache, provider, tuning)}`);
      }
      return newlyOpen;
    },
    isBreakerOpen: (ref: string) => {
      const provider = ref.split('/')[0];
      if (!isProviderOpen(cache, provider)) return false;
      // Local providers keep ADR-0016's always-on watchdog; the kill switch
      // only ever disarms the cloud generalization (plan D8).
      return isLocalProviderName(provider) || resolveBreakerTuning(cfg.provider_breaker).cloudEnabled;
    },
    noteBreakerSkip: (ref: string) => recordBreakerSkip(cache, ref.split('/')[0]),
    wedgeCooldownText: (ref: string) => wedgeCooldownText(cache, ref.split('/')[0], resolveBreakerTuning(cfg.provider_breaker)),
    recordStreamFailure,
    formatResetMsg,
    limitFreeDayCap,
    classifyPrompt,
    detectHintDirectly,
    getGroupForCategory,
    extractLastUserPrompt,
    extractLastAssistantSnippet,
    isCompactionTurn,
    lookupGdp,
    get skipReasons() { return skipReasons; },
    get localStreamsInFlight() { return localStreamsInFlight; },
  });

  const streamOrchestrator = new StreamOrchestrator(buildOrchestratorContext());


  pi.on('session_shutdown', () => {
    sessionCtx = null;
    router.setSessionCtx(null);
  });

  // Cleanup CostTracker on process exit. Registered inside the dedupe
  // guard below: the esbuild double-bundle hazard would otherwise stack one
  // exit listener per extension load (the suite printed
  // MaxListenersExceededWarning with 11 exit listeners; pinned by
  // test/exit-listener-dedupe.test.ts).
  // Signal handlers (final v1.6.0 review minor #10): previously a bare
  // process.exit(0) skipped pi's graceful shutdown, so the session_shutdown
  // saveCache() never ran on Ctrl-C. Persist synchronously before exiting
  // (best-effort), and dedupe the registration per process — the file's own
  // comments note the esbuild double-bundle hazard, which would otherwise
  // stack one handler per extension load.
  if (!(globalThis as any).__ROUTER_SIGNAL_CLEANUP__) {
    (globalThis as any).__ROUTER_SIGNAL_CLEANUP__ = true;
    process.on('exit', () => costTracker.destroy());
    const persistAndExit = (): never => {
      try {
        saveCache();
      } catch {
        // Best-effort: a failing save must not block exit.
      }
      process.exit(0);
    };
    process.on('SIGTERM', persistAndExit);
    process.on('SIGINT', persistAndExit);
  }

  // Export groupStream for testing
  (defaultExport as any).groupStream = streamOrchestrator.groupStream.bind(streamOrchestrator);
  (defaultExport as any).driveStream = streamOrchestrator.driveStream.bind(streamOrchestrator);
};

export default defaultExport;
