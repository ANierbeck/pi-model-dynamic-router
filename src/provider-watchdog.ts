// src/provider-watchdog.ts
// Local-provider watchdog (ADR-0016).
//
// A wedged Ollama daemon still answers /api/tags, so the reachability probe
// says "up", but every generation times out (MLX runner stuck in
// "Stopping…", live 2026-09-25/26). Each local candidate then burns a full
// timeout. This is a property of the daemon, not of any model, so it must not
// go into the model blocklist (ADR-0008). Instead: timeouts on at least
// WEDGE_MIN_MODELS distinct local models within WEDGE_WINDOW_MS, with no local
// success in between, mark the provider wedged for WEDGE_COOLDOWN_MS. Any
// local success clears it; after the cooldown the provider is probed again.
//
// State lives in the cache object (see model-health.ts for why).

import type { Cache } from './types.ts';
import { PROVIDER_MAP } from './providers.ts';

const WEDGE_MIN_MODELS = 2;
export const WEDGE_WINDOW_MS = 10 * 60_000;
export const WEDGE_COOLDOWN_MS = 5 * 60_000;
/** The cooldown for log lines and narration ("5 min"). */
export const WEDGE_COOLDOWN_TEXT = `${Math.round(WEDGE_COOLDOWN_MS / 60_000)} min`;

/** How the user un-wedges a local provider; the router never restarts it itself. */
export function wedgeFixHint(provider: string): string {
  return provider === 'ollama'
    ? 'restart the daemon (e.g. `pkill ollama`; a launch agent or service restarts it)'
    : `restart ${provider}`;
}

type ProviderHealth = NonNullable<Cache['local_provider_health']>[string];

function isLocal(provider: string): boolean {
  return PROVIDER_MAP[provider]?.local === true;
}

function state(cache: Cache, provider: string): ProviderHealth {
  if (!cache.local_provider_health) cache.local_provider_health = {};
  return (cache.local_provider_health[provider] ??= { timeouts: {} });
}

/**
 * Records a generation timeout for a local model. Returns true only when this
 * timeout newly marks the provider as wedged (so the caller narrates once).
 */
export function recordLocalTimeout(cache: Cache, ref: string, now: number = Date.now()): boolean {
  const provider = ref.split('/')[0];
  if (!isLocal(provider)) return false;
  const s = state(cache, provider);
  for (const [model, at] of Object.entries(s.timeouts)) {
    if (now - at >= WEDGE_WINDOW_MS) delete s.timeouts[model];
  }
  s.timeouts[ref] = now;
  if (isProviderWedged(cache, provider, now)) return false;
  if (Object.keys(s.timeouts).length < WEDGE_MIN_MODELS) return false;
  s.wedged_until = now + WEDGE_COOLDOWN_MS;
  return true;
}

/** Any local success proves the daemon generates: clears evidence and wedge. */
export function recordLocalSuccess(cache: Cache, ref: string): void {
  const provider = ref.split('/')[0];
  if (!isLocal(provider)) return;
  delete cache.local_provider_health?.[provider];
}

export function isProviderWedged(cache: Cache | undefined, provider: string, now: number = Date.now()): boolean {
  const until = cache?.local_provider_health?.[provider]?.wedged_until;
  return until !== undefined && now < until;
}
