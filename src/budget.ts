// src/budget.ts
// Single source of truth for "does this model still have subscription budget?"
//
// PREVIOUSLY this decision was implemented TWICE with identical logic
// (hasModelBudget in index.ts and filterByBudget in routing.ts). The rule now
// lives here only; routing.ts's filterByBudget delegates to hasBudget(). The
// index.ts copy had no callers left and was deleted in the index.ts refactor
// (2026-10-02).
//
// There is no live-refresh path: no subscription provider (Claude Pro/Max via
// claude-bridge, or any other) exposes a documented API to query remaining
// quota. See docs/adr/0003-reject-live-subscription-usage-api.md for why this
// was investigated and rejected rather than built. hasBudget() reads whatever
// is in cache.budget_cache (currently always empty, so subscription providers
// are treated as available — the same as pay-per-token providers) and relies
// on RateLimitManager's reactive cooldowns to react once a provider actually
// reports a rate limit.
//
// Rule (authoritative): a model has budget iff
//   - its provider is local (ollama, lm-studio) OR
//   - its provider is pay-per-token (limited by money, not tokens) OR
//   - there is no cached budget info (assume available — conservative) OR
//   - the subscription window has reset (assume available until refreshed) OR
//   - remaining_tokens > 0.

import { PROVIDER_MAP } from './providers.ts';
import type { Config, Cache } from './types.ts';

interface BudgetContext {
  providers: Config['providers'];
  budget_cache: Cache['budget_cache'];
}

/**
 * Does `ref` still have subscription budget available?
 *
 * @param ref        model ref, e.g. "mistral/mistral-medium-latest"
 * @param providers  provider config (cfg.providers) — for billing type
 * @param budgetCache  cache.budget_cache — provider → remaining tokens
 *
 * Local and pay-per-token providers always have budget. Subscription
 * providers are checked against the cached budget window.
 */
export function hasBudget(
  ref: string,
  providers: Config['providers'],
  budgetCache: Cache['budget_cache']
): boolean {
  const prov = ref.split('/')[0];

  // Local providers (ollama, lm-studio) always have budget
  if (PROVIDER_MAP[prov]?.local) return true;

  // Pay-per-token providers always have budget (limited by money, not tokens)
  const billing = providers?.[prov]?.billing ?? PROVIDER_MAP[prov]?.billing ?? 'pay_per_token';
  if (billing === 'pay_per_token') return true;

  // Subscription providers: check cached budget
  const budget = budgetCache?.[prov];
  if (!budget) return true; // no cached info — assume available (conservative)

  // Check if we're still in the same window
  const now = Date.now();
  if (budget.window_reset && now >= budget.window_reset) {
    // Window has reset, but we haven't refreshed yet — assume available
    return true;
  }

  return (budget.remaining_tokens ?? 0) > 0;
}

/**
 * Filter a list of refs to those that have budget available.
 * Convenience over hasBudget — used by routing.resolveGroup.
 */
export function filterByBudget(
  refs: string[],
  ctx: BudgetContext
): string[] {
  return refs.filter((ref) => hasBudget(ref, ctx.providers, ctx.budget_cache));
}
