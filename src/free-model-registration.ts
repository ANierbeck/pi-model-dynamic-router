/**
 * On-demand registration of configured free models into Pi's model
 * registry, extracted from index.ts (refactor plan 2026-10-02, task 6).
 * Registers the PROVIDER (if Pi doesn't know it) with just the one model
 * needed, then re-lookup. Conservative per ADR-0021: only providers in
 * PROVIDER_MAP with a baseUrl, only model IDs explicitly listed in
 * free_models, never overwrites an existing registration (Ü1 invariant).
 * Pure code motion.
 */

import { routerLog } from './logger.ts';
import { PROVIDER_MAP } from './providers.ts';
import type { Config } from './types.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { RateLimitManager } from './rate-limit.ts';

/**
 * Dependencies createFreeModelRegistration reads from index.ts's extension closure. Exposed as
 * live accessors (getters, plus setters for state the moved code writes), so
 * every read sees the CURRENT closure value — index.ts reassigns cfg/router/
 * managers on reload, and a captured copy would go stale.
 */
interface FreeModelRegistrationDeps {
  readonly cfg: Config;
  readonly pi: ExtensionAPI;
  readonly rateLimitManager: RateLimitManager;
  readonly resolveKeyValue: (key: string) => string;
  readonly sessionCtx: any;
}

export function createFreeModelRegistration(rt: FreeModelRegistrationDeps) {
  /**
   * On-demand registration of a configured free model into Pi's model
   * registry. Statically-configured free models (cfg.providers[provider]
   * .free_models) never go through the scan/cache.available_models path,
   * and since ADR-0021 the router registers no scan-discovered models at
   * session start, so without this on-demand path tryStream would skip
   * every free model forever. This registers the PROVIDER (if Pi doesn't
   * know it) with just the one model needed, then re-lookup. Returns true if
   * the model is now findable.
   *
   * Conservative: only fires for providers in PROVIDER_MAP with a baseUrl,
   * and only for model IDs explicitly listed in free_models — explicit user
   * config, not scan discovery, so it stays under ADR-0021. Never overwrites
   * an existing provider registration (Ü1 invariant).
   */
  function registerFreeModelOnDemand(provider: string, modelId: string): boolean {
    const def = (PROVIDER_MAP as any)[provider];
    if (!def?.baseUrl || !def?.api) return false;
    const freeModels = rt.cfg.providers?.[provider]?.free_models;
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
    // still get wiped. Use getRegisteredProviderIds (already used by the
    // session_start diagnostics) for the authoritative 'is the provider known'
    // check.
    const registeredProviderIds: string[] =
      (rt.sessionCtx?.modelRegistry as any)?.getRegisteredProviderIds?.() ?? [];
    if (registeredProviderIds.includes(provider)) return false;
    // 0.99.1 note (ADR-0019): getRegisteredProviderIds() includes every
    // builtin-catalog provider there, so this guard degrades to 'never
    // overwrite a provider pi knows' — conservative and correct. ADR-0021
    // removed the scan-union registration; this explicitly-configured
    // on-demand path is the only cloud registration left.
    // Resolve an API key (free models still need a key for the OpenRouter
    // endpoint, just at no cost). Without one we can't register.
    const keys = rt.cfg.providers?.[provider]?.keys;
    let apiKey: string | undefined;
    if (keys?.length) {
      apiKey = rt.resolveKeyValue(keys[rt.rateLimitManager.activeKeyIndex(provider)]?.key);
    } else if (def.authKey) {
      // auth.json key resolution is async in the real path, but we're in a
      // sync helper. If the provider needs auth.json and has no cfg key, we
      // can't resolve synchronously here — bail. This on-demand path only
      // fires for providers with a resolvable cfg key.
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
      (rt.pi as any).registerProvider(provider, {
        name: `${provider} (free, on-demand)`,
        baseUrl: def.baseUrl,
        apiKey,
        api: def.api,
        models: allFreeModelEntries,
      });
      routerLog(`[router] On-demand registered ${allFreeModelEntries.length} free model(s) for ${provider} (triggered by ${ref})`);
      return Boolean(rt.sessionCtx?.modelRegistry.find(provider, modelId));
    } catch (e) {
      routerLog(`[router] On-demand registration failed for ${ref}:`, e);
      return false;
    }
  }

  return { registerFreeModelOnDemand };
}
