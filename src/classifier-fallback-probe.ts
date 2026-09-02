// src/classifier-fallback-probe.ts
// Dynamic discovery + availability probe for the classifier's cloud fallback.
//
// PROBLEM: the classifier's cloud fallback (when Ollama is down) needs a list
// of cheap, capable-enough cloud models. Two prior approaches both failed:
//
//  1. Hardcoded free_models in router-config.json — only listed openrouter
//     free models; a user with a Mistral/Anthropic key but no openrouter key
//     got an empty list.
//  2. Hardcoded CURATED_FREE_MODELS (mistral-small-latest etc.) — only worked
//     for one user's provider setup; every other user got nothing.
//
// SOLUTION (user request, 2026-09-02): discover candidates dynamically from
// the scan cache, probe each with a tiny `completeSimple` call to verify it
// actually responds, cache the verified list in the scan cache, and reuse it
// until the next `/router scan` regenerates the cache.
//
// SELECTION — "low-level but not too low-level":
//   Tier A (best): real per-token price ≤ threshold AND known low gdpval.
//   Tier B:        real per-token price ≤ threshold, gdpval unknown.
//   Tier C:        placeholder $0 (provider-level cost_per_m:0, no real
//                  pricing) — probe decides if they actually work.
//   Excluded: local providers (ollama/lm-studio — primary path, not fallback),
//             models currently marked unhealthy in model_health.
//
// PROBE: at scan time (after the scan saves the cache), send a ~5-token
// "Reply with OK" request to each candidate via pi's `completeSimple`. Models
// that respond (any non-error stop reason) are added to the cached list. The
// probe is bounded: timeout per candidate, max candidates probed, and the
// first N *successes* short-circuit (we don't need more than maxResults
// working models).
//
// CACHE: verified-working refs are stored in
// `cache.classifier_fallback_models` (a string[]) and persisted with the rest
// of the scan cache. The classifier reads this list at fallback time — no
// re-probing per classification.
//
// DESIGN NOTE: this module has NO hard dependency on any specific provider.
// Whatever providers the user has keys for, the scan discovers models and
// pricing, the selection picks the cheapest, and the probe filters the
// broken ones. It works out-of-the-box for any user.

import type { Cache, Config } from './types.ts';
import { lookupPrice } from './metrics.ts';
import { isUnhealthy } from './model-health.ts';

/** Max output price ($/M tokens) for a classification-fallback candidate. */
const MAX_OUTPUT_PRICE_PER_M = 5;

/**
 * Upper bound on gdpval for the "low-level but not too low-level" tier.
 * Models above this are strategic-tier (expensive, heavy) — not suitable for
 * a <100-token classification prompt. 700 sits between operational (~300-700)
 * and tactical (~700-1200); classification needs operational-or-below.
 */
const MAX_GDPVAL_LOW_TIER = 700;

/** Max candidates to probe per scan (bounds probe latency). Raised from
 * 12 to 20: the probe is cheap (tiny prompt, early-stop at 8 successes) and
 * a higher cap ensures we reach Tier C (Mistral/placeholder-$0 providers)
 * even when Tier B (OpenRouter free) has >12 candidates. */
const MAX_PROBE_CANDIDATES = 20;

/** Max working models to keep in the cached list. */
const MAX_WORKING_MODELS = 8;

/** Per-candidate probe timeout (ms). */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Probe context — the hooks the probe needs from pi's session.
 * Mirrors the `completeSimple`/`findModel` reach-through the classifier
 * already uses (src/content-classifier.ts:540-545).
 */
export interface ProbeContext {
  /** Resolves a "provider/id" ref to a pi Model object. */
  findModel: (ref: string) => any | undefined;
  /** Pi's one-shot completion API (modelRegistry.runtime.completeSimple). */
  completeSimple: (model: any, ctx: any, options: any) => Promise<any>;
}

/**
 * Selects candidate models for the classifier's cloud fallback, tiered by
 * price + gdpval. Returns refs sorted best-first. Does NOT probe — that's
 * {@link probeAndCache}.
 *
 * Tiering handles the gdpval sparsity problem: only ~27/121 models in a
 * typical scan have gdpval scores (most cloud models are unscored). A strict
 * "cheap AND low-gdpval" filter would yield zero candidates for most users.
 * Instead: Tier A (both signals) comes first, then Tier B (cheap, unknown
 * gdpval), then Tier C (placeholder $0 — probe will decide).
 */
export function selectClassifierCandidates(
  cfg: Config,
  cache: Cache,
  opts: { maxPrice?: number; maxGdpval?: number; maxCandidates?: number } = {},
): string[] {
  const maxPrice = opts.maxPrice ?? MAX_OUTPUT_PRICE_PER_M;
  const maxGdpval = opts.maxGdpval ?? MAX_GDPVAL_LOW_TIER;
  const maxCandidates = opts.maxCandidates ?? MAX_PROBE_CANDIDATES;

  const tierA: { ref: string; price: number; gdpval: number }[] = [];
  const tierB: { ref: string; price: number }[] = [];
  const tierC: string[] = [];

  for (const m of cache.available_models ?? []) {
    const ref = `${m.provider}/${m.id}`;
    // Skip local providers — that's the primary classifier path, not fallback.
    if (ref.startsWith('ollama/') || ref.startsWith('lm-studio/')) continue;
    // Skip models currently marked unhealthy (failed ≥2× recently).
    // Health decays after 15 min, so a recovered model gets re-probed next scan.
    if (isUnhealthy(cache, ref)) continue;

    const price = lookupPrice(ref);
    // gdpval lookup: model_score_cache maps ref → slug; gdpval_scores maps slug → score.
    const slug = cache.model_score_cache?.[ref];
    const gdpval = slug ? cache.gdpval_scores?.[slug] : undefined;

    if (price && price.output !== 'unknown' && price.output <= maxPrice) {
      // Has a REAL per-token price within budget.
      if (gdpval !== undefined && gdpval <= maxGdpval) {
        // Tier A: cheap AND low-gdpval — best.
        tierA.push({ ref, price: price.output, gdpval });
      } else {
        // Tier B: cheap, gdpval unknown or above threshold (still cheap — worth probing).
        tierB.push({ ref, price: price.output });
      }
    } else if (!price && (m.cost_per_m ?? 0) === 0) {
      // Tier C: no real pricing, but provider-level placeholder says $0.
      // (Generic direct-API providers like mistral-zai.) Probe will decide.
      tierC.push(ref);
    }
    // else: has a real price ABOVE budget — excluded (too expensive for classification).
  }

  // Sort Tier A by (price asc, gdpval asc) — cheapest + simplest first.
  tierA.sort((a, b) => a.price - b.price || a.gdpval - b.gdpval);
  // Sort Tier B by price asc — cheapest first.
  tierB.sort((a, b) => a.price - b.price);

  // Assemble with PROVIDER DIVERSITY via round-robin interleaving.
  //
  // Why: a strict "Tier A then B then C" order lets one provider monopolize
  // the candidate list. Observed in production (2026-09-02): the user's
  // OpenRouter free-tier daily limit was exhausted (429 on all :free models)
  // AND their OpenRouter guardrails blocked several free models (404). The
  // 12 Tier-B OpenRouter candidates filled every slot, so Tier C (Mistral
  // models with a working key) was never probed → 0 working models cached →
  // classifier fell through to `fallback → tactical` (a heavy model) for
  // every prompt.
  //
  // Round-robin by provider prevents this: we take turns picking one
  // candidate per provider across all tiers, so a single down/rate-limited
  // provider can never starve the others. Within each provider's picks,
  // Tier A comes before B before C (best-first).
  //
  // Group candidates by provider, preserving tier order within each provider.
  const byProvider = new Map<string, string[]>();
  const addProv = (ref: string) => {
    const prov = ref.slice(0, ref.indexOf('/'));
    if (!byProvider.has(prov)) byProvider.set(prov, []);
    byProvider.get(prov)!.push(ref);
  };
  // Per-provider: Tier A first, then B, then C (already sorted within tier).
  for (const { ref } of tierA) addProv(ref);
  for (const { ref } of tierB) addProv(ref);
  for (const ref of tierC) addProv(ref);

  const providers = [...byProvider.keys()];
  const result: string[] = [];
  const seen = new Set<string>();
  const idx = new Map<string, number>(); // provider → next pick index
  // Round-robin: keep taking the next candidate from each provider in turn.
  let madeProgress = true;
  while (result.length < maxCandidates && madeProgress) {
    madeProgress = false;
    for (const prov of providers) {
      if (result.length >= maxCandidates) break;
      const picks = byProvider.get(prov)!;
      const i = idx.get(prov) ?? 0;
      if (i >= picks.length) continue;
      idx.set(prov, i + 1);
      const ref = picks[i];
      if (seen.has(ref)) continue;
      seen.add(ref);
      result.push(ref);
      madeProgress = true;
    }
  }
  return result;
}

/**
 * Returns the cached, verified-working classifier fallback model list.
 * Empty array if the probe hasn't run yet (or the cache was invalidated by a
 * fresh scan). The classifier should fall back to {@link selectClassifierCandidates}
 * + the existing try-each-model loop in that case.
 */
export function getCachedFallbackModels(cache: Cache): string[] {
  return cache.classifier_fallback_models ?? [];
}

/**
 * Probes candidate models and caches the ones that respond. Intended to run
 * at the end of {@link scan} (after the scan cache is saved), so the working
 * list is ready before the first classification needs it.
 *
 * The probe is bounded: at most {@link MAX_PROBE_CANDIDATES} candidates, each
 * with a {@link PROBE_TIMEOUT_MS} timeout, and it stops as soon as
 * {@link MAX_WORKING_MODELS} successes are found (we don't need more than
 * that for a fallback chain).
 *
 * @returns the list of verified-working refs (also written to cache).
 */
export async function probeAndCache(
  cfg: Config,
  cache: Cache,
  pctx: ProbeContext,
  onLog?: (msg: string) => void,
): Promise<string[]> {
  const candidates = selectClassifierCandidates(cfg, cache);
  const log = onLog ?? (() => {});
  log(`[classifier-probe] probing ${candidates.length} candidate(s) for fallback availability`);

  const working: string[] = [];
  const probePrompt = {
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
  };

  for (const ref of candidates) {
    if (working.length >= MAX_WORKING_MODELS) break;
    try {
      const model = pctx.findModel(ref);
      if (!model) {
        log(`[classifier-probe] ${ref} not in pi registry — skipping`);
        continue;
      }
      // Per-candidate timeout via AbortController-style options if supported;
      // completeSimple is expected to honor options.signal.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
      try {
        const result = await pctx.completeSimple(model, probePrompt, { signal: ac.signal });
        clearTimeout(timer);
        if (result && !result.errorMessage && result.stopReason !== 'error') {
          working.push(ref);
          log(`[classifier-probe] ${ref} OK`);
        } else {
          log(`[classifier-probe] ${ref} failed: ${result?.errorMessage ?? 'error stop'}`);
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      log(`[classifier-probe] ${ref} failed: ${(e as Error).message}`);
    }
  }

  cache.classifier_fallback_models = working;
  log(`[classifier-probe] ${working.length} working model(s) cached: ${working.join(', ') || '(none)'}`);
  return working;
}

/**
 * True if the cached fallback list is present (probe has run this scan cycle).
 * Note: an empty list IS valid (means the probe ran but everything failed) —
 * the classifier should then fall back to selectClassifierCandidates + the
 * try-each loop. This function only reports presence, not usability.
 */
export function hasProbedFallback(cache: Cache): boolean {
  return Array.isArray(cache.classifier_fallback_models);
}
