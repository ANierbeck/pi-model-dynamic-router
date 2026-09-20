// src/provider-shadow.ts
// Alias-shadow detection for scan/registration hygiene.
//
// Extracted from index.ts so the "is this router-internal alias provider a
// redundant duplicate of a pi-known provider?" decision can be unit tested
// without instantiating the full Pi extension.
//
// Background (2026-09-20 ghost-model incident): `mistral-zai` is a
// router-internal alias for the same upstream account as `mistral`
// (`pricingAlias: 'mistral'`). Once Pi's own catalog serves the `mistral`
// provider (it does — with REAL per-token prices), the alias provider is
// pure duplication: scanning it re-discovers mistral's whole catalog under
// a different provider key, and registering it bakes the scan's
// `cost_per_m: 0` PLACEHOLDER into Pi's registry as a real price
// (registerGroupModels does `cost: { input: costPerM, output: costPerM }`).
// The fake $0.0 then made the alias duplicates (best GDPval in the pool)
// win every cost-sorted group while real money was billed upstream.
//
// The rule is generic (no hardcoded provider names): a provider is
// redundant when its `pricingAlias` target is known to Pi. If Pi does NOT
// know the target (e.g. no mistral auth), the alias provider with its own
// key remains the only route to those models and is NOT redundant.

/** Minimal shape of PROVIDER_MAP entries this module needs. */
export interface ProviderDefLike {
  pricingAlias?: string;
}

/**
 * Returns the set of provider ids whose `pricingAlias` target is in the
 * pi-known set. Those providers duplicate a pi-served catalog and must not
 * be scanned, registered, or kept in the scan cache.
 */
export function redundantAliasProviders(
  providerMap: Record<string, ProviderDefLike>,
  piKnownProviders: ReadonlySet<string>
): Set<string> {
  const redundant = new Set<string>();
  for (const [provId, def] of Object.entries(providerMap)) {
    const alias = def?.pricingAlias;
    if (typeof alias === 'string' && piKnownProviders.has(alias)) {
      redundant.add(provId);
    }
  }
  return redundant;
}

/** Minimal shape of a scan-cache available_models entry. */
export interface AvailableModelLike {
  id: string;
  provider: string;
}

/**
 * Drops scan-cache entries of redundant alias providers. Stale entries of
 * providers that are no longer scanned used to survive forever via the
 * scan merge's "keep existing entries for providers not scanned" rule —
 * this prunes them so they can never reach config generation or
 * registration again.
 */
export function pruneRedundantCacheEntries<T extends AvailableModelLike>(
  availableModels: readonly T[],
  redundant: ReadonlySet<string>
): T[] {
  if (!redundant.size) return availableModels as unknown as T[];
  return availableModels.filter((m) => !redundant.has(m.provider));
}
