/**
 * Model scan pipeline, extracted from index.ts (refactor plan
 * 2026-10-02, task 4): populateLlmMatches (LLM-based gdpval matching for
 * unscored refs), extractGdpvalScores (Artificial Analysis
 * HTML/JSON), fetchJson, and scan() itself. cfg/scanning are reached as
 * live accessors — the plan's 'cfg passed as a getter' rule. Pure code
 * motion; function bodies unchanged.
 */

import { extractCapabilities } from './capabilities.ts';
import { probeAndCache } from './classifier-fallback-probe.ts';
import { type LocalLlmDeps, callLocalLlm } from './local-llm.ts';
import { routerLog } from './logger.ts';
import * as metricsModule from './metrics.ts';
import { isPlausibleMatch, type GdpvalEntry, matchModelsWithLLMBatched } from './model-matcher.ts';
import { estimateOllamaModelsGdpvalAsSlugs } from './ollama-gdpval.ts';
import { redundantAliasProviders, pruneRedundantCacheEntries } from './provider-shadow.ts';
import { PROVIDER_MAP } from './providers.ts';
import type { Cache, ModelCapabilities, Config } from './types.ts';
import type { CacheManager } from './cache.ts';

/**
 * Dependencies createScanRunner reads from index.ts's extension closure. Exposed as
 * live accessors (getters, plus setters for state the moved code writes), so
 * every read sees the CURRENT closure value — index.ts reassigns cfg/router/
 * managers on reload, and a captured copy would go stale.
 */
export interface ScanRunnerDeps {
  readonly cache: Cache;
  readonly cacheManager: CacheManager;
  readonly cfg: Config;
  readonly GDPVAL_URL: string;
  readonly generateDynamicConfig: (force?: boolean | undefined) => Promise<void>;
  readonly MODELS_TTL: number;
  readonly resolveKeyValue: (key: string) => string;
  readonly saveCache: () => void;
  scanning: boolean;
  readonly sessionCtx: any;
}

export function createScanRunner(rt: ScanRunnerDeps) {
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
    const cachedMatches = rt.cache.model_score_cache ?? {};
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
      cache: rt.cache,
      cfg: rt.cfg,
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
      rt.cache.model_score_cache = merged;
      rt.cacheManager.saveCache(rt.cache);
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

  // fmt/fmtTime: delegate to utils.ts, the single implementation.

  // ── Scan (GDPval forever, models 24hr) ─────────────────────────────────

  /**
   * Extract GDPval scores from Artificial Analysis HTML
   * Tries JSON data first (modern), falls back to HTML table parsing
   */
  function extractGdpvalScores(html: string): Record<string, number> {
    const scores: Record<string, number> = {};

    // Stage 1 (Format A, 2025+): RSC payload uses {"label":"Model Name",
    // "gdpvalAaElo":[{"@type":"PropertyValue","name":"mid","value":N},...],
    // "detailsUrl":"/models/slug"}.  detailsUrl gives the slug directly.
    const entryRe = /\{"label":"([^"]+)","gdpvalAaElo":\[[^\]]*"name":"mid","value":([\d.]+)[^\]]*\],"detailsUrl":"\/models\/([^"]+)"\}/g;
    let em;
    while ((em = entryRe.exec(html))) {
      const label = em[1];
      const score = parseFloat(em[2]);
      const slug = em[3];
      scores[slug] = score;
      const labelKey = label.toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      if (labelKey && labelKey !== slug) scores[labelKey] = score;
    }

    // Stage 2 (Format B): AA also embeds the full sorted leaderboard as
    // {"id":"...","displayName":"Model Name","creator":{...},"elo":N,...}.
    // No detailsUrl here — we look up the slug by matching displayName against
    // the model-list JSON that lives in the same RSC payload:
    //   {"slug":"glm-5-2","name":"GLM-5.2 (max)",...}
    // We build the displayName→slug table once and reuse it for all entries.
    // The HTML embeds JSON with HTML-escaped quotes (" → \"), so we normalise
    // to plain JSON before parsing.
    const normalized = html.replace(/\\"/g, '"');
    const slugByDisplayName = new Map<string, string>();
    const slugRe = /"slug":"([^"]+)","name":"([^"]+)"/g;
    let s;
    while ((s = slugRe.exec(normalized))) {
      slugByDisplayName.set(s[2], s[1]);
    }

    // Format B: {"id":"...","displayName":"...","creator":{...},"elo":N,...}
    // Stop at the first closing brace so that nested creator objects don't break
    // the regex.
    const eloRe = /\{"id":"[^"]+","displayName":"([^"]+)","creator":\{[^}]+\},"elo":([0-9.]+),"confidenceInterval":/g;
    while ((em = eloRe.exec(normalized))) {
      const displayName = em[1];
      const score = parseFloat(em[2]);
      // Look up slug: exact displayName match first, then label-key match
      // (strips parenthetical suffix like "(max)").
      let slug = slugByDisplayName.get(displayName);
      if (!slug) {
        const labelKey = displayName.toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        for (const [dn, sv] of slugByDisplayName) {
          const dnKey = dn.toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
          if (dnKey === labelKey) { slug = sv; break; }
        }
      }
      if (slug) {
        scores[slug] = score; // Format B is authoritative for the full leaderboard
        const labelKey = displayName.toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        if (labelKey && labelKey !== slug) scores[labelKey] = score;
      }
    }

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
   * dynamic group config). ADR-0021: the router no longer registers
   * scan-discovered models with Pi — Pi's registry is the single source of
   * truth for the cloud inventory; scan data only enriches refs Pi already
   * resolves (plus the local Ollama/LM Studio inventory).
   *
   * PER-MODEL CAPABILITIES (resolved architecture problem B1): each provider's
   *   /v1/models response is parsed for real capabilities via
   *   src/capabilities.ts (Mistral `capabilities.vision/reasoning`/
   *   `max_context_length`, OpenRouter `architecture.input_modalities`/
   *   `context_length`). For Ollama, /api/show is fetched per model (parallel,
   *   bounded) to get `model_info.*.context_length` + the capabilities array —
   *   setup-independent (no hardcoded table, no dependency on any specific
   *   Ollama extension). Results land in cache.available_models[].capabilities
   *   (see AvailableModel/ModelCapabilities types) and flow through to the
   *   LOCAL registration in registerGroupModels (Ollama only, kept per
   *   ADR-0021: Pi has no live local-discovery mechanism; LM Studio was
   *   never registered), which registers with the real values instead of
   *   the old hardcoded blanket.
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
    if (rt.scanning) return;
    rt.scanning = true;
    try {
      if (!rt.cache.gdpval_scraped || force) {
        try {
          const res = await fetch(rt.GDPVAL_URL, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(30_000),
          });
          const html = await res.text().then((h) => h.replace(/\\"/g, '"'));
          const scores = extractGdpvalScores(html);

          if (Object.keys(scores).length) {
            metricsModule.setGdpval(scores);
            rt.cache.gdpval_scores = metricsModule.getGdpval();
            rt.cache.gdpval_scraped = true;
          } else {
            routerLog('[scan] No GDPval scores extracted - table regex may be outdated');
          }
        } catch (err) {
          /* scrape failed, use builtins */
          routerLog(`[scan] GDPval scrape failed (${err instanceof Error ? err.message : String(err)}); using builtins only`);
        }
      }
      const age = rt.cache.models_cached
        ? Date.now() - new Date(rt.cache.models_cached).getTime()
        : Infinity;
      // Also rescan if any configured provider has keys but zero models cached
      const missingProviders = Object.entries(rt.cfg.providers ?? {}).some(
        ([p, pc]) =>
          pc.keys?.length && !(rt.cache.available_models ?? []).some((m) => m.provider === p)
      );
      if (force || age > rt.MODELS_TTL || missingProviders) {
        const models: Cache['available_models'] = [];
        if (rt.cfg.providers?.chutes?.keys?.length) {
          try {
            const d = await fetchJson('https://llm.chutes.ai/v1/models');
            const pricing = rt.cache.openrouter_pricing ?? {};
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
            rt.cache.openrouter_pricing = pricing;
          } catch {}
        }
        if (rt.cfg.providers?.openrouter?.keys?.length) {
          try {
            const d = await fetchJson('https://openrouter.ai/api/v1/models', { timeoutMs: 25_000 });
            const pricing: Record<string, { input: number; output: number }> =
              rt.cache.openrouter_pricing ?? {};
            for (const m of d.data ?? []) {
              const caps = extractCapabilities('openrouter', m);
              if (String(m.pricing?.prompt ?? '1') === '0')
                models.push({ id: m.id, provider: 'openrouter', cost_per_m: 0, ...(caps ? { capabilities: caps } : {}) });
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
            rt.cache.openrouter_pricing = pricing;
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
            rt.cache.gdpval_scores = rt.cache.gdpval_scores ?? {};
            for (const [slug, score] of Object.entries(ollamaGdpvalEstimates)) {
              // Don't overwrite an existing authoritative score
              if (rt.cache.gdpval_scores[slug] === undefined) {
                rt.cache.gdpval_scores[slug] = score;
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
            metricsModule.setCache(rt.cache);
          }
        } catch {}
        // Scan direct API providers with modelsUrl (anthropic, openai, etc.)
        // Generic (Ü1-consistent): skip providers Pi already knows.
        // If Pi knows a provider from models.json, an extension, or natively,
        // the router doesn't need to scan it — that would only create
        // duplicates in cache.available_models (e.g. mistral-zai with 46
        // identical models like mistral). Since ADR-0021 the router registers
        // no scan-discovered cloud models anyway (Pi's catalog is the source
        // of truth), so scanning a Pi-served provider produces only inert
        // cache entries. So: don't scan.
        const piKnownProviders = new Set<string>();
        if (rt.sessionCtx?.modelRegistry) {
          try {
            for (const model of rt.sessionCtx.modelRegistry.getAvailable()) {
              piKnownProviders.add(model.provider);
            }
          } catch {}
        }
        // Alias-shadow rule (2026-09-20 ghost-model incident, generic per
        // Leitplanke 1): a provider whose `pricingAlias` target pi already
        // serves duplicates pi's catalog under a router-internal key — and
        // its scan entries carry `cost_per_m: 0` PLACEHOLDERS that pollute
        // the cache and its diagnostics (before ADR-0021 they even got baked
        // into Pi's registry as real prices by the scan-union registration).
        // Keep the ghost entries out of the cache entirely. Never scan
        // shadowed alias providers.
        const redundantProviders = redundantAliasProviders(PROVIDER_MAP, piKnownProviders);
        const providerScans = Object.entries(PROVIDER_MAP)
          .filter(([, def]) => def.modelsUrl && def.authHeader)
          .filter(([provId]) => !piKnownProviders.has(provId) && !redundantProviders.has(provId))
          .map(async ([provId, def]) => {
            const keys = rt.cfg.providers?.[provId]?.keys;
            if (!keys?.length) return;
            // Optional per-provider model filter (B2): a provider whose key sees
            // a broad catalog can be constrained to a subset via a regex in
            // PROVIDER_MAP. Generic, user-configurable — not a hardcoded
            // special case (per Leitplanke 1). Empty/absent = keep all.
            const filterRe = def.modelFilter ? new RegExp(def.modelFilter, 'i') : null;
            // Try each key until one succeeds (first may be stale)
            for (let ki = 0; ki < keys.length; ki++) {
              try {
                const key = rt.resolveKeyValue(keys[ki].key);
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
        // Prune stale entries of shadowed alias providers even when THIS scan
        // pass found nothing (all fetches failing must not keep ghosts alive).
        // Pure cache hygiene — runs on every completed scan pass.
        rt.cache.available_models = pruneRedundantCacheEntries(
          rt.cache.available_models ?? [],
          redundantProviders
        );
        if (models.length) {
          // Merge: keep existing entries for providers not scanned (or whose scan failed).
          const scannedProviders = new Set(models.map((m) => m.provider));
          const kept = (rt.cache.available_models ?? []).filter(
            (m) => !scannedProviders.has(m.provider)
          );
          rt.cache.available_models = [...kept, ...models];
          rt.cache.models_cached = new Date().toISOString();
        }
      }
      rt.saveCache();

      // Probe classifier-fallback candidates and cache the quality-verified
      // list. Runs after the scan saves (so cache.available_models is fresh)
      // and before generateDynamicConfig. The probe is bounded (max 20
      // candidates, 15s timeout per classification case — 3 cases per
      // candidate, stops at 8 successes) and non-fatal —
      // if it fails the classifier falls back to selectClassifierCandidates +
      // the try-each loop at classification time. See
      // src/classifier-fallback-probe.ts.
      try {
        const registry = rt.sessionCtx?.modelRegistry as any;
        if (registry?.runtime?.completeSimple) {
          await probeAndCache(rt.cfg, rt.cache, {
            findModel: (ref: string) => {
              const i = ref.indexOf('/');
              if (i === -1) return undefined;
              return registry.find(ref.slice(0, i), ref.slice(i + 1));
            },
            completeSimple: (model: any, ctx: any, options: any) =>
              registry.runtime.completeSimple(model, ctx, options),
          }, routerLog);
          rt.saveCache();
        }
      } catch (probeErr) {
        routerLog('[scan] classifier-fallback probe failed:', probeErr instanceof Error ? probeErr.message : String(probeErr));
      }
      
      // Generate the dynamic configuration after the scan
      await rt.generateDynamicConfig(force);
    } finally {
      rt.scanning = false;
    }
  }

  return { populateLlmMatches, scan };
}
