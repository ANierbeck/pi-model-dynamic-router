// src/discovery.ts
// Free-model discovery for the pi-model-router.
//
// ADR-0022 (owner decision 2026-10-04): the router NEVER reads or writes
// Pi's credential store and never resolves API keys itself. Pi owns
// credential resolution end-to-end — the router asks
// modelRegistry.getApiKeyForProvider(provider) when it needs a key (see
// free-model-registration.ts and local-llm.ts, both of which receive an
// injected async resolver wired to that call in index.ts). Everything that
// used to live here (key discovery across env vars / Pi's auth store / the
// pass store / CLI OAuth files, marker resolution, multi-key rotation, the
// CLI-OAuth token sync) was removed with that ADR; if a key lives in a pass
// store or a shell command, the user references it from Pi's own auth file
// and Pi executes it (pi's own providers.md doc).

import type { Config, Cache } from './types.ts';

// NOTE (2026-09-02): the hardcoded CURATED_FREE_MODELS list that used to live
// here has been REMOVED. It only worked for one user's provider setup (a user
// with mistral-zai/mistral-small-latest configured); every other user got a
// list of models they couldn't use. It has been replaced by a dynamic,
// probe-based discovery in src/classifier-fallback-probe.ts:
//   1. selectClassifierCandidates() picks cheap + low-gdpval candidates
//      from the scan cache (works for ANY user's providers).
//   2. probeAndCache() quality-probes each candidate at scan time (real
//      classification cases, incl. the HINT-narration trap) and caches the
//      ones that classify correctly in cache.classifier_fallback_models.
//   3. The classifier reads that cached list at fallback time.
// getCheapestCloudModels() was also removed (dead code: no production callers
// after the classifier moved to the probe-based path). Its pricing-lookup
// logic is now covered by test/classifier-fallback-probe.test.ts.

// ── Discovery Manager ─────────────────────────────────────────────────────

/**
 * Free-model discovery. API-key discovery was removed with ADR-0022 (Pi
 * owns credential resolution); what remains is the free_models inventory
 * from the router config.
 */
export class DiscoveryManager {
  private cfg: Config;
  private cache: Cache;

  constructor(cfg: Config, cache: Cache) {
    this.cfg = cfg;
    this.cache = cache;
  }

  // ── Free Models Discovery ────────────────────────────────────────────

  /**
   * Returns all configured free model refs. Key eligibility is NOT judged
   * here — the callers ask Pi whether the provider's key resolves
   * (ADR-0022) and skip the provider when it doesn't.
   */
  getFreeModels(): string[] {
    const freeModels: string[] = [];
    for (const provConfig of Object.values(this.cfg.providers ?? {})) {
      if (provConfig.free_models?.length) {
        freeModels.push(...provConfig.free_models);
      }
    }
    return freeModels;
  }

  /**
   * Returns true if any free models are configured
   */
  hasFreeModels(): boolean {
    return this.getFreeModels().length > 0;
  }

  // ── Getter ─────────────────────────────────────────────────────────────

  getConfig(): Config {
    return this.cfg;
  }

  getCache(): Cache {
    return this.cache;
  }
}
