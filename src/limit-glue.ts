/**
 * Metrics / rate-limit / blocklist / cost glue, extracted from index.ts
 * (refactor plan 2026-10-02, task 2). Thin delegating helpers over the
 * managers (metricsModule, rateLimitManager, discoveryManager) and cache.
 * Pure code motion; closure state is reached through `d`.
 */

import { isPaidCloudRateLimitFailure } from './detection.ts';
import { routerLog } from './logger.ts';
import * as metricsModule from './metrics.ts';
import { recordBlocklistSuccess, activeBlocks, recordBlocklistFailure, formatBlockLogLine } from './model-blocklist.ts';
import { recordModelFailure, recordModelSuccess } from './model-health.ts';
import { recordLocalSuccess } from './provider-watchdog.ts';
import { recordSessionErrorFromFailure } from './session-errors.ts';
import type { Metrics, Cache, Config } from './types.ts';
import type { CacheManager } from './cache.ts';
import type { DiscoveryManager } from './discovery.ts';
import type { RateLimitManager } from './rate-limit.ts';

/**
 * Dependencies createLimitGlue reads from index.ts's extension closure. Exposed as
 * live accessors (getters, plus setters for state the moved code writes), so
 * every read sees the CURRENT closure value — index.ts reassigns cfg/router/
 * managers on reload, and a captured copy would go stale.
 */
interface LimitGlueDeps {
  readonly cache: Cache;
  readonly cacheManager: CacheManager;
  readonly cfg: Config;
  readonly discoveryManager: DiscoveryManager;
  readonly rateLimitManager: RateLimitManager;
  readonly scheduleSessionErrorSave: () => void;
  readonly updateErrorStatusLine: () => void;
}

export function createLimitGlue(d: LimitGlueDeps) {
  // ── Metrics ────────────────────────────────────────────────────────────

  function getM(ref: string): Metrics {
    return metricsModule.getM(ref);
  }

  function updateMetrics(ref: string, latMs: number, tokens: number, durMs: number) {
    metricsModule.updateMetrics(ref, latMs, tokens, durMs);
  }

  // ── Rate Limit + costMux ───────────────────────────────────────────────
  // NOTE: no duplicate activeKeyIdx map here — the rotation state lives in
  // the RateLimitManager (rateLimitManager.activeKeyIndex). A second,
  // never-updated map here made registrations hand pi an already-exhausted
  // key after a rotation (final v1.6.0 review minor #7).

  function resolveKeyValue(key: string): string {
    return d.discoveryManager.resolveKeyValue(key) ?? key;
  }

  function costMux(prov: string) {
    return d.rateLimitManager.costMux(prov);
  }

  function isLimited(ref: string) {
    return d.rateLimitManager.isLimited(ref);
  }

  function recordLimit(ref: string, resetAtMs?: number): { rotated: boolean; newKey?: string } {
    recordModelFailure(d.cache, ref);
    return d.rateLimitManager.recordLimit(ref, d.cfg.providers ?? {}, resetAtMs);
  }

  function recordOk(ref: string) {
    d.rateLimitManager.recordOk(ref);
    recordModelSuccess(d.cache, ref);
    recordLocalSuccess(d.cache, ref);
    if (recordBlocklistSuccess(d.cache, ref)) {
      routerLog(`[router] ${ref} answered after its blocklist entry expired — block cleared`);
      d.cacheManager.saveCache(d.cache);
    }
  }

  /** Text for `/router blocklist`: every active block with reason and re-probe time. */
  function formatBlocklist(): string {
    const blocked = activeBlocks(d.cache);
    if (!blocked.length) return 'Blocklist: empty — no model has shown a permanent provider failure.';
    const days = (ms: number) => `${Math.max(1, Math.ceil(ms / 86_400_000))}d`;
    const lines = [`Blocklist (${blocked.length}) — re-probed automatically when the block expires`, ''];
    for (const { ref, entry, reprobeInMs } of blocked) {
      const code = entry.code ? `HTTP ${entry.code}` : 'no HTTP code';
      const detail = entry.reason === 'unknown-signature' ? `\n   signature: ${entry.signature}` : '';
      lines.push(
        `🚫 ${ref}\n   ${entry.reason} (${code}) · since ${new Date(entry.first_seen).toISOString().slice(0, 10)}` +
          ` · seen ${entry.occurrences}× · re-probe in ${days(reprobeInMs)}${detail}`
      );
    }
    return lines.join('\n');
  }

  /** Feeds a failure text into the learned blocklist (ADR-0008, Tier 1). */
  function observeFailure(ref: string, failureText: string): void {
    const entry = recordBlocklistFailure(d.cache, ref, failureText);
    if (!entry) return;
    routerLog(formatBlockLogLine(ref, entry));
    d.cacheManager.saveCache(d.cache);
  }

  function clearLimit(ref: string): void {
    d.rateLimitManager.clearLimit(ref);
  }

  /** Record a soft failure (empty response, timeout) — lighter backoff than 429 */
  function recordSoftFailure(ref: string): void {
    d.rateLimitManager.recordSoftFailure(ref);
    recordModelFailure(d.cache, ref);
  }

  /**
   * Escalates a stream failure to the right backoff tier, exactly like the
   * main driveStream loop does: a real rate-limit, or a failure from a PAID
   * cloud model that looks rate-limit-shaped (empty response, timeout, or a
   * provider_error whose text carries HTTP 429/402 or rate-limit wording —
   * a bare 422/403 client error is NOT escalated; see the 2026-09-27
   * incident), gets a hard cooldown + key rotation via recordLimit(). A
   * FREE-model or local-model failure gets only the short soft-backoff
   * ladder, since those are commonly just transient overload.
   *
   * The escalation predicate (isPaidCloudRateLimitFailure, src/detection.ts)
   * is the single source of truth shared with the caller's own branch in the
   * main driveStream loop — that caller decides which user-facing message to
   * show ("treated as rate-limit" vs a plain soft-failure notice) based on
   * the same function, so the two can no longer diverge (roborev job 348 LOW
   * — they had already drifted out of sync once this session before this
   * extraction).
   *
   * Used both by the main candidate loop and by the total-cooldown-collapse
   * force-retry, so a force-retried candidate that turns out to still be
   * rate-limited escalates the same way instead of getting a token-cheap
   * soft cooldown that lets it be force-retried again almost immediately.
   *
   * ALSO the single push site of the session_errors ring buffer (owner
   * decision 2026-09-27): every main-session stream failure lands here, so
   * the status-line counter and /router errors are fed by the exact same
   * events. Probe/scan/classifier paths never call this function — the
   * free-model 429 noise wave cannot flood the buffer.
   */
  function recordStreamFailure(
    ref: string,
    reason: string,
    resetAtMs?: number,
    errorText?: string
  ): { hardLimited: boolean; rotated: boolean; newKey: string | undefined } {
    if (reason === 'rate_limit_exceeded' || isPaidCloudRateLimitFailure(ref, reason, errorText)) {
      const rlResult = recordLimit(ref, resetAtMs);
      // Consequence label (incl. key-rotation) built in the testable seam
      // src/session-errors.ts (review I3/I4).
      recordSessionErrorFromFailure({
        cache: d.cache,
        ref,
        reason,
        ...(errorText ? { errorText } : {}),
        hardLimited: true,
        rotated: rlResult.rotated,
        limitSecs: limitSecs(ref),
      });
      d.updateErrorStatusLine();
      d.scheduleSessionErrorSave();
      return { hardLimited: true, rotated: rlResult.rotated, newKey: rlResult.newKey };
    }
    recordSoftFailure(ref);
    recordSessionErrorFromFailure({
      cache: d.cache,
      ref,
      reason,
      ...(errorText ? { errorText } : {}),
      hardLimited: false,
      rotated: false,
      limitSecs: 0,
    });
    d.updateErrorStatusLine();
    d.scheduleSessionErrorSave();
    return { hardLimited: false, rotated: false, newKey: undefined };
  }

  function limitSecs(ref: string) {
    return d.rateLimitManager.limitSecs(ref);
  }

/**
 * Locale-independent duration for narration: "45s", "4m", "2h 05m", "7d".
 * Deterministic by construction (no Intl, no locale digits).
 */
function humanizeShortDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 36) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.round(h / 24)}d`;
}

/**
 * Locale-independent local wall-clock "HH:MM" (live finding 2026-10-03:
 * toLocaleString() rendered de-DE on one machine and en-US on another, and
 * the bare local time next to the UTC log timestamp read like a two-hour
 * gap when it was two minutes). Manual formatting is stable across hosts.
 */
function formatLocalHm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
   * Builds the reset/backoff suffix for a rate-limit router-info
   * message. Prefers the parsed provider reset time (resetAtMs) when
   * available — the accurate case. Otherwise falls back to the router's own
   * computed cooldown_until (the escalating backoff, or whatever
   * recordStreamFailure actually set) so the user always sees a concrete
   * wall-clock time instead of a mystery cooldown when the failure text
   * couldn't be parsed for a reset time. Omitted when the ref was
   * key-rotated — no cooldown was applied to it in that case (a different
   * key will be tried next time), so there's no meaningful reset time to show.
   */
  function formatResetMsg(ref: string, resetAtMs: number | undefined, rotated?: boolean): string {
    // A reset time the PROVIDER announced (parsed from the failure text) —
    // "resets" is the provider's word. Without one, only show the router's
    // own cooldown end, worded as such: presenting our backoff as a
    // provider reset fabricates a time the provider never sent (claude-bridge
    // empty responses, live finding 2026-10-03: "resets 10/3/2026, 12:23:53
    // PM" — the bridge said nothing of the sort).
    if (resetAtMs) return ` (resets in ${humanizeShortDuration(resetAtMs - Date.now())}, at ${formatLocalHm(resetAtMs)})`;
    if (rotated) return '';
    const secs = limitSecs(ref);
    if (secs <= 0) return '';
    return ` (backing off ${humanizeShortDuration(secs * 1000)}, until ${formatLocalHm(Date.now() + secs * 1000)})`;
  }

  /**
   * OpenRouter's free-models-per-day cap is ACCOUNT-WIDE: one 429 covers
   * every openrouter/*:free model, and it resets at 00:00 UTC (live finding
   * 2026-10-03 — per-model 60s backoffs re-burned a doomed attempt per
   * candidate on every turn for the rest of the day). Sets a hard cooldown
   * until `untilMs` on every known :free ref — the current cascade's
   * candidates plus the discovery cache, so future turns skip them too —
   * WITHOUT recording session errors or failure streaks: the siblings are
   * consequences of one account-level event, not separate model failures.
   */
  function limitFreeDayCap(candidates: string[], untilMs: number): number {
    const refs = new Set<string>();
    for (const c of candidates) {
      if (c.startsWith('openrouter/') && c.endsWith(':free')) refs.add(c);
    }
    for (const m of d.cache.available_models ?? []) {
      if (m && m.provider === 'openrouter' && String(m.id).endsWith(':free')) {
        refs.add(`${m.provider}/${m.id}`);
      }
    }
    for (const ref of refs) d.rateLimitManager.recordLimit(ref, d.cfg.providers ?? {}, untilMs);
    return refs.size;
  }

  // ── Usage Stats ────────────────────────────────────────────────────────

  function getUsage(ref: string, days: number): number {
    return metricsModule.getUsage(ref, days);
  }

  // ── Price lookup (OpenRouter as oracle) ─────────────────────────────────

  function lookupPrice(ref: string): { input: number | 'unknown'; output: number | 'unknown' } | null {
    return metricsModule.lookupPrice(ref);
  }

  // ── Effective cost ─────────────────────────────────────────────────────

  function effCost(ref: string): number | 'unknown' {
    return metricsModule.effCost(ref);
  }

  return { resolveKeyValue, getM, costMux, isLimited, limitSecs, effCost, clearLimit, recordOk, observeFailure, recordStreamFailure, formatResetMsg, limitFreeDayCap, updateMetrics, lookupPrice, formatBlocklist, getUsage };
}
