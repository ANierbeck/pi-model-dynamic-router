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
import { probeLocalClassifierCandidates } from './classifier-local-probe.ts';
import { callOllama, isOllamaAvailable } from './ollama-utils.ts';
import { type LocalLlmDeps, callLocalLlm } from './local-llm.ts';
import { routerLog, warnLog } from './logger.ts';
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
interface ScanRunnerDeps {
  readonly cache: Cache;
  readonly cacheManager: CacheManager;
  readonly cfg: Config;
  readonly GDPVAL_URL: string;
  readonly generateDynamicConfig: (force?: boolean | undefined) => Promise<void>;
  readonly MODELS_TTL: number;
  readonly saveCache: () => void;
  scanning: boolean;
  readonly sessionCtx: any;
}

/**
 * Extract GDPval scores from Artificial Analysis HTML
 * Tries JSON data first (modern), falls back to HTML table parsing
 */
export function extractGdpvalScores(html: string): Record<string, number> {
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

/**
 * Extract per-model capability profiles from the SAME Artificial Analysis
 * payload the gdpval parser reads (ADR-0023 round 2, plan
 * docs/plans/2026-10-04-aa-multi-benchmark-sourcing.md — the payload
 * carries every benchmark column per model; the legacy parser keeps one
 * field and discards the rest).
 *
 * Columns extracted:
 *   briefcase — AA-Briefcase Elo (agentic knowledge work; Elo scale, used
 *               as-is — the natural planning score)
 *   coding    — 3000 * max(scicode, terminalBench40). The raw columns are
 *               0–1 percentages; the monotonic blend only feeds
 *               intra-group ordering (floors/caps stay on GDPval), so the
 *               absolute calibration never meets a gate.
 *
 * Chunk-parse: each leaderboard entry ("{"id":"…","displayName":"…",
 * "creator":{…}" up to the next entry start) is processed in isolation so
 * fields are never paired ACROSS entries — an entry with scicode but no
 * briefcaseElo keeps its coding score and gets no briefcase. Entries with
 * no capability fields produce no profile. Fail-closed: an unrecognized
 * payload yields {} (callers fall back to gdpval).
 *
 * EXPORTED at module level (unlike the closure-bound extractGdpvalScores,
 * which is mirrored in test/aa-gdpval-scrape.test.ts and can drift) — the
 * tests import this real implementation.
 */
export function extractCapabilityProfiles(html: string): NonNullable<Cache['capability_profiles']> {
  const profiles: NonNullable<Cache['capability_profiles']> = {};

  // displayName → slug table from the same RSC payload (identical to the
  // legacy Format-B mapping, which is proven against the live page).
  const slugByDisplayName = new Map<string, string>();
  const slugRe = /"slug":"([^"]+)","name":"([^"]+)"/g;
  let s: RegExpExecArray | null;
  while ((s = slugRe.exec(html))) slugByDisplayName.set(s[2], s[1]);

  const labelKeyOf = (dn: string) =>
    dn.toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

  // One chunk per entry: displayName + everything after creator{} up to the
  // next entry start (or end of payload).
  const entryRe = /\{"id":"[^"]+","displayName":"([^"]+)","creator":\{[^}]+\}([\s\S]*?)(?=\{"id":"[^"]+","displayName":|$)/g;
  let em: RegExpExecArray | null;
  while ((em = entryRe.exec(html))) {
    const displayName = em[1];
    let slug = slugByDisplayName.get(displayName) ?? labelKeyOf(displayName);
    if (!slug) continue;
    const chunk = em[2];

    const profile: { gdpval?: number; briefcase?: number; coding?: number } = {};

    const bc = /"briefcaseElo":([0-9.]+)/.exec(chunk);
    if (bc) {
      const briefcase = parseFloat(bc[1]);
      if (Number.isFinite(briefcase)) profile.briefcase = briefcase;
    }

    const pct = (field: string): number | null => {
      const m = new RegExp(`"${field}":(null|[0-9.]+)`).exec(chunk);
      if (!m || m[1] === 'null') return null;
      const v = parseFloat(m[1]);
      return Number.isFinite(v) ? v : null;
    };
    const scicode = pct('scicode');
    const terminalBench40 = pct('terminalBench40');
    if (scicode !== null || terminalBench40 !== null) {
      const best = Math.max(scicode ?? 0, terminalBench40 ?? 0);
      // Round to 2 decimals — 3000 * 0.55 is 1650.0000000000002 in IEEE754;
      // determinism matters because these values cross process boundaries
      // (cache JSON) and are compared in tests.
      if (best > 0) profile.coding = Math.round(3000 * best * 100) / 100;
    }

    if (Object.keys(profile).length) profiles[slug] = profile;
  }
  return profiles;
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
    // from a weaker model may contain cross-family
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
    // API keys come from Pi (ADR-0022): getApiKeyForProvider via sessionCtx.
    const deps: LocalLlmDeps = {
      providers: PROVIDER_MAP,
      cache: rt.cache,
      cfg: rt.cfg,
      resolveApiKey: async (provider: string) =>
        (await (rt.sessionCtx?.modelRegistry as any)?.getApiKeyForProvider?.(provider)?.catch?.(
          () => null
        )) ?? null,
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
          `[router] LLM matcher call failed (${result.error}); ${stillUnscored.length} model(s) remain unscored. Check that a local Ollama model or a free OpenRouter model is available.`
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
   * (ADR-0022 removed the per-provider catalog scan and its model filter;
   *   cloud model inventory comes from Pi's catalog.)
   *
   * LOCAL CAPABILITIES: for Ollama, /api/show is fetched per model (parallel,
   *   bounded) to get `model_info.*.context_length` + the capabilities array —
   *   setup-independent (no hardcoded table, no dependency on any specific
   *   Ollama extension). Results land in cache.available_models[].capabilities
   *   (see AvailableModel/ModelCapabilities types) and flow through to the
   *   LOCAL registration in registerGroupModels (Ollama only, kept per
   *   ADR-0021: Pi has no live local-discovery mechanism; LM Studio was
   *   never registered), which registers with the real values instead of
   *   the old hardcoded blanket.
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

          // ADR-0023 round 2: the SAME payload carries the per-benchmark
          // capability columns (briefcaseElo, scicode, terminalBench40 —
          // ~180/~90 occurrences verified 2026-10-04). Extract them for
          // task-type-aware group scoring (Group.score_by). Additive merge:
          // a failed/partial extraction keeps whatever the cache already
          // had; the profiles never gate anything on their own (missing
          // column = gdpval fallback). No new fetch, no new TTL — the
          // existing gdpval_scraped flag covers this fetch.
          try {
            const profiles = extractCapabilityProfiles(html);
            if (Object.keys(profiles).length) {
              rt.cache.capability_profiles = { ...rt.cache.capability_profiles, ...profiles };
              metricsModule.setCache(rt.cache);
            } else {
              routerLog('[scan] No capability profiles extracted - AA payload shape may have drifted');
            }
          } catch {
            // Fail-closed: profile extraction must never break the gdpval
            // scrape — routing falls back to gdpval ordering.
          }

          if (Object.keys(scores).length) {
            metricsModule.setGdpval(scores);
            rt.cache.gdpval_scores = metricsModule.getGdpval();
            rt.cache.gdpval_scraped = true;
          } else {
            routerLog('[scan] No GDPval scores extracted - table regex may be outdated');
          }
        } catch (err) {
          /* scrape failed, use builtins */
          warnLog(`[scan] GDPval scrape failed (${err instanceof Error ? err.message : String(err)}); using builtins only`);
        }
      }
      const age = rt.cache.models_cached
        ? Date.now() - new Date(rt.cache.models_cached).getTime()
        : Infinity;
      if (force || age > rt.MODELS_TTL) {
        const models: Cache['available_models'] = [];
        // OpenRouter's public pricing catalog (no credentials involved,
        // ADR-0022): free-tier model ids for the cache + per-model pricing
        // for cost sorting.
        {
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
        // ADR-0022 removed the direct-API provider catalog scans: post-ADR-0021 their results were inert
        // cache entries and they were the last reason the router needed
        // raw API key values. Pi's catalog is the source of truth.
        //
        // Alias-shadow rule (2026-09-20 ghost-model incident, generic per
        // Leitplanke 1): a provider whose `pricingAlias` target pi already
        // serves duplicates pi's catalog under a router-internal key — and
        // its scan entries carried `cost_per_m: 0` PLACEHOLDERS that polluted
        // the cache and its diagnostics. Prune stale entries of shadowed
        // alias providers even when THIS scan pass found nothing (all
        // fetches failing must not keep ghosts alive). Pure cache hygiene —
        // runs on every completed scan pass.
        const piKnownProviders = new Set<string>();
        if (rt.sessionCtx?.modelRegistry) {
          try {
            for (const model of rt.sessionCtx.modelRegistry.getAvailable()) {
              piKnownProviders.add(model.provider);
            }
          } catch {}
        }
        const redundantProviders = redundantAliasProviders(PROVIDER_MAP, piKnownProviders);
        //
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
            hasConfiguredAuth: (model: any) =>
              typeof registry?.hasConfiguredAuth === 'function'
                ? Boolean(registry.hasConfiguredAuth(model))
                : true,
          }, routerLog);
          rt.saveCache();
        }
      } catch (probeErr) {
        warnLog('[scan] classifier-fallback probe failed:', probeErr instanceof Error ? probeErr.message : String(probeErr));
      }

      // Generate the dynamic configuration FIRST (review M2, 2026-10-07):
      // the local classifier probe can take minutes (up to 6 candidates x
      // 3 cases x 45s cold-start bound) and the dynamic config does not read
      // its result — delaying regeneration by the probe would stall routing
      // and compete with a live classification for the GPU.
      await rt.generateDynamicConfig(force);

      // Derive + probe the LOCAL classifier chain after the dynamic config
      // (ADR-0025 C): candidates come from the Ollama models this scan just
      // found, verified with the same classification cases, persisted as
      // cache.classifier_local_models. Non-fatal — the provisional candidate
      // order applies only before the first probe (review N2, 2026-10-07);
      // after a probe, an empty list is final until a re-probe.
      try {
        await probeLocalClassifierCandidates(rt.cfg, rt.cache, { callOllama, isAvailable: isOllamaAvailable }, routerLog, { force });
        rt.saveCache();
      } catch (probeErr) {
        warnLog('[scan] local classifier probe failed:', probeErr instanceof Error ? probeErr.message : String(probeErr));
      }
    } finally {
      rt.scanning = false;
    }
  }

  return { populateLlmMatches, scan };
}
