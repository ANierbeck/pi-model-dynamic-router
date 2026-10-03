/**
 * Dynamic config generation, extracted from index.ts (refactor plan
 * 2026-10-02, task 5): generateDynamicConfigNow — the SNAPSHOT writer that
 * builds router-config.dynamic.json from the scanned model set + static
 * config — together with its serialized() wrapper generateDynamicConfig.
 * Per the plan, the cfg swap (cfg = dynamicCfg, manager rebuilds, Router
 * rebuild) stays live through accessors/setters on rt, so reloads remain
 * visible to every other module. Pure code motion.
 */

import { DiscoveryManager } from './discovery.ts';
import { buildStaticFreeModelsLookup, buildModelsWithMetadata, collapseSameSlugClusters, filterModelsForGroup, sortModelsForGroup, collectGroupModels, computeFallbackGroups, DYNAMIC_CONFIG_RESYNC_KEYS } from './dynamic-config.ts';
import { type ExcludeContext, isExcluded } from './exclude.ts';
import { routerLog, errorLog } from './logger.ts';
import * as metricsModule from './metrics.ts';
import { lookupGdp } from './metrics.ts';
import { PROVIDER_MAP } from './providers.ts';
import { isVirtualGroupRef, Router } from './routing.ts';
import { checkScanSanity } from './scan-sanity.ts';
import { isStreamableRef } from './streamable-refs.ts';
import type { Config, Cache } from './types.ts';
import { serialized } from './utils.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CacheManager } from './cache.ts';
import type { RateLimitManager } from './rate-limit.ts';

/**
 * Dependencies createDynamicConfigRunner reads from index.ts's extension closure. Exposed as
 * live accessors (getters, plus setters for state the moved code writes), so
 * every read sees the CURRENT closure value — index.ts reassigns cfg/router/
 * managers on reload, and a captured copy would go stale.
 */
interface DynamicConfigRunnerDeps {
  readonly cache: Cache;
  readonly cacheManager: CacheManager;
  cfg: Config;
  discoveryManager: DiscoveryManager;
  readonly dynamicConfigFingerprint: (c: Config) => string;
  readonly populateLlmMatches: (allModelRefs: string[]) => Promise<void>;
  readonly rateLimitManager: RateLimitManager;
  router: Router;
  readonly routerStartedAt: number;
  readonly SCAN_REFUSAL_MAX_AGE_MS: number;
  readonly scanning: boolean;
  readonly sessionCtx: any;
  settleRetryScheduled: boolean;
  readonly stateDir: string;
  readonly staticCfg: Config;
  readonly turnStart: number;
}

export function createDynamicConfigRunner(rt: DynamicConfigRunnerDeps) {
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
   *
   * Runs are serialized: a generation awaits an LLM call (populateLlmMatches),
   * and two overlapping runs (a scan and the settled re-check) would both
   * write router-config.dynamic.json and the cache, the slower one last.
   */
  const generateDynamicConfig = serialized((force: boolean = false) => generateDynamicConfigNow(force));

  async function generateDynamicConfigNow(force: boolean): Promise<void> {
    try {
      // Models Pi has already registered (e.g. via providers without PROVIDER_MAP entry
      // like claude-bridge) — so they still qualify as routing candidates.
      const registryRefs: string[] = [];
      if (rt.sessionCtx?.modelRegistry) {
        for (const m of rt.sessionCtx.modelRegistry.getAvailable()) {
          registryRefs.push(`${m.provider}/${m.id}`);
        }
      }

      // With dynamic model discovery, we always consider all registry models as valid.
      // No need to check against static group model lists anymore.
      // Always regenerate if cache is invalid or force is true.
      const hasNewRegistryRefs = false;

      // lastScanTimestamp is only set after a dynamic config was written, so a
      // valid cache with no config file means the file was lost (e.g. dist/
      // was recreated) — regenerate instead of running on the static config
      // for up to 30 days. `dynamic_config_expected: false` marks caches that
      // never had one (test fixtures).
      const dynamicConfigMissing =
        !fs.existsSync(path.join(rt.stateDir, 'router-config.dynamic.json')) &&
        rt.cache.dynamic_config_expected !== false;
      if (!force && !hasNewRegistryRefs && rt.cacheManager.isScanCacheValid(rt.cache) && !dynamicConfigMissing) {
        routerLog('[router] Scan cache is still valid (max 30 days old), skipping regeneration');
        return;
      }
      if (!force && dynamicConfigMissing && rt.cacheManager.isScanCacheValid(rt.cache)) {
        routerLog('[router] Scan cache is valid but router-config.dynamic.json is missing — regenerating it');
      }
      
      // 1. Get all available models (from cache)
      const scannedModels = rt.cache.available_models ?? [];
      
      // 2. Load STATIC free_models from config (important for free models!)
      // These models are NOT scanned but taken directly from router-config.json
      const { staticFreeModels, staticFreeModelsLookup } = buildStaticFreeModelsLookup(rt.staticCfg);
      
      // 2b. Combine all models: static free_models + scanned models + registry refs
      // (group models are now resolved dynamically from allDiscoveredRefs(), no longer static)
      const allModelRefs = [...new Set([
        ...staticFreeModels,
        ...scannedModels.map(m => `${m.provider}/${m.id}`),
        ...registryRefs,
      ])];
      
      if (!allModelRefs.length) {
        routerLog('[router] No models available, skipping dynamic config generation');
        return;
      }

      // 2b2. Diagnostics (2026-09-26): surface unpriced models. An 'unknown'
      // effCost can no longer flip min_cost_if_all_priced groups onto
      // best-gdpval ordering (sortByMinCostIfAllPriced fix), but unpriced
      // models still weaken cost gates and confuse cost-based sorting —
      // log them so pricing can be added (config, model-map, registry) or
      // the model excluded.
      // Exclude the router's own virtual group-provider models from the
      // cost diagnostics: their registry cost is {0,0} (→ null → 'unknown'),
      // so without this filter the "unknown cost" log would list routing
      // artefacts like 'trivial/trivial' that the user can neither price nor
      // exclude. Same predicate as allDiscoveredRefs() (routing.ts).
      const groupNames = new Set(Object.keys(rt.cfg.model_groups));
      const diagnosticRefs = allModelRefs.filter((r) => !isVirtualGroupRef(r, groupNames));
      const unknownCostRefs = metricsModule.collectUnknownCostRefs(diagnosticRefs);
      if (unknownCostRefs.length) {
        routerLog(
          `[scan] ${unknownCostRefs.length} model(s) with unknown cost: ` +
            `${unknownCostRefs.slice(0, 20).join(', ')}${unknownCostRefs.length > 20 ? ' …' : ''}`
        );
      }

      // 2c. Apply global exclusion rules (personalized support list).
      // Excludes providers, model patterns, and paid models from certain
      // providers — applying to ALL groups, before scoring.
      let effectiveModelRefs = allModelRefs;
      if (rt.staticCfg.exclude) {
        const exCtx: ExcludeContext = { rules: rt.staticCfg.exclude, cfg: rt.cfg, cache: rt.cache };
        const excluded: string[] = [];
        effectiveModelRefs = allModelRefs.filter((ref) => {
          if (isExcluded(ref, exCtx)) { excluded.push(ref); return false; }
          return true;
        });
        if (excluded.length) {
          routerLog(`[router] Exclude rules removed ${excluded.length} model(s): ${excluded.slice(0, 15).join(', ')}${excluded.length > 15 ? ' ...' : ''}`);
        }
      }

      // 2d. Streamability filter (2026-09-20 ghost-model incident): the
      // pool above merges scan-cache refs directly, so stale entries for
      // providers pi no longer serves (mistral-zai/* with fake $0.0 scan
      // placeholders) flowed straight into the generated group configs —
      // where the ghost (best GDPval, $0.0) won every cost-sorted group and
      // then failed at stream time. A ref may only be persisted if it can
      // actually stream: resolvable in pi's registry, served by a local
      // runtime, or explicitly listed as a free model in the config.
      // Fail-open: when no registry is available (e.g. degraded headless
      // runs), keep the previous behavior instead of emptying the pool.
      if (rt.sessionCtx?.modelRegistry) {
        const before = effectiveModelRefs.length;
        const freeModelRefs = new Set<string>(staticFreeModels);
        const streamableCtx = {
          hasRegistryModel: (provider: string, modelId: string) =>
            metricsModule.hasRegistryModel(provider, modelId),
          isLocalProvider: (provider: string) =>
            PROVIDER_MAP[provider]?.local === true,
          freeModelRefs,
        };
        effectiveModelRefs = effectiveModelRefs.filter((ref) =>
          isStreamableRef(ref, streamableCtx)
        );
        const dropped = before - effectiveModelRefs.length;
        if (dropped > 0) {
          routerLog(`[router] Streamability filter removed ${dropped} unstreamable model ref(s) (not in pi's registry, not local, not configured free models)`);
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
        if (!PROVIDER_MAP[prov] && !rt.cfg.providers?.[prov]) {
          (rt.cfg.providers ??= {})[prov] = { billing: 'subscription' };
        }
      }
      
      // 4. Enrich the models with GDPval and cost
      // All models are now dynamic, no separate static models
      const staticModelRefs = new Set([...staticFreeModels]);

      // 4a. LLM-assisted matching for models the model-map + token-fallback can't
      // resolve (e.g. vendor-prefixed ids like "mistral-zai/zai-glm-5-2" whose
      // token set {zai,glm,5,2} doesn't equal the gdpval slug's {glm,5,2}).
      // Runs ONCE per scan (not per prompt) and results are cached. Fail-open:
      // if no local/cloud LLM is available, matching silently degrades to the
      // existing two-tier fallback and unscored models are logged + dropped.
      await rt.populateLlmMatches(effectiveModelRefs);

      const modelsWithMetadata = buildModelsWithMetadata(effectiveModelRefs, rt.cfg, staticFreeModelsLookup, staticModelRefs);
      
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
      // Compare against the snapshot on disk (check 3), unless the user forced
      // this scan (/router scan) to accept whatever it finds.
      const configFingerprint = rt.dynamicConfigFingerprint(rt.staticCfg);
      let previousSurvivorCount: number | undefined;
      let configChanged = false;
      try {
        const prevPath = path.join(rt.stateDir, 'router-config.dynamic.json');
        if (!force && fs.existsSync(prevPath)) {
          const prev = JSON.parse(fs.readFileSync(prevPath, 'utf-8'))?._dynamic;
          if (typeof prev?.model_count === 'number') previousSurvivorCount = prev.model_count;
          if (typeof prev?.config_fingerprint === 'string') configChanged = prev.config_fingerprint !== configFingerprint;
        }
      } catch {
        // Unreadable previous snapshot: nothing to protect.
      }
      const sanity = checkScanSanity({
        scannedRefs: effectiveModelRefs,
        survivorRefs: modelsWithMetadata.map((m) => m.ref),
        explicitlyMappedRefs,
        explicitlyMappedScoredRefs,
        ...(previousSurvivorCount !== undefined ? { previousSurvivorCount } : {}),
        configChanged,
      });
      // A regression refusal that repeats with the same smaller result is a
      // real shrink (provider removed, key revoked, catalogue change), not a
      // start-up race: accept it instead of refusing on every session.
      const prevRefusal = rt.cache.scan_sanity_refusal;
      const settleMs = rt.staticCfg.scan_settle_ms ?? 60_000;
      const elapsed = Date.now() - rt.routerStartedAt;
      const settled = elapsed >= settleMs;
      const sameAsLastRefusal =
        sanity.check === 'regression' &&
        settled &&
        prevRefusal !== undefined &&
        Date.now() - prevRefusal.at < rt.SCAN_REFUSAL_MAX_AGE_MS &&
        Math.abs(prevRefusal.survivors - sanity.survivorCount) <= Math.max(1, Math.round(prevRefusal.survivors * 0.1));
      if (sameAsLastRefusal) {
        routerLog(
          `[router] Scan sanity: a settled scan returned the same smaller result (${sanity.survivorCount} models) — accepting it as real`
        );
      }
      if (!sanity.ok && !sameAsLastRefusal) {
        routerLog(
          `[router] Scan sanity check FAILED, refusing to persist dynamic config: ${sanity.reason}`
        );
        if (sanity.check === 'regression') {
          rt.cache.scan_sanity_refusal = {
            survivors: sanity.survivorCount,
            previous: previousSurvivorCount ?? 0,
            at: Date.now(),
          };
          rt.cacheManager.saveCache(rt.cache);
          // Re-check once the registry has certainly settled: a real shrink is
          // then accepted within this session, a start-up race is replaced by
          // the full result.
          if (!settled && !rt.settleRetryScheduled) {
            rt.settleRetryScheduled = true;
            // A scan running by then decides on its own; skip the re-check.
            const timer = setTimeout(() => {
              if (!rt.scanning) void generateDynamicConfig(false);
            }, settleMs - elapsed);
            timer.unref?.();
          }
        }
        // Deliberately do NOT bump cache.lastScanTimestamp here —
        // leaving it unset (or stale) means the next session/scan retries
        // instead of freezing this broken snapshot for up to 30 days. Any
        // existing router-config.dynamic.json on disk is left untouched
        // (better a previous good snapshot than a freshly broken one); if
        // none exists, load() falls back to staticCfg, which resolves groups
        // via live discovery (verified safe).
        return;
      }

      if (rt.cache.scan_sanity_refusal) {
        delete rt.cache.scan_sanity_refusal;
        rt.cacheManager.saveCache(rt.cache);
      }

      routerLog(`[router] Generating dynamic config with ${modelsWithMetadata.length} models (${staticFreeModels.length} free models)`);

      // Collapse same-provider slug clusters ONCE, before the per-group
      // filters: the cost gates must see the canonical cluster
      // representative, not whichever fake-priced alias survives them
      // (2026-09-20 — see collapseSameSlugClusters).
      const clusterRepModels = collapseSameSlugClusters(modelsWithMetadata);

      // 5. Generate the dynamic group configuration
      const dynamicGroups: Record<string, any> = {};
      
      for (const [groupName, groupConfig] of Object.entries(rt.staticCfg.model_groups)) {
        // Skip dynamic group (handled separately)
        if (groupConfig.method === 'dynamic') {
          dynamicGroups[groupName] = groupConfig;
          continue;
        }
        
        // 6. Filter models by the group's criteria
        //
        // Same gate rules as the live and display paths (applyGroupFilters,
        // ADR-0010), fed with the per-model values computed above.
        let filteredModels = filterModelsForGroup(clusterRepModels, groupConfig, rt.cfg);
        
        // 7. Sort the models according to the group's method
        let sortedGroupModels = sortModelsForGroup(filteredModels, groupConfig, groupName, rt.cfg, metricsModule.calculateScore);
        
        // 8. Collect models: static first (highest priority), then dynamic additions
        const finalModels = collectGroupModels(groupConfig, filteredModels, sortedGroupModels, rt.cfg);
        const originalModels = groupConfig.models ?? [];
        
        // Debug logging
        if (groupName === 'trivial' || groupName === 'simple') {
          routerLog(`[router] Group ${groupName}: ${finalModels.length} models (${originalModels.length} static, ${filteredModels.length} dynamic)`);
          routerLog(`[router]   Models: ${finalModels.slice(0, 5).join(', ')}...`);
        }
        
        // Build the dynamic group configuration
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

      // 10. Persist the dynamic configuration.
      // IMPORTANT: the object literal still spreads from `cfg` (which may be a
      // stale dynamic config), NOT from staticCfg — only the user-intent keys
      // (DYNAMIC_CONFIG_RESYNC_KEYS, shared with load()'s read-site re-sync)
      // are forced explicitly from staticCfg, so the regenerated file never
      // persists a stale user value for another 30-day cycle. staticCfg is
      // the layered config (defaults + user override) and therefore the
      // single source of truth for those fields.
      const dynamicConfig = {
        ...rt.cfg,
        model_groups: dynamicGroups,
        _dynamic: {
          generated_at: new Date().toISOString(),
          source: 'router scan',
          model_count: modelsWithMetadata.length,
          base_config: 'router-config.json',
          free_models_count: staticFreeModels.length,
          scanned_models_count: scannedModels.length,
          config_fingerprint: configFingerprint,
        }
      };
      for (const key of DYNAMIC_CONFIG_RESYNC_KEYS) {
        (dynamicConfig as any)[key] = rt.staticCfg[key];
      }

      const dynamicConfigPath = path.join(rt.stateDir, 'router-config.dynamic.json');
      fs.writeFileSync(dynamicConfigPath, JSON.stringify(dynamicConfig, null, 2));

      // Update in-memory cfg immediately so the new fallback_groups and model lists
      // are available for the current session without requiring a restart.
      // Delegation (and every other DYNAMIC_CONFIG_RESYNC_KEYS entry, among
      // them delegation — user intent per the ADR-0007 revision) was already
      // re-synced from staticCfg by the loop above; no special case remains.
      rt.cfg = dynamicConfig as Config;
      // A mid-turn scan (a tool calling load()) replaces the Router, which
      // would drop both curModel and the turn's pinned driving ref — leaving
      // the expensive-model read block un-protected for the rest of the turn.
      // Carry the pin (and the turn boundary) over to the new instance.
      const carriedTurnDriver = rt.router.getTurnDriverRef(rt.turnStart);
      const carriedTurnBoundary = rt.turnStart;
      rt.router = new Router(rt.cfg, rt.cache, rt.rateLimitManager.getLimits());
      if (carriedTurnBoundary > 0) rt.router.noteTurnStart(carriedTurnBoundary);
      rt.router.adoptTurnDriverRef(carriedTurnDriver);
      // streamOrchestrator.ctx.router is now a live getter (see
      // buildOrchestratorContext) that always reads this module-level `router`
      // binding, so no explicit resync is needed here anymore — and assigning
      // to it would throw (getter-only accessor).
      if (rt.sessionCtx) rt.router.setSessionCtx(rt.sessionCtx);
      metricsModule.setConfig(rt.cfg);
      rt.discoveryManager = new DiscoveryManager(rt.cfg, rt.cache);

      // Set the timestamp of the last scan
      // Write through the router's own cache object: the manager's internal
      // copy can be stale and would overwrite fresh scan data (review 2026-09-27).
      rt.cache.lastScanTimestamp = Date.now();
      rt.cacheManager.saveCache(rt.cache);

      routerLog(`[router] Dynamic configuration generated: ${dynamicConfigPath}`);
      
    } catch (error) {
      errorLog('[router] Error generating dynamic configuration:', error);
    }
  }

  return { generateDynamicConfig };
}
