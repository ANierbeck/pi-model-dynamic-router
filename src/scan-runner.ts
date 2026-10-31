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
 * Extraction version of the AA scraper. Bumped whenever extractGdpvalScores /
 * extractGdpvalProvenance semantics change; a cache scraped under an older
 * version forces ONE fresh scrape (needsGdpvalScrape) so the fixed extractor
 * rewrites cache.gdpval_scores WHOLESALE — existing installs otherwise keep
 * pre-fix junk keys forever (Sourcery PR #66 round: stale qwen3-8-27b: 580,
 * low-variant labelKeys, missing provenance).
 *
 *   4 — `reasoning` capability column (Intelligence Index / Omniscience /
 *       HLE Diamond blend, owner decision 2026-10-31); caches scraped before
 *       it carry no such value, so planning would rank on the fallback
 *   3 — capability profiles from the `initialModels` payload shape
 *       (commit 895a9c8)
 *   2 — labelKey write discipline, provenance extraction, variant-token
 *       veto, qwen3-8-27b builtin removal (Task-0 identity audit 2026-10-12)
 *   1 — original extraction (implicit for pre-version caches)
 */
export const SCRAPE_VERSION = 4;

/**
 * Whether the AA scrape must (re-)run for this cache. force bypasses all
 * gates; otherwise the scrape runs once per cache, and again whenever the
 * cache was scraped under a different SCRAPE_VERSION.
 */
export function needsGdpvalScrape(c: Cache, force = false): boolean {
  return force || !c.gdpval_scraped || c.scrape_version !== SCRAPE_VERSION;
}

/**
 * Extract GDPval scores from Artificial Analysis HTML
 * Tries JSON data first (modern), falls back to HTML table parsing
 */
export function extractGdpvalScores(html: string): Record<string, number> {
  const scores: Record<string, number> = {};

  // labelKey write discipline (Task-0 identity audit 2026-10-12): a
  // paren-stripped labelKey is a WEAK identity — for dot-less family names
  // ("GPT-6 Astra (low)" → gpt-6-astra) it EQUALS the bare slug of a
  // different row. The leaderboard is processed in descending Elo, so an
  // unconditional labelKey write put the LOWEST variant's score on the
  // family key (live cache: gpt-6-astra = low, claude-opus-55 = low,
  // mistral-large-4 = Preview lower bound). Rules:
  //   - SLUG writes are authoritative and unconditional (they overwrite
  //     any labelKey that claimed the key earlier),
  //   - labelKey writes only fill ABSENT keys and never overwrite a key
  //     any slug row owns (slugWritten),
  //   - within Format B (the authoritative full leaderboard, descending
  //     Elo) each labelKey is claimed at most once — the highest variant
  //     wins (bLabelWritten).
  const slugWritten = new Set<string>();
  const bLabelWritten = new Set<string>();

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
    slugWritten.add(slug);
    const labelKey = label.toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (labelKey && labelKey !== slug && !slugWritten.has(labelKey) && scores[labelKey] === undefined) scores[labelKey] = score;
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
      slugWritten.add(slug);
      const labelKey = displayName.toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      // B may refresh a key Format A's labelKey filled (B is authoritative),
      // but never a slug-owned key and never twice (descending Elo → the
      // highest variant claims the labelKey first).
      if (labelKey && labelKey !== slug && !slugWritten.has(labelKey) && !bLabelWritten.has(labelKey)) {
        scores[labelKey] = score;
        bLabelWritten.add(labelKey);
      }
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
          slugWritten.add(slug);
          if (m.shortName && scores[m.shortName] === undefined) scores[m.shortName] = m.gdpval;
          if (m.name) {
            const nameKey = m.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
            if (scores[nameKey] === undefined) scores[nameKey] = m.gdpval;
          }
        }
      }
      if (Object.keys(scores).length > 0) return scores;
    } catch {}
  }

  return scores;
}

/**
 * Extract per-slug PROVENANCE (creator + raw displayName) from the same
 * Artificial Analysis payload the score parser reads. Task-0 identity
 * audit (2026-10-12): the scraper discarded AA's creator field, so score
 * rows could not be attributed to a vendor offline — the apodex-1.1-mini
 * (inherited parent score) and qwen3-8-27b (stale curated estimate)
 * defects were only findable by name archaeology. Provenance never gates
 * routing; it exists so identity audits can check that a score belongs to
 * the model it claims.
 *
 * Source: Format B leaderboard rows carry creator inline directly after
 * displayName (no nested objects in between, so a bounded regex is safe),
 * joined to slugs via the same displayName→slug table the score pipeline
 * uses. Keyed by SLUG (the authoritative spelling); fill-if-absent —
 * rows are processed in descending Elo and re-encounters of a slug carry
 * the same model's data anyway. Fail-closed: unrecognized payloads yield
 * {}.
 */
export function extractGdpvalProvenance(html: string): Record<string, { creator?: string; displayName?: string }> {
  const provenance: Record<string, { creator?: string; displayName?: string }> = {};

  // The HTML embeds JSON with HTML-escaped quotes (\" → "), same as the
  // score extraction.
  const normalized = html.replace(/\\"/g, '"');

  // displayName → slug table (identical join to the score pipeline).
  const slugByDisplayName = new Map<string, string>();
  const slugRe = /"slug":"([^"]+)","name":"([^"]+)"/g;
  let s;
  while ((s = slugRe.exec(normalized))) slugByDisplayName.set(s[2], s[1]);

  const labelKeyOf = (dn: string) =>
    dn.toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

  // Format B: {"id":"...","displayName":"...","creator":{...},"elo":N,...}
  // creator.name is OPTIONAL (Sourcery PR #66 round: a row without a named
  // creator still gets its displayName stored — audits see partial
  // provenance rather than none).
  const provRe = /\{"id":"[^"]+","displayName":"([^"]+)","creator":(\{[^}]*\}),"elo":[0-9.]+/g;
  let em;
  while ((em = provRe.exec(normalized))) {
    const displayName = em[1];
    const nameMatch = /"name":"([^"]+)"/.exec(em[2]);
    const creator = nameMatch ? nameMatch[1] : undefined;
    let slug = slugByDisplayName.get(displayName);
    if (!slug) {
      const labelKey = labelKeyOf(displayName);
      for (const [dn, sv] of slugByDisplayName) {
        if (labelKeyOf(dn) === labelKey) { slug = sv; break; }
      }
    }
    if (slug) {
      // Unconditional slug write — the slug IS this row, and it must be able
      // to reclaim a key an earlier variant's labelKey claimed (same
      // discipline as the score pipeline's slugWritten set).
      provenance[slug] = creator !== undefined ? { creator, displayName } : { displayName };
      // Also cover the dot-less labelKey twin (Sourcery PR #66 round): the
      // score pipeline serves refs that resolve to the labelKey spelling
      // (claude-opus-55), so provenance must exist under it too.
      // Fill-if-absent over descending-Elo rows keeps the labelKey pointing
      // at the HIGHEST variant — the same row whose score the labelKey
      // carries under the fixed labelKey write discipline.
      const labelKey = labelKeyOf(displayName);
      if (labelKey && labelKey !== slug && provenance[labelKey] === undefined) {
        provenance[labelKey] = creator !== undefined ? { creator, displayName } : { displayName };
      }
    }
  }

  return provenance;
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
 *
 * Two payload stages (the page ships both shapes depending on route/era):
 *   - legacy: displayName-keyed leaderboard chunks (id/displayName/creator),
 *     slug resolved via the displayName→slug table,
 *   - 2026-10-13+: `initialModels` records that carry their own slug
 *     (id/slug/name/creator — the capability columns moved here; the
 *     legacy stage matches nothing on the live page).
 * Provider/creator objects share the {"id","slug","name"} prefix with model
 * records and are excluded by the field that follows "name".
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

  // Stage 2 (2026-10-13 shape): the live page moved the capability columns
  // out of the displayName-keyed leaderboard into an `initialModels` array
  // whose records carry their own slug — better identity than the legacy
  // displayName table. The old entryRe matches nothing on the live
  // page (0 profiles, scan log 'AA payload shape may have drifted'), so this
  // stage is the one that matters; the legacy stage above stays for older
  // payload variants. Stage 2 writes last, so its values win on conflicts.
  //
  // Record heads vs nested creator/provider objects (both share the
  // {"id","slug","name"} prefix): providers/creators continue with
  // "color" after "name" — they are NOT record heads and are absorbed
  // harmlessly (no capability fields there). ANY OTHER field after "name" —
  // including identifiers this code does not know yet — IS a record head
  // and bounds the chunk: a future AA field must not let one record's
  // capabilities leak into the PREVIOUS record's chunk (silent score
  // misattribution, Sourcery PR #69; missing data → gdpval fallback beats
  // wrong data). Chunks therefore never run past a model-shaped record.
  const modelRecRe = new RegExp(
    String.raw`\{"id":"[0-9a-f-]{36}","slug":"([^"]+)","name":"[^"]+","(?!color")([a-zA-Z]+)"([\s\S]*?)` +
    String.raw`(?=\{"id":"[0-9a-f-]{36}","slug":"[^"]+","name":"[^"]+","(?!color")[a-zA-Z]+"|$)`,
    'g'
  );
  let mr: RegExpExecArray | null;
  while ((mr = modelRecRe.exec(html))) {
    const slug = mr[1];
    const chunk = mr[3];
    const profile: { briefcase?: number; coding?: number; reasoning?: number } = {};

    const bc = /"briefcaseElo":([0-9.]+)/.exec(chunk);
    if (bc) {
      const briefcase = parseFloat(bc[1]);
      if (Number.isFinite(briefcase)) profile.briefcase = briefcase;
    }

    const pct = (field: string): number | null => {
      const m = new RegExp(`"${field}":(null|-?[0-9.]+)`).exec(chunk);
      if (!m || m[1] === 'null') return null;
      const v = parseFloat(m[1]);
      return Number.isFinite(v) ? v : null;
    };

    // reasoning = equal thirds of the AA Intelligence Index (0-100), the
    // Omniscience index (accuracy net of hallucination, can be negative) and
    // HLE Diamond (0-1, scaled to 0-100) — owner decision 2026-10-31. All
    // three or nothing: a partial mean would put a model on the column with
    // evidence the others were measured on (missing data beats wrong data,
    // Sourcery PR #69). Each field occurs once per record in the live payload
    // (checked on the 2026-10-31 scrape, 27/27 records). Rounded to two
    // decimals like the coding blend — the value crosses the cache JSON
    // boundary and is compared in tests.
    const intelligence = pct('intelligenceIndex');
    const omniscience = pct('omniscience');
    const hleDiamond = pct('hleDiamond');
    if (intelligence !== null && omniscience !== null && hleDiamond !== null) {
      profile.reasoning = Math.round(((intelligence + omniscience + 100 * hleDiamond) / 3) * 100) / 100;
    }

    const scicode = pct('scicode');
    const terminalBench40 = pct('terminalBench40');
    if (scicode !== null || terminalBench40 !== null) {
      const best = Math.max(scicode ?? 0, terminalBench40 ?? 0);
      // A measured 0 is DATA, not absence (Sourcery PR #69): coding 0 ranks
      // the model last on the column; dropping it would silently fall back
      // to the gdpval proxy and rank a 0% bench model ABOVE measured peers.
      // Same 2-decimal rounding as the legacy stage — determinism across
      // process boundaries (cache JSON, tests).
      profile.coding = Math.round(3000 * best * 100) / 100;
    }

    // Per-field merge over the legacy profile (Sourcery PR #69): Stage 2's
    // identity (own slug) wins per field, but fields the Stage-2 record does
    // not carry survive from the legacy stage — both read the SAME payload,
    // so a merge can never retain fields the current payload dropped.
    if (Object.keys(profile).length) {
      profiles[slug] = { ...profiles[slug], ...profile };
    }
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
      if (needsGdpvalScrape(rt.cache, force)) {
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
          let capabilityScrapeFresh = false;
          try {
            const profiles = extractCapabilityProfiles(html);
            if (Object.keys(profiles).length) {
              // REPLACE, not merge (Sourcery PR #69): models the latest
              // scrape dropped must not linger with stale capability scores
              // in the cache or the in-memory mirror — same rationale as
              // gdpval_provenance in the PR #66 round.
              rt.cache.capability_profiles = profiles;
              metricsModule.setCache(rt.cache);
              capabilityScrapeFresh = true;
            } else {
              routerLog('[scan] No capability profiles extracted - AA payload shape may have drifted');
            }
          } catch {
            // Fail-closed: profile extraction must never break the gdpval
            // scrape — routing falls back to gdpval ordering.
          }

          // Task-0 identity audit (2026-10-12): persist the scrape's
          // provenance (creator + displayName per slug) so identity audits
          // can attribute score rows to vendors offline. Additive merge,
          // same lifecycle as capability_profiles; never gates routing.
          try {
            const provenance = extractGdpvalProvenance(html);
            if (Object.keys(provenance).length) {
              // REPLACE, not merge: rows the latest scrape dropped must
              // not linger as stale audit data (Sourcery PR #66 round).
              rt.cache.gdpval_provenance = provenance;
              metricsModule.setCache(rt.cache);
            } else {
              routerLog('[scan] No gdpval provenance extracted - AA payload shape may have drifted');
            }
          } catch {
            // Fail-closed: provenance extraction must never break the
            // gdpval scrape either.
          }

          if (Object.keys(scores).length) {
            metricsModule.setGdpval(scores);
            rt.cache.gdpval_scores = metricsModule.getGdpval();
            rt.cache.gdpval_scraped = true;
            // Stamp the version only when the capability extraction produced
            // profiles (Sourcery PR #69): scores parsing while capabilities
            // come back empty must not pin empty capability data for the
            // cache TTL — unstamped, needsGdpvalScrape retries the whole
            // scrape on the next scan instead.
            if (capabilityScrapeFresh) {
              rt.cache.scrape_version = SCRAPE_VERSION;
            }
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
          // hasScore guard (Task-0 audit 2026-10-12): a model that already
          // resolves to a scraped/curated score must NOT be re-estimated —
          // the estimate fills the dotted slug key and shadows the real AA
          // row via exact-normalized matching (qwen3.8:27b-mlx → estimate
          // qwen3-8-27b: 812 shadowed AA rows at 1071-1381).
          const ollamaGdpvalEstimates = estimateOllamaModelsGdpvalAsSlugs(
            ollamaModelNames,
            (ref) => metricsModule.lookupGdp(ref) !== null
          );

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
