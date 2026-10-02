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
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import type { Config, Cache, Metrics, Defaults, ModelCapabilities } from './src/types.ts';
import { PI_BUILTIN_PROVIDER_IDS, PROVIDER_MAP } from './src/providers.ts';
import {
  splitRef,
  stripDateSuffix,
  resolveShortModelName,
  fmt,
  fmtTime,
  stripRouterNarration,
  serialized,
} from './src/utils.ts';
import { isRefUsable, rankHintCandidates } from './src/hint-resolution.ts';
import { RateLimitManager } from './src/rate-limit.ts';
import { DiscoveryManager } from './src/discovery.ts';
import * as metricsModule from './src/metrics.ts';
import { countSessionErrorsSince, formatErrorsReport, recordSessionErrorFromFailure } from './src/session-errors.ts';
import { lookupGdp, setPiRegisteredProviders, setModelRegistry } from './src/metrics.ts';
import { estimateOllamaModelsGdpvalAsSlugs } from './src/ollama-gdpval.ts';
import { buildOllamaProviderModels } from './src/ollama-context.ts';
import { checkScanSanity } from './src/scan-sanity.ts';
import { extractCapabilities } from './src/capabilities.ts';
import { CacheManager } from './src/cache.ts';
import { redundantAliasProviders, pruneRedundantCacheEntries } from './src/provider-shadow.ts';
import { isStreamableRef } from './src/streamable-refs.ts';
import { readRouterVersion } from './src/version.ts';
import { matchModelsWithLLMBatched, isPlausibleMatch, type GdpvalEntry } from './src/model-matcher.ts';
import { callLocalLlm, type LocalLlmDeps } from './src/local-llm.ts';
import { isExcluded, type ExcludeContext } from './src/exclude.ts';
import { recordModelFailure, recordModelSuccess, failureStreak } from './src/model-health.ts';
import {
  recordBlocklistFailure,
  recordBlocklistSuccess,
  activeBlocks,
  clearBlocklist,
  formatBlockLogLine,
} from './src/model-blocklist.ts';
import {
  recordLocalTimeout,
  recordLocalSuccess,
  isProviderWedged,
  wedgeFixHint,
  WEDGE_COOLDOWN_TEXT,
} from './src/provider-watchdog.ts';
import { detectDegenerateRepetition } from './src/repetition-guard.ts';
import {
  buildStaticFreeModelsLookup,
  buildModelsWithMetadata,
  collapseSameSlugClusters,
  filterModelsForGroup,
  sortModelsForGroup,
  collectGroupModels,
  computeFallbackGroups,
  DYNAMIC_CONFIG_RESYNC_KEYS,
} from './src/dynamic-config.ts';
import { pushStreamError, pushRouterInfo, pushRouterInfoLogged, isExpectedTransientError, type SourceModelInfo } from './src/stream-driver.ts';
import {
  isRateLimitText,
  isOverflowErrorText,
  isOverflowDeltaText,
  OVERFLOW_TEXT_SCAN_MAX_CHARS,
  isAbortLikeText,
  parseResetAtMs,
  isPaidCloudRateLimitFailure,
} from './src/detection.ts';
import { hasBudget } from './src/budget.ts';
import { loadLayeredConfig } from './src/config-loader.ts';
import { Router, getFallbackGroup, isVirtualGroupRef } from './src/routing.ts';
import { classifyPrompt, detectHintDirectly, getGroupForCategory, ClassificationResult } from './src/content-classifier.ts';
import { SessionEscalation } from './src/escalation.ts';
import { probeAndCache, getCachedFallbackModels, selectClassifierCandidates } from './src/classifier-fallback-probe.ts';
import { costTracker } from './src/cost-tracker.ts';

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

// ── Extension ──────────────────────────────────────────────────────────────

// Shared router logger (D2): writeLogLine / routerLog / appendRawLog /
// setProjectLogDir live in src/logger.ts so every src/ module can log without
// reaching for console.* (which bypasses Pi's TUI and can land in the user's
// input field). Re-imported here for index.ts's own use.
import { routerLog, debugLog, debugLogOnce, forgetDebugOnce, setLogLevel, writeLogLine, appendRawLog, setProjectLogDir } from './src/logger.ts';
import { handleReadDelegation, delegationSettings } from './src/delegation.ts';
import { checkReadBlock, executeBulkRead, resolveReadBlockStreamRef } from './src/bulk-read.ts';
import { StreamOrchestrator, type StreamOrchestratorContext } from './src/stream-orchestrator.ts';
import { createContextUtils } from './src/context-utils.ts';
import { createLimitGlue } from './src/limit-glue.ts';
import { createModelResolveGlue } from './src/model-resolve-glue.ts';
import { createScanRunner } from './src/scan-runner.ts';
import { createDynamicConfigRunner } from './src/dynamic-config-runner.ts';
import { createFreeModelRegistration } from './src/free-model-registration.ts';

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

  const STRIP_SUFFIXES = _defaults.strip_suffixes;
  let cfg: Config;
  let staticCfg: Config; // Static configuration (always from the embedded router-config.json + its layers)
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
    const n = countSessionErrorsSince(cache, sessionStart);
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

  const { resolveKeyValue, getM, costMux, isLimited, limitSecs, effCost, clearLimit, recordOk, observeFailure, recordStreamFailure, formatResetMsg, updateMetrics, lookupPrice, formatBlocklist, getUsage } = createLimitGlue({
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
    get resolveKeyValue() { return resolveKeyValue; },
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
    get turnStart() { return turnStart; },
  });

  const { registerFreeModelOnDemand } = createFreeModelRegistration({
    get cfg() { return cfg; },
    get pi() { return pi; },
    get rateLimitManager() { return rateLimitManager; },
    get resolveKeyValue() { return resolveKeyValue; },
    get sessionCtx() { return sessionCtx; },
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
    if (sources.length > 1) {
      routerLog(`[router] Config loaded from ${sources.length} layer(s): ${sources.join(' → ')}`);
    }

    // Try to load the dynamic configuration
    const dynamicConfigPath = path.join(stateDir, 'router-config.dynamic.json');
    let loadedFromDynamic = false;
    
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
          // lives there. Final v1.6.0 review I4: ollama_max_concurrent_streams
          // had been forgotten in both hand-maintained assignment blocks;
          // I5: the shared list + the data-driven staleness test keep the
          // next key from being forgotten the same way.
          for (const key of DYNAMIC_CONFIG_RESYNC_KEYS) {
            (dynamicCfg as any)[key] = staticCfg[key];
          }
          cfg = dynamicCfg;
          loadedFromDynamic = true;
        }
      }
    } catch (error) {
      routerLog('[router] Error loading dynamic configuration, falling back to static config:', error);
    }
    
    // If there is no dynamic configuration, use the static one
    if (!loadedFromDynamic) {
      cfg = staticCfg;
    }
    
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
    cacheManager = new CacheManager(stateDir, cache);
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
    // Keep escalation's loop-detection model in sync with the configured dynamic
    // group's classifier_fallback — don't hardcode a specific local model.
    const dynGroup = cfg.model_groups?.['dynamic'];
    if (dynGroup?.classifier_fallback) {
      escalation.setClassifierModel(dynGroup.classifier_fallback);
    }
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

  async function discoverKeys() {
    // DiscoveryManager mutates the shared cache object; never take its
    // reference back — it may predate the last loadCache() (review 2026-09-27).
    await discoveryManager.discoverKeys();
    metricsModule.setCache(cache);
    rateLimitManager.updateCache(cache);
    router?.updateCache(cache);
  }

  /**
   * Group provider names the router itself registered. Own-set tracking so
   * the session_start re-register can distinguish "id we own → re-register"
   * from "id someone else owns → refuse" (Ü1): by session_start,
   * getRegisteredProviderIds() contains every group WE registered at load
   * time, and a naive registry guard would skip re-registering all of them.
   */
  const registeredGroupProviderNames = new Set<string>();

  /**
   * Register virtual providers for each model group (strategic, tactical, etc).
   * Called synchronously during extension load so groups are available for
   * --model resolution before session_start fires, and again at
   * session_start (with a registry available) to refresh resolution labels.
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

      // Ü1 guard (AGENTS.md §6; final v1.6.0 review finding I3). The old
      // comment claimed "safe by construction (ADR-0019)" — that only held
      // for the shipped group names. pi.registerProvider REPLACES the
      // provider's `models` array wholesale, so a user-defined group named
      // e.g. "openai" would wipe pi's entire openai catalog for the session.
      // Two-layer guard:
      // 1. Static denylist of pi's builtin provider ids — the only option
      //    at extension load, where pi's extension API exposes no registry
      //    query (a foreign extension registered before us is undetectable
      //    here; documented limitation).
      // 2. At the session_start re-register (when a modelRegistry is
      //    available), refuse ids that are registered but NOT ours.
      if (PI_BUILTIN_PROVIDER_IDS.has(groupName)) {
        routerLog(
          `[groups] Refusing to register model group "${groupName}" as a provider: it would ` +
            `replace pi's builtin provider of the same name (Ü1). Rename the group in router-config.json.`
        );
        continue;
      }
      if (
        (sessionCtx?.modelRegistry as any)?.getRegisteredProviderIds &&
        !registeredGroupProviderNames.has(groupName) &&
        ((sessionCtx?.modelRegistry as any)?.getRegisteredProviderIds?.() as string[]).includes(groupName)
      ) {
        routerLog(
          `[groups] Refusing to register model group "${groupName}" as a provider: ` +
            `another extension already registered that provider id (Ü1). Rename the group.`
        );
        continue;
      }

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
      registeredGroupProviderNames.add(groupName);
    }
  }

  // ── Events ─────────────────────────────────────────────────────────────

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
    observeLocalTimeout: (ref: string) => {
      const newlyWedged = recordLocalTimeout(cache, ref);
      if (newlyWedged) routerLog(`[router] watchdog: ${ref.split('/')[0]} looks wedged — skipping its models for ${WEDGE_COOLDOWN_TEXT}`);
      return newlyWedged;
    },
    isProviderWedged: (ref: string) => isProviderWedged(cache, ref.split('/')[0]),
    recordStreamFailure,
    formatResetMsg,
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

  pi.on('session_start', async (ev, ctx) => {
    sessionCtx = ctx;
    router.setSessionCtx(ctx);
    setProjectLogDir(ctx.cwd);
    try {
      const piAiPath = fileURLToPath(import.meta.resolve('@earendil-works/pi-ai'));
      const providerIds = (ctx.modelRegistry as any).getRegisteredProviderIds?.() ?? [];
      debugLog(`[diag] pi-ai resolved from: ${piAiPath}`);
      debugLog(`[diag] registered providers visible to router: ${[...providerIds].join(', ') || '(none)'}`);
      // F11 (2026-09-02): publish pi's registered provider IDs to the metrics
      // module so stripProvider() recognizes pi-managed providers (pi-claude,
      // claude-bridge, extension providers) the router has no static
      // PROVIDER_MAP entry for. Without this, stripProvider leaves the full
      // 'pi-claude/claude-sonnet-5' ref intact and GDPval/price inference
      // never resolves the model id.
      setPiRegisteredProviders(providerIds);
      // Publish pi's modelRegistry so `lookupPrice()`/`getM()` can read the
      // real `Model.cost` for any pi-registered provider. `Model.cost` is a
      // required field populated from the provider's own /v1/models (e.g.
      // requesty reports `input_price`/`output_price`), so the registry is
      // the authoritative price source — more reliable than the router's own
      // fallbacks (cfg.model_metrics / openrouter_pricing / OR-backfill /
      // cfg.providers), which all silently miss providers Pi registered
      // through other channels (extensions, models.json, CLI flags).
      // Uses the same public `ctx.modelRegistry` API the router already uses
      // for `getAvailable()`/`find()` elsewhere — never reads Pi's setup
      // files directly.
      setModelRegistry((ctx as any).modelRegistry);
    } catch (e) {
      debugLog('[diag] version diagnostics failed:', e);
    }
    load();
    metricsModule.loadModelMap(extDir);
    loadCache();
    // Correlation anchor (review M2): reset ONLY on real user session switches
    // (/new, /resume, /fork) and the FIRST session_start of the process (boot).
    // In-process subagent sessions re-fire session_start with reason 'startup'
    // (pi-subagents child-session.js:287) — resetting there would silently
    // drop the main session's errors from the status count. 'reload' keeps the
    // anchor: the session continues, its errors stay counted.
    const startReason = (ev as any)?.reason;
    if (!sessionAnchorInit || startReason === 'new' || startReason === 'resume' || startReason === 'fork') {
      sessionStart = Date.now();
      sessionAnchorInit = true;
    }
    // Capture pi's setStatus ONLY from a ctx that has it — the MAIN session's
    // interactive TUI. A subagent's headless ctx has no setStatus; overwriting
    // the captured updater there would stall the main session's immediate
    // footer refresh. The count itself is rendered by our own footer part
    // (see setFooter below — our footer REPLACES pi's built-in footer, which is
    // the only renderer of extension statuses, review C1), so setStatus is
    // only the immediate-re-render trigger, not the display path. index.ts is
    // not duplicated by the esbuild double-bundle hazard; the BUFFER state
    // stays in the cache object per project rule.
    if (typeof (ctx.ui as any).setStatus === 'function') {
      statusUpdater = (key: string, text: string) => {
        (ctx.ui as any).setStatus(key, text);
      };
    }
    updateErrorStatusLine();
    
    escalation.reset();
    
    await discoverKeys();

    await registerGroupModels(ctx);
    // scan() swallows per-provider failures by design, but a top-level
    // throw (e.g. from checkScanSanity or saveCache) must not disappear
    // silently (final v1.6.0 review minor #6).
    scan().catch((err) =>
      routerLog(`[scan] background scan failed: ${err instanceof Error ? err.message : String(err)}`)
    );

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
          // Session error counter (review C1): this footer REPLACES pi's
          // built-in footer — the only renderer of ctx.ui.setStatus extension
          // statuses — so the counter MUST be a part here. Same single source
          // of truth as /router errors: entries with ts >= sessionStart.
          const errN = countSessionErrorsSince(cache, sessionStart);
          const errS = errN > 0 ? theme.fg('error', `⚠${errN} err`) : '';

          const sep = theme.fg('dim', ' | ');
          const parts = [rStr];
          if (iStr && tStr) parts.push(`${iStr} ${tStr}`);
          parts.push(tok, el, cwd);
          if (brS) parts.push(brS);
          if (rlS) parts.push(rlS);
          if (errS) parts.push(errS);
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
    // Mark the turn boundary on the router so the first setCurModel() of
    // this turn re-pins the driving ref (a nested delegation stream must
    // not be able to overwrite the pin — see Router.noteTurnStart).
    router.noteTurnStart(turnStart);
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
      // Factual stream ref of THIS turn (review I1): curModel stays the
      // virtual group ref ('standard/standard') in group sessions — keying
      // usage_log by it made the /router cost windows structurally all-zero
      // (getUsage filters by real model refs). getCurModel(turnStart) is the
      // same factual-ref source the expensive-model read block uses; falls
      // back to curModel for non-routed sessions where they coincide.
      const factualRef = router.getCurModel(turnStart) || curModel;
      const a = msg as AssistantMessage;
      const realTok =
        a.usage && typeof a.usage.input === 'number' && typeof a.usage.output === 'number'
          ? a.usage.input + a.usage.output
          : 0;
      const txt =
        typeof msg.content === 'string'
          ? msg.content
          : (msg.content ?? [])
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join('');
      // usage_log basis (review I1): REAL tokens when the provider reported
      // usage (input+output — the old text.length/4 was an output-only
      // approximation that understated the blended-price estimate badly);
      // text/4 remains a last-resort fallback for usage-less messages.
      const tok = realTok > 0 ? realTok : Math.ceil(txt.length / 4);
      if (tok > 0) {
        updateMetrics(factualRef, ms, tok, ms);
        recordOk(factualRef);
        // Log usage
        if (!cache.usage_log) cache.usage_log = [];
        cache.usage_log.push({ ref: factualRef, tokens: tok, ts: Date.now() });
        // Trim log to last 30 days
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        cache.usage_log = cache.usage_log.filter((e) => e.ts > cutoff);
        // Real-token cost tracking (review I2): the old selection-time calls
        // passed hardcoded 1000/500 per request — fabricated data in an audit
        // report. Track once per COMPLETED turn with measured in/out tokens;
        // turns whose provider reported no usage are not tracked at all
        // rather than fabricated.
        if (realTok > 0) {
          costTracker.trackRequest(factualRef, a.usage!.input, a.usage!.output);
        }
      }
    }
  });

  // ── Pre-call read block (shunt Layer 1, ADR-0007 revision 2026-09-20) ──
  // A full-file read (no offset/limit) of a file above delegation.block_lines
  // (default 350, shunt's SHUNT_MIN_LINES) is blocked BEFORE execution and
  // redirected to bulk_read / a targeted read. Fail-open: every miss passes.
  pi.on('tool_call', (ev) => {
    // Layer 1 (ADR-0007 escalation, 2026-09-26): the factual stream ref
    // (set by the stream orchestrator for THIS turn) — not the session's
    // group provider. A fixed-session model that never routed falls back
    // to the session ref (model_select/turn_start).
    //
    // resolveReadBlockStreamRef prefers the turn's PINNED driving ref over
    // the live ref: a nested bulk_reader delegation stream sets the live ref
    // to a cheap ref mid-turn, after which the live ref alone would let the
    // expensive model's own full-file reads pass the block. Both fall back to
    // the session ref; '' (nothing pinned/stale) fails open to size-only.
    const streamRef = resolveReadBlockStreamRef(router, turnStart, curModel);
    // Live membership source (ADR-0007 live fix, 2026-09-26): cfg may be the
    // STATIC config (no materialized model_groups[].models) or a stale scan
    // snapshot — the cfg check alone never matched live and Layer 1 was a
    // no-op (exposed by the HINT group test). getTopModels is the Router's
    // live group resolution (display path, ignores allow-lists) and reflects
    // what can actually drive each expensive group. try/catch → fail-open.
    const block = checkReadBlock(ev, cfg, streamRef, (group) => {
      try {
        const { models } = router.getTopModels(group, 200);
        return (models ?? []).map((m) => m.ref);
      } catch {
        return [];
      }
    });
    if (block) {
      routerLog(
        (block as { expensive?: boolean }).expensive
          ? `[bulk_read] blocked a full-file read by expensive model "${streamRef}" — redirected to bulk_read/targeted read`
          : `[bulk_read] blocked a full-file read of "${(ev as any)?.input?.path}" — redirected to bulk_read/targeted read`
      );
      return block;
    }
    return undefined;
  });

  pi.on('tool_result', async (ev, ctx) => {
    // ── Enforced delegation (ADR-0007, revised 2026-09-20) ──────────────
    // Shrink oversized `read` results with a cheap summarizer (routed via
    // the delegation group — default bulk_reader) BEFORE the main model
    // sees them. Strictly fail-open: undefined → original passes through.
    const replacement = await handleReadDelegation(ev, ctx, cfg, routerLog);
    if (replacement) return replacement;

    // The rate-limit branch that lived here since the initial release
    // (`txt.includes('429')` → recordLimit(curModel), later narrowed to
    // isToolResultRateLimitText) was REMOVED (roborev job 703, finding 1,
    // option a). Tool results are command output — a curl'd 429 from an
    // unrelated host, a failing vitest run printing "rate_limit_exceeded",
    // a subagent child hitting ITS five_hour limit — and none of it is
    // evidence that the CURRENT model is rate-limited, so attributing a
    // hard cooldown + key rotation to it was wrong no matter how narrow
    // the pattern table got. Genuine provider limits arrive as error
    // EVENTS ONLY (isRateLimitText in consumeWithDetection — including
    // pi-claude-bridge's "Claude rate limit …" error events); text_delta is
    // deliberately NOT scanned (87ad663: model prose is never evidence of a
    // rate limit). Pinned by test/tool-result-rate-limit.test.ts.
    // All non-delegation paths intentionally fall through with no replacement.
    return undefined;
  });

  let turns = 0;
  pi.on('turn_end', async () => {
    if (++turns % 10 === 0) saveCache();
  });
  pi.on('session_shutdown', async () => saveCache());

  // ── Tools ──────────────────────────────────────────────────────────────

  // bulk_read (shunt Layer 2, ADR-0007 revision 2026-09-20): question-based
  // multi-file reading via the delegation group. Registered unconditionally;
  // when delegation is disabled the call throws and the model falls back to
  // targeted reads (no load-order trap at registration time).
  pi.registerTool({
    name: 'bulk_read',
    label: 'Bulk Read',
    description:
      'Ask a question about one or more files and get a concise, precise answer WITHOUT loading the file contents into your context. A cheap reader model reads the files (within the delegation size cap) and answers with structured bullets led by exact names, types, and line numbers. Use it for exploration and multi-file questions; use targeted reads (offset/limit) when you need exact lines for an edit.',
    promptSnippet: 'Answer questions about files cheaply via a reader model',
    promptGuidelines: [
      'Use bulk_read with a question and file paths when you need to understand one or more files instead of reading them fully — the raw file content never enters your context.',
    ],
    parameters: Type.Object({
      question: Type.String({ description: 'What to find out about the files' }),
      paths: Type.Array(Type.String(), { description: 'File paths to read and answer from' }),
    }) as any,
    async execute(
      _id: string,
      params: { question: string; paths: string[] },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext
    ) {
      const result = await executeBulkRead(params, ctx, cfg, routerLog);
      return {
        ...result,
        details: { tool: 'bulk_read', files: params.paths.length },
      };
    },
  });

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
      // Persist ONLY the fresh delta into the EMBEDDED config file — never
      // JSON.stringify(cfg). `cfg` here is the layered RUNTIME config
      // (user override → project override →, when present, the regenerated
      // dynamic config with computed groups and the _dynamic marker), while
      // cfgPath is the shipped router-config.json. Writing the runtime cfg
      // here clobbers the embedded defaults with one machine's state: user
      // overrides and computed model_groups leak into the shipped file and
      // from there into every other layer source (final v1.6.0 review I1).
      let base: Record<string, any>;
      try {
        const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new Error('embedded config is not a JSON object');
        }
        base = raw;
      } catch (err) {
        // Unreadable/missing/corrupted/non-object embedded file — REFUSE to
        // write. Persisting a delta-only stub ({ model_metrics: { … } } and
        // nothing else) would replace the shipped defaults (providers,
        // model_groups, exclude, …) with an empty base layer and break every
        // future load() on this install (roborev reviews of e0d8159 and
        // f4a2a3b). Losing one metrics update is strictly the lesser harm.
        routerLog(
          `[router] update_model_metrics: embedded config unusable, refusing to write to avoid clobbering: ${err}`
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `Metrics for ${p.model_ref} were NOT persisted: the embedded router-config.json is unreadable or not a JSON object, and writing would clobber the shipped defaults.`,
            },
          ],
          details: { model_ref: p.model_ref, metrics: e },
        };
      }
      const existingEntry = base.model_metrics?.[p.model_ref] ?? {};
      base.model_metrics = {
        ...(base.model_metrics ?? {}),
        [p.model_ref]: { ...existingEntry, ...e },
      };
      fs.writeFileSync(cfgPath, JSON.stringify(base, null, 2));
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
  skipReasons = new Map<string, string>();

  // Local-stream concurrency limiter helpers (counter is module-global above;
  // limit + predicate need `cfg`, which is in scope here).
  function localStreamLimit(): number {
    return cfg.ollama_max_concurrent_streams ?? OLLAMA_MAX_CONCURRENT_STREAMS;
  }
  function isLocalProvider(ref: string): boolean {
    return ref.startsWith('ollama/') || ref.startsWith('lm-studio/');
  }

  async function tryStream(
    ref: string,
    context: Context,
    options: SimpleStreamOptions | undefined
  ): Promise<{ stream: AssistantMessageEventStream; ref: string } | null> {
    const skip = (reason: string): null => {
      skipReasons.set(ref, reason);
      debugLogOnce(`tryStream-skip:${ref}`, `[diag] tryStream skipped "${ref}": ${reason}`);
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
      // cache.available_models path, and since ADR-0021 nothing registers
      // scan-discovered models at session start, so without this on-demand
      // registration tryStream would skip every free model forever (the
      // observed 'claude-sonnet-5 dominates, GLM unused' symptom: free models
      // silently dropped from the cascade).
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
    forgetDebugOnce(`tryStream-skip:${ref}`);
    debugLog(`[diag] tryStream resolved "${ref}" -> provider=${realModel.provider} id=${realModel.id} api=${(realModel as any).api} baseUrl=${(realModel as any).baseUrl ?? 'n/a'}`);
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
    debugLog(`[diag] tryStream streaming "${ref}" via host runtime`);
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
    stallMs: number,
    ref: string
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
    let userAborted = false; // event.reason === 'aborted' (Ctrl-C or an outer abort signal) — not a model failure
    let accumulatedText = ''; // Accumulate text_delta to check for rate-limit/overflow/repetition text
    let lastRepetitionCheckLen = 0; // Throttle: only re-run the scan once enough new text has arrived
    let truncatedByLength = false; // stopReason 'length' detected (max output tokens hit)
    // Set once the timeout wins the race below. The loop is not cancelled by
    // losing the race — without this flag it kept forwarding the abandoned
    // stream's late events (content, or an 'aborted' terminal once driveStream
    // cancels the candidate) into the proxy, i.e. into the output of the
    // candidate that had already taken over.
    let abandoned = false;
    const iterPromise = (async (): Promise<'done'> => {
      try {
        for await (const event of upstream) {
          if (abandoned) return 'done';
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
            // pi-ai's AssistantMessageEvent contract (types.d.ts) has a stream
            // terminate with `{type:'error', reason:'aborted'|'error', error}`
            // for BOTH a genuine provider fault AND a user/agent-initiated
            // cancellation (e.g. Ctrl-C mid-generation, or an outer abort
            // signal from the caller) — the underlying provider's stream()
            // catches the abort and sets `stopReason: signal?.aborted ?
            // "aborted" : "error"` itself. Without this check, a plain user
            // cancellation on a paid cloud model would fall through to the
            // providerErrorDetected branch below and get escalated to a hard
            // cooldown + key rotation ("likely rate limit") even though
            // nothing was wrong with the provider (roborev job 345 HIGH).
            if ((event as any).reason === 'aborted') {
              userAborted = true;
              // Forward the real event so the caller sees a proper
              // stopReason:'aborted' message — pi-ai's own retry/abort
              // handling already treats this specially (never retried, no
              // cooldown recorded against the model).
              proxy.push(event);
              return 'done';
            }
            // Check if this is a rate limit or subscription error from claude-bridge.
            // pi-ai's openai-completions provider puts the message on
            // `.errorMessage` (the assistant-message shape), not `.message` —
            // check both so this works across provider families.
            const errObj = (event as any).error;
            const errorMsg = String(errObj?.errorMessage || errObj?.message || errObj || '');
            // A provider/transport can also report a client-side or
            // cascade-induced abort as free-text inside an `error` event
            // whose `.reason` is NOT 'aborted' (observed from claude-bridge,
            // which serializes its own AbortError into errorMessage as "This
            // operation was aborted" without setting the structured reason
            // field). Without this check the text falls through to the
            // providerErrorDetected branch below and gets classified as
            // reason:'provider_error', which isPaidCloudRateLimitFailure
            // treated as rate-limit-shaped at the time (it is text-gated
            // since 2026-09-27, but abort text must still never be counted
            // as a provider failure at all) — back then this applied a
            // 2-hour hard cooldown to
            // a model that was never actually rate-limited, just caught in
            // the blast radius of an unrelated crash (F10, 2026-09-02 review:
            // a subagent fanout crashed Ollama, the cascade aborted an
            // in-flight pi-claude/claude-sonnet-5 call, and the router locked
            // Sonnet out of tactical/strategic for 2 hours).
            if (isAbortLikeText(errorMsg)) {
              userAborted = true;
              // Unlike the structured reason:'aborted' case above, this event
              // does NOT already carry the 'aborted' signal (that's the whole
              // point — the provider/transport reported it as free text
              // instead). Normalize it before forwarding so downstream
              // consumers (pi-ai's own retry/abort handling) see the same
              // shape they'd get from a structured abort, instead of a raw
              // error event they might not recognize as a cancellation.
              proxy.push({
                ...(event as any),
                reason: 'aborted',
                error: { ...(errObj as any), stopReason: 'aborted' },
              } as any);
              return 'done';
            }
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
          // NO rate-limit scan on text_delta. The model's own prose is never
          // evidence of a rate limit: the pattern table matches everyday words
          // ('out of', 'exceeded', 'quota', 'credits', 'rate limit'), so any
          // answer that merely talked about limits was killed mid-sentence,
          // discarded and restarted on the next candidate (2026-09-27
          // afternoon: 25 mid-stream kills of paid/subscription models while
          // debugging the router's own limit handling). The scan was also
          // useless for its stated purpose: pi-claude-bridge reports a real
          // Claude limit as an `error` EVENT (errorMessage "Claude rate limit
          // ..."), handled above, and its yellow warning is a piUI.notify UI
          // notification that never enters this stream.
          if (event.type === 'text_delta') {
            const delta = String((event as any).delta || (event as any).text || '');
            accumulatedText += delta;
            // Some providers return overflow rejections as text content rather
            // than as an error event. Detect it so driveStream can emit the
            // native overflow error and trigger Pi compaction instead of hanging.
            // Only at the very start of the answer: such a rejection IS the
            // whole (short) response, whereas a real answer discussing context
            // windows or compaction — this router's own domain — can contain
            // the same phrases much later and must not be killed for it.
            if (accumulatedText.length <= OVERFLOW_TEXT_SCAN_MAX_CHARS && isOverflowDeltaText(accumulatedText)) {
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
          // Intercept the terminal done event to capture the stopReason.
          // pi-ai's stream protocol: done carries reason 'stop' | 'length' |
          // 'toolUse' on the final AssistantMessage. 'length' means max output
          // tokens were hit — the answer is truncated and the task incomplete.
          // Pre-fix this was never inspected: a content-streaming stream that
          // ended cleanly was ALWAYS { ok: true }, so a truncating model
          // (mistral/mistral-small-latest, 2026-09-27: "it just stops, never
          // finishes the task") recorded success and was picked again next
          // turn. Now 'length' is a soft failure so driveStream falls over to
          // the next candidate. The done event is NOT forwarded in that case:
          // forwarding it would terminate the proxy stream and silently drop
          // every later event of the cascade (same pattern as the rate-limit /
          // overflow / repetition early returns above).
          if ((event as any).type === 'done') {
            const doneReason = String((event as any).reason ?? '');
            routerLog(`[stream] ${ref} finished (stopReason: ${doneReason}, ${accumulatedText.length} chars)`);
            if (doneReason === 'length') {
              truncatedByLength = true;
              clearTimer();
              // Stop consuming — don't forward the terminal done event
              return 'done';
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
      abandoned = true;
      // Timeout fired. Two cases share one timer:
      //  - empty_timeout: no content ever arrived (first-token window expired)
      //  - stall_timeout: content started, then the stream went silent for
      //    the full window (mid-stream stall). Both are soft failures that
      //    hand off to the next candidate; stall_timeout just tells the user
      //    a more accurate reason ("stream stalled" vs "no response").
      return { ok: false, reason: hadContent ? 'stall_timeout' : 'empty_timeout' };
    }

    // Stream completed — check if we actually got content or hit a rate limit
    if (userAborted) {
      // User/agent-initiated cancellation, not a model failure — checked
      // before every other classification (highest priority) so an abort
      // can never be misread as a rate-limit/overflow/provider_error and
      // escalated into a cooldown. The real aborted event was already
      // forwarded to the caller above; driveStream must stop the whole
      // cascade here rather than trying the next candidate or recording
      // any failure against this one.
      return { ok: false, reason: 'aborted' };
    }
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

    if (truncatedByLength) {
      // stopReason 'length' means max output tokens hit — answer truncated, task incomplete.
      return { ok: false, reason: 'truncated_length' };
    }

    if (!hadContent) {
      return { ok: false, reason: 'empty_response' };
    }

    return { ok: true };
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
    // Stamped onto every synthetic error AssistantMessage this call produces —
    // must exactly match `model` (Pi's `agent.state.model`), including the
    // `:use-static` suffix on `.id` when present, or Pi's overflow-recovery
    // sameModel check silently fails and auto-compaction never fires.
    const sourceModel: SourceModelInfo = { provider: model.provider, id: model.id, api: model.api };

    if (!isDynamic) {
      const res = resolve(groupName);
      if (!res) throw new Error(`No available models for group "${groupName}"`);
      // fall through with res below
      const proxy = createAssistantMessageEventStream();
      const candidates = [...res.candidates];
      // Cost tracking moved to turn_end (2026-09-27, review I2): the old
      // selection-time call passed hardcoded 1000/500 tokens — fabricated
      // audit data. Only completed turns with REAL provider-reported usage
      // are tracked now.
      streamOrchestrator.driveStream(proxy, candidates, context, options, undefined, groupName, undefined, sourceModel);
      return proxy;
    }

    return streamOrchestrator.groupStream(model, context, options);
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

  async function registerGroupModels(ctx: any) {
    // ADR-0021 (2026-10-02): the router NEVER registers models — or
    // providers — Pi does not already know. This block used to be the
    // scan-union: it resolved keys, round-tripped Pi's own registered models
    // (Ü1 / ADR-0019 field allow-list), and registered the scan-discovered
    // rest under PROVIDER_MAP's api (openai-completions for mistral). That
    // added 29 Mistral models Pi's catalog does not ship — including OCR and
    // audio models registered as chat models — and was the root cause of the
    // Mistral 422 "store" rejections. Pi's registry is the single source of
    // truth for the cloud inventory; the scan now only enriches data
    // (gdpval, pricing, local capabilities) for refs Pi can resolve.
    // Everything that made re-registration "safe" (Ü1 round-trip, roborev
    // 425/426/649 wipes, ADR-0019 non-chat preservation) retired with it.

    // Ollama registration. Ollama defaults to num_ctx=32768 when the request
    // omits options.num_ctx; many models support far more (qwen3.5→262K,
    // gemma4→131K), so prompts >32K truncate unless num_ctx is sent.
    //
    // Per Guardrail 3 + Ü1, this must NOT overwrite an existing Ollama
    // registration: pi-known Ollama models are authoritative and WIN the
    // merge below (their typed fields are round-tripped untouched). num_ctx
    // comes from the REAL capabilities the scan captured live from Ollama's
    // /api/show (see src/ollama-context.ts + src/capabilities.ts) — no
    // hardcoded table, no dependency on any specific Ollama extension.
    //
    // METADATA ONLY (roborev 719, verified against pi-ai 1.0.0 dist): pi-ai
    // never reads a model-level `providerOptions` field at request time —
    // only `samplingParams` reaches the request body. So providerOptions.
    // num_ctx on registered models is FORWARD-COMPAT METADATA (correct
    // values from /api/show for the day pi-ai forwards them), not a runtime
    // knob. What IS load-bearing at runtime is the `contextWindow` field:
    // Pi uses it for compaction, overflow avoidance ('context window
    // 32768 < 35514 tokens needed') and candidate filtering. Ollama's own
    // server-side truncation is governed by OLLAMA_CONTEXT_LENGTH /
    // Modelfile PARAMETER num_ctx — outside the router's reach (owner
    // decision if that ever needs raising).
    //
    // KNOWN LIMITATIONS (roborev 719):
    //   - the registration pins apiKey 'ollama' + http://localhost:11434/v1;
    //     a models.json ollama provider with a DIFFERENT baseUrl/apiKey
    //     would be overridden on the merge path. Accepted: the scan only
    //     ever inventories localhost:11434, so remote/proxy Ollama setups
    //     were never routable through this block anyway.
    //   - once registered, a scan-only model stays registered for the
    //     process lifetime even if it is deleted from Ollama (the next
    //     scan drops it from the cache, but getAll() keeps reporting the
    //     old entry until pi restarts).
    //   - after a merge the extension overlay owns the ollama model list,
    //     so hand-edits to models.json ollama models are masked until the
    //     next pi restart (the overlay wins over the re-read models.json).
    //   - ordering (pre-existing, not introduced here): registerGroupModels
    //     runs at session_start BEFORE the background scan fills the cache,
    //     so on a brand-new machine (no scan cache yet) the FIRST session
    //     registers nothing and Ollama models appear from the second
    //     session onward.
    //
    // GUARD FIX (2026-10-02, owner decision on the defect found during the
    // ADR-0021 investigation): the old guard compared TAGGED scan ids
    // (`gemma4:latest`) against UNTAGGED models.json ids (`gemma4`) with
    // exact find() — it never matched, so the router re-registered Ollama
    // on EVERY session_start (83× in the live log), and because
    // applyExtension drops models.json entries whenever the extension
    // overlay defines `models` (ADR-0019), that re-registration WIPED the
    // user's models.json registration every session.
    //
    // The fix is a MERGE, not a skip and not a replace:
    //   - pi-known Ollama models are round-tripped with their typed fields
    //     and WIN the normalized-id dedup (`gemma4` ≡ `gemma4:latest`;
    //     tagged variants like `gemma4:12b-mlx` stay distinct and are added),
    //   - scan-only models are ADDED with real contextWindow (Pi-side
    //     compaction/overflow correctness) and providerOptions.num_ctx
    //     metadata — this registration is the ONLY source of the user's
    //     classifier models (e.g. `ollama/mistral-nemo:latest`), which live
    //     in neither Pi's catalog nor models.json. Known models are
    //     round-tripped AS-IS (a user-set providerOptions is never
    //     overwritten — roborev 719 found model-level providerOptions
    //     inert in pi-ai 1.0.0, so an enrichment branch would be dead
    //     weight; dropped rather than kept inconsistent),
    //   - if the registry already knows every scanned model, NOTHING is
    //     registered (idempotent — models.json stays the sole overlay).
    try {
      const ollamaModels = (cache.available_models ?? [])
        .filter((m) => m.provider === 'ollama');
      if (ollamaModels.length > 0) {
        // Pi's current Ollama models: models.json and/or a prior
        // registration. getAll() is chat-only (ADR-0019) — fine here:
        // local Ollama models are chat models and Pi ships no builtin
        // ollama catalog with non-chat inventory. find() fallback (over
        // the scanned ids) keeps hosts without getAll() working.
        let piKnownModels: any[] = [];
        try {
          piKnownModels = ((ctx.modelRegistry as any).getAll?.() ?? []).filter(
            (m: any) => m.provider === 'ollama'
          );
        } catch {
          piKnownModels = [];
        }
        if (!piKnownModels.length) {
          // Fallback for hosts without getAll(): try both tagged and
          // untagged variants (the guard-bug fix is normalization-aware,
          // so the fallback must be too — otherwise it regresses to the
          // pre-fix wipe behavior when getAll() is absent).
          for (const m of ollamaModels) {
            const tagged = m.id;
            const untagged = tagged.endsWith(':latest')
              ? tagged.slice(0, -':latest'.length)
              : tagged;
            const found =
              ctx.modelRegistry.find('ollama', tagged) ??
              ctx.modelRegistry.find('ollama', untagged);
            if (found) piKnownModels.push(found);
          }
        }
        // Normalized-id dedup: Ollama resolves an untagged name to
        // `:latest`, so `gemma4` (models.json) and `gemma4:latest` (scan)
        // name the SAME model — the registry version wins (its typed fields
        // are the user's intent). Other tags are genuinely different models.
        const normId = (id: string): string =>
          id.endsWith(':latest') ? id.slice(0, -':latest'.length) : id;
        const knownByNorm = new Map<string, any>();
        for (const m of piKnownModels) knownByNorm.set(normId(m.id), m);
        const newScanModels = ollamaModels.filter((m) => !knownByNorm.has(normId(m.id)));

        if (!piKnownModels.length) {
          // Pi does not know Ollama at all: register the scan inventory
          // with real num_ctx (the original pre-guard-fix behavior).
          const providerModels = buildOllamaProviderModels(ollamaModels);
          (pi as any).registerProvider('ollama', {
            name: 'Ollama (local)',
            baseUrl: 'http://localhost:11434/v1',
            apiKey: 'ollama',
            api: 'openai-completions',
            models: providerModels,
          });
          routerLog(`[router] Registered Ollama with real contextWindow (+ num_ctx metadata) for ${providerModels.length} model(s) (Pi did not know Ollama)`);
        } else if (newScanModels.length > 0) {
          // MERGE: round-trip pi-known models AS-IS (ADR-0019 field
          // allow-list — applyExtension would otherwise drop the
          // models.json entries; a user-set providerOptions is preserved,
          // never enriched/overwritten), then add the scan-only models.
          const existingModels = piKnownModels.map((m: any) => ({
            id: m.id,
            name: m.name,
            ...(m.api !== undefined ? { api: m.api } : {}),
            ...(m.baseUrl !== undefined ? { baseUrl: m.baseUrl } : {}),
            ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
            ...(m.thinkingLevelMap !== undefined ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
            ...(m.input !== undefined ? { input: m.input } : {}),
            ...(m.cost !== undefined ? { cost: m.cost } : {}),
            ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
            ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
            ...(m.headers !== undefined ? { headers: m.headers } : {}),
            ...(m.compat !== undefined ? { compat: m.compat } : {}),
            ...(m.type !== undefined ? { type: m.type } : {}),
            ...(m.output !== undefined ? { output: m.output } : {}),
            ...(m.inputLimits !== undefined ? { inputLimits: m.inputLimits } : {}),
            ...(m.promptCache !== undefined ? { promptCache: m.promptCache } : {}),
            ...(m.samplingParams !== undefined ? { samplingParams: m.samplingParams } : {}),
            ...(m.providerOptions !== undefined ? { providerOptions: m.providerOptions } : {}),
          }));
          const providerModels = [
            ...existingModels,
            ...buildOllamaProviderModels(newScanModels),
          ];
          (pi as any).registerProvider('ollama', {
            name: 'Ollama (local)',
            baseUrl: 'http://localhost:11434/v1',
            apiKey: 'ollama',
            api: 'openai-completions',
            models: providerModels,
          });
          routerLog(`[router] Merged Ollama registration: kept ${existingModels.length} pi-known model(s), added ${newScanModels.length} scan-only model(s)`);
        }
        // else: the registry already knows every scanned model — register
        // NOTHING (pre-fix this re-registered and wiped models.json).
      }
    } catch (e) {
      routerLog('[router] Ollama registration failed:', e);
    }

    // F11 (2026-09-02): refresh the metrics module's view of pi's registered
    // providers after registration. registerGroupModels may have registered
    // the LOCAL Ollama provider, and registerGroupProviders the router's
    // virtual group providers — stripProvider needs to recognize them too.
    // (ADR-0021: no cloud provider is registered here anymore.)
    try {
      const ids = (ctx.modelRegistry as any).getRegisteredProviderIds?.() ?? [];
      setPiRegisteredProviders(ids);
      // Refresh the registry handle too — the registrations above may have
      // added providers whose `Model.cost` we now want to read.
      setModelRegistry((ctx as any).modelRegistry);
    } catch {
      /* registry may not expose getRegisteredProviderIds — leave the existing set */
    }

    // Re-register group providers with updated resolution info
    registerGroupProviders();
  }

  // ── Command: /router ───────────────────────────────────────────────────

  pi.registerCommand('router', {
    description:
      'Model router status. Usage: /router [group|scan|cost|errors [n]|blocklist [clear [ref]]|cooldowns [clear]]',
    getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
      // Sub-command + group name completion (TAB-friendly).
      const subcommands: AutocompleteItem[] = [
        { value: 'scan', label: 'scan', description: 'Re-discover models, re-scrape GDPval, regenerate config' },
        { value: 'cost', label: 'cost', description: 'Cost report: ALL session models (Req/In/Out/Marginal/Tier) + 1d/7d/30d token windows with ≈ blended-price estimate' },
        { value: 'errors', label: 'errors', description: 'Main-session stream failures — headline count matches the status-line ⚠N err exactly' },
        { value: 'errors 30', label: 'errors <n>', description: 'Show up to <n> entries (default 15, max 50)' },
        { value: 'blocklist', label: 'blocklist', description: 'Show models blocked after permanent provider failures' },
        { value: 'blocklist clear', label: 'blocklist clear', description: 'Unblock all models, or one: blocklist clear <provider/model>' },
        { value: 'cooldowns', label: 'cooldowns', description: 'Show active rate-limit cooldowns (ref, remaining, hits)' },
        { value: 'cooldowns clear', label: 'cooldowns clear', description: 'Clear all cooldowns + model-health streaks (incident relief, no restart needed)' },
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
          // costs on demand, and formatCostReport() does NOT reset metrics, so
          // repeated calls keep showing the same accumulating totals.
          //
          // Audit depth (owner decision 2026-09-27 "volle Audittiefe"): ALL
          // session models with Req/In/Out/Marginal/Tier (subscription marked
          // sunk — virtual prices, not real spend) + persistent token windows
          // 1d/7d/30d from usage_log with a blended-price estimate (≈ —
          // usage_log has only total tokens per request; honest labeling).
          ctx.ui.notify(
            costTracker.formatCostReport({
              billingTier: (ref) => metricsModule.billingTier(ref),
              // One pass per window over usage_log (getUsageAll), keyed by the
              // refs that actually have usage — the report shows windows even
              // right after a restart when the session table is empty (I1).
              windowsAll: () => {
                const d1 = metricsModule.getUsageAll(1);
                const d7 = metricsModule.getUsageAll(7);
                const d30 = metricsModule.getUsageAll(30);
                const out: Record<string, { d1: number; d7: number; d30: number }> = {};
                for (const ref of new Set([...Object.keys(d1), ...Object.keys(d7), ...Object.keys(d30)])) {
                  out[ref] = { d1: d1[ref] ?? 0, d7: d7[ref] ?? 0, d30: d30[ref] ?? 0 };
                }
                return out;
              },
              price: (ref) => {
                const p = lookupPrice(ref);
                return p && typeof p.input === 'number' && typeof p.output === 'number'
                  ? { input: p.input, output: p.output }
                  : undefined;
              },
            }),
            'info'
          );
          return;
        }

        if (arg === 'errors' || arg?.startsWith('errors ')) {
          // Counterpart of the status-line ⚠N err (single source of truth:
          // the cache.session_errors ring buffer pushed by
          // recordStreamFailure). Headline count == status-line count by
          // construction; entries from earlier processes appear below the
          // divider (diagnosis context without breaking correlation).
          const m = arg?.match(/^errors\s+(\d+)$/);
          const limit = m ? Math.max(1, Math.min(50, parseInt(m[1], 10))) : 15;
          ctx.ui.notify(formatErrorsReport(cache, sessionStart, limit), 'info');
          return;
        }

        if (arg === 'blocklist') {
          ctx.ui.notify(formatBlocklist(), 'info');
          return;
        }
        if (arg?.startsWith('blocklist clear')) {
          const target = arg.slice('blocklist clear'.length).trim() || undefined;
          const removed = clearBlocklist(cache, target);
          cacheManager.saveCache(cache);
          routerLog(`[router] blocklist cleared manually (${target ?? 'all'}): ${removed} block(s) removed`);
          ctx.ui.notify(
            target
              ? removed ? `Unblocked ${target}.` : `${target} was not blocked.`
              : `Blocklist cleared (${removed} model(s)).`,
            'info'
          );
          return;
        }

        if (arg === 'cooldowns') {
          const active = rateLimitManager.listLimits();
          const health = cache.model_health ?? {};
          const healthEntries = Object.entries(health)
            .filter(([, v]) => v && typeof v.fails === 'number' && v.fails > 0)
            .sort((a, b) => b[1].fails - a[1].fails);
          const lines: string[] = ['Active cooldowns (shortest first):'];
          if (active.length === 0) {
            lines.push('  (none — no model is in cooldown)');
          } else {
            for (const c of active) {
              const reset = c.resetAtMs
                ? ` (provider reset ${new Date(c.resetAtMs).toLocaleTimeString()})`
                : '';
              lines.push(`  • ${c.ref}: ${c.secs}s remaining, ${c.hits} hit(s)${reset}`);
            }
          }
          lines.push('', 'Model-health failure streaks (demotion):');
          if (healthEntries.length === 0) {
            lines.push('  (none — all models healthy)');
          } else {
            for (const [ref, h] of healthEntries) {
              lines.push(`  • ${ref}: ${h.fails} recent fail(s)`);
            }
          }
          ctx.ui.notify(lines.join('\n'), 'info');
          return;
        }
        if (arg?.startsWith('cooldowns clear')) {
          const cleared = rateLimitManager.clearAllLimits();
          const health = cache.model_health;
          let healthCleared = 0;
          if (health) {
            healthCleared = Object.keys(health).length;
            cache.model_health = {};
            cacheManager.saveCache(cache);
          }
          routerLog(
            `[router] cooldowns cleared manually: ${cleared} cooldown(s) + ${healthCleared} model-health streak(s)`
          );
          ctx.ui.notify(
            `Cooldowns cleared (${cleared} cooldown(s), ${healthCleared} health streak(s)). All models are immediately available for routing again.`,
            'info'
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
        const n = 5;
        const { models: topModels, total } = getTopModels(groupName, n);
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

        if (topModels.length === 0 && g.method === 'dynamic') {
          const cats = [
            'code_simple→operational',
            'code_complex→tactical',
            'design→strategic',
            'planning→tactical',
            'exploration→scout',
          ];
          lines.push('│ Routes per prompt via Ollama (gemma2:2b):');
          cats.forEach((c) => lines.push(`│   ${c}`));
        } else if (topModels.length === 0) {
          lines.push('│ (no models configured)');
        } else {
          // Compute max model name width (capped at 38)
          const MW = Math.min(38, Math.max(5, ...topModels.map((t) => t.ref.length)));

          // Table header
          lines.push(
            `│ ${'#'.padEnd(3)} ${'Model'.padEnd(MW)}  ${'GDP'.padStart(4)}  ${'Lat'.padStart(5)}  ${'TPS'.padStart(4)}  ${'Cost I/O'.padStart(11)}  ${'Usage 1d/7d/30d'.padStart(15)}  ${'Budg'.padStart(6)}  Status`
          );
          lines.push(
            `│ ${'─'.padEnd(3)} ${'─'.repeat(MW)}  ${'────'}  ${'─────'}  ${'────'}  ${'───────────'}  ${'───────────────'}  ${'──────'}  ──────`
          );

          for (const { ref, limited, rank } of topModels) {
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
        // Footer: show total count if more than shown
        if (total > n) {
          lines.push(`│    … +${total - n} weitere (sortiert nach ${g.method})`);
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

      // Refused automatic scan (scan sanity check 3)
      const refusal = cache.scan_sanity_refusal;
      if (refusal) {
        lines.push('├─ Scan '.padEnd(72, '─'));
        lines.push(
          `│ ⚠ last automatic scan refused: ${refusal.survivors} models vs ${refusal.previous} before. ` +
            'Accepted if a settled scan agrees; /router scan accepts it now.'
        );
      }

      // Local-provider watchdog (ADR-0016)
      for (const [provider, h] of Object.entries(cache.local_provider_health ?? {})) {
        if (!isProviderWedged(cache, provider)) continue;
        const secs = Math.ceil(((h.wedged_until ?? 0) - Date.now()) / 1000);
        lines.push('├─ Local provider watchdog '.padEnd(72, '─'));
        lines.push(`│ ⚠ ${provider} looks wedged — skipped for ${secs}s. Fix: ${wedgeFixHint(provider)}.`);
      }

      // Learned blocklist summary (details: /router blocklist)
      const blocked = activeBlocks(cache);
      if (blocked.length) {
        lines.push('├─ Blocked (permanent provider failures) '.padEnd(72, '─'));
        lines.push(`│ 🚫 ${blocked.length} model(s) — see /router blocklist`);
      }

      lines.push('└' + '─'.repeat(71));
      lines.push('', '/router <group> | scan | cost | blocklist');
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
  // Signal handlers (final v1.6.0 review minor #10): previously a bare
  // process.exit(0) skipped pi's graceful shutdown, so the session_shutdown
  // saveCache() never ran on Ctrl-C. Persist synchronously before exiting
  // (best-effort), and dedupe the registration per process — the file's own
  // comments note the esbuild double-bundle hazard, which would otherwise
  // stack one handler per extension load.
  if (!(globalThis as any).__ROUTER_SIGNAL_CLEANUP__) {
    (globalThis as any).__ROUTER_SIGNAL_CLEANUP__ = true;
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
