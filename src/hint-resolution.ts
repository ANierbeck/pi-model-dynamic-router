// src/hint-resolution.ts
// Provider-usability ranking for HINT model resolution.
//
// Extracted from index.ts so the "pick the working provider, not just the
// first name match" logic can be unit tested without instantiating the full
// Pi extension (session context, streaming, etc).

import { splitRef } from './utils.js';
import { PROVIDER_MAP } from './providers.js';
import type { Group } from './types.js';

/**
 * The subset of Pi's ModelRegistry that usability checks depend on. Kept
 * minimal and duck-typed (rather than importing pi-ai's real type) because
 * the fields used here (`runtime`, `getProvider`) are not part of pi-ai's
 * public API — see hostStreamSimple() in index.ts for why.
 */
export interface ModelRegistryLike {
  find(provider: string, modelId: string): unknown;
  getApiKeyForProvider(provider: string): Promise<string | null | undefined>;
  runtime?: { streamSimple?: (...args: any[]) => any };
  getProvider?: (provider: string) => { streamSimple?: (...args: any[]) => any } | undefined;
}

/**
 * Whether a ref can actually be streamed right now: the model exists, the host
 * has a stream handler for it, and credentials are satisfied.
 *
 * Mirrors the gates in index.ts's tryStream() exactly, so a ref that passes
 * here will not be rejected later for a reason we could have seen up front.
 * Used to pick between providers that offer the same model name (e.g.
 * "claude-sonnet-5" via both `anthropic` and `claude-bridge`) — a provider
 * without a usable key must never win over one that can serve the request.
 */
export async function isRefUsable(
  ref: string,
  modelGroups: Record<string, Group>,
  modelRegistry: ModelRegistryLike | null | undefined
): Promise<boolean> {
  if (!modelRegistry) return false;
  const { provider, modelId } = splitRef(ref);
  if (modelGroups[provider]) return false;
  const model = modelRegistry.find(provider, modelId);
  if (!model) return false;
  const hasHandler =
    typeof modelRegistry.runtime?.streamSimple === 'function' ||
    typeof modelRegistry.getProvider?.(provider)?.streamSimple === 'function';
  if (!hasHandler) return false;
  // Providers the router does not manage (e.g. claude-bridge) carry their own
  // auth — the extension registered the model, so it can serve it.
  if (!PROVIDER_MAP[provider]) return true;
  if (PROVIDER_MAP[provider]?.local) return true;
  const apiKey = await modelRegistry.getApiKeyForProvider(provider).catch(() => null);
  return Boolean(apiKey);
}

/**
 * Order refs that all satisfy the same HINT: usable providers first, each tier
 * sorted by gdpval. Keeps unusable refs as last-resort candidates rather than
 * dropping them, so a wrong usability verdict cannot make the HINT unroutable.
 *
 * Usability checks run concurrently (Promise.all) rather than sequentially —
 * each check may hit the host's async getApiKeyForProvider, and candidate
 * lists are independent of one another.
 */
export async function rankHintCandidates(
  refs: string[],
  modelGroups: Record<string, Group>,
  modelRegistry: ModelRegistryLike | null | undefined,
  lookupGdp: (id: string) => number | null,
  onUnusable?: (unusable: string[]) => void
): Promise<string[]> {
  const usability = await Promise.all(refs.map((ref) => isRefUsable(ref, modelGroups, modelRegistry)));
  const usable: string[] = [];
  const unusable: string[] = [];
  refs.forEach((ref, i) => (usability[i] ? usable : unusable).push(ref));
  const byGdpval = (a: string, b: string) => (lookupGdp(b) ?? 0) - (lookupGdp(a) ?? 0);
  usable.sort(byGdpval);
  unusable.sort(byGdpval);
  if (unusable.length) onUnusable?.(unusable);
  return [...usable, ...unusable];
}
