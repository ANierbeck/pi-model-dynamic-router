// src/session-errors.ts
//
// Ring buffer of MAIN-SESSION stream failures — the single source of truth
// behind BOTH the pi status-line counter and the `/router errors` command
// (owner requirement 2026-09-27: "when the status line shows three errors,
// I want to see exactly those three" — one buffer, one count, 1:1
// correlation by construction).
//
// Push site: `recordStreamFailure()` in index.ts — the existing single
// recording site for main-session candidate failures (the four orchestrator
// call sites). Probe/scan/classifier paths do NOT call it, so the free-model
// 429 noise wave cannot flood the buffer (owner scope decision).
//
// Persistence: the buffer lives on the cache object (scan-cache.json via the
// cache manager) — NEVER in module variables (esbuild double-bundle hazard,
// same rationale as model-blocklist.ts). Entries survive restarts; the
// STATUS COUNTER only counts entries with ts >= sessionStart, so a fresh
// pi process starts at ⚠0 while `/router errors` still offers the persisted
// history below a divider for diagnosis.

import type { Cache, SessionError } from './types.ts';

/** Max entries kept (FIFO — oldest dropped). Self-trimming; no clear needed. */
export const SESSION_ERROR_CAP = 50;

/** Max length of the detail snippet stored per entry. */
const DETAIL_TRIM = 120;

// SessionError lives in types.ts (referenced by the Cache shape).

/** Append an entry; trims detail; enforces the FIFO cap. */
export function pushSessionError(cache: Cache, entry: SessionError): void {
  // Guard against a corrupted/hand-edited cache file: a non-array here would
  // throw INSIDE recordStreamFailure and break the escalation path
  // mid-failure (review M3, 2026-09-27).
  if (!Array.isArray(cache.session_errors)) cache.session_errors = [];
  const trimmed: SessionError = {
    ts: entry.ts,
    ref: entry.ref,
    reason: entry.reason,
    consequence: entry.consequence,
    // Provenance for the per-project split (2026-10-03): concurrent pi
    // instances' windows overlap, so ts >= sessionStart alone lets another
    // process's errors count into OUR status line. Entries without a pid
    // (pre-split history) keep the old counting behavior.
    pid: entry.pid ?? process.pid,
    ...(entry.detail !== undefined
      ? // Collapse whitespace: provider errors are often multi-line and would
        // break the one-line table rows of formatErrorsReport (review M4).
        { detail: entry.detail.replace(/\s+/g, ' ').trim().slice(0, DETAIL_TRIM) }
      : {}),
  };
  cache.session_errors.push(trimmed);
  if (cache.session_errors.length > SESSION_ERROR_CAP) {
    cache.session_errors.splice(0, cache.session_errors.length - SESSION_ERROR_CAP);
  }
}

/**
 * The push-site decision extracted from index.ts's recordStreamFailure so it
 * is testable (review I3): builds the consequence label from what actually
 * happened. Key rotation (recordLimit rotated to another API key, rate-limit.ts
 * sets NO cooldown on the ref in that case) must NOT read as 'cooldown 0s' —
 * that would poison incident analysis (review I4).
 */
export function recordSessionErrorFromFailure(deps: {
  cache: Cache;
  ref: string;
  reason: string;
  errorText?: string;
  hardLimited: boolean;
  rotated: boolean;
  limitSecs: number;
  now?: number;
}): void {
  pushSessionError(deps.cache, {
    ts: deps.now ?? Date.now(),
    ref: deps.ref,
    reason: deps.reason,
    ...(deps.errorText ? { detail: deps.errorText } : {}),
    consequence: deps.hardLimited
      ? deps.rotated
        ? 'key rotated'
        : `cooldown ${deps.limitSecs}s`
      : 'soft backoff',
  });
}

/** Chronological entries (oldest first). */
export function sessionErrors(cache: Cache): SessionError[] {
  return cache.session_errors ?? [];
}

/**
 * The status-line count: entries at/after the current process's sessionStart.
 * This is the number shown in the footer (⚠N err) and the headline of
 * `/router errors` — the correlation anchor.
 */
export function countSessionErrorsSince(cache: Cache, sessionStartTs: number, pid?: number): number {
  return sessionErrors(cache).filter(
    (e) => e.ts >= sessionStartTs && (pid === undefined || e.pid === undefined || e.pid === pid)
  ).length;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
}

function fmtModel(ref: string, width: number): string {
  return ref.length > width ? ref.slice(0, width - 1) + '…' : ref.padEnd(width);
}

/**
 * The `/router errors [n]` report. Headline count is EXACTLY the status-line
 * count (countSessionErrorsSince); the current session's newest `limit`
 * entries follow; older persisted entries appear below a divider (history
 * context without breaking correlation).
 */
export function formatErrorsReport(
  cache: Cache,
  sessionStartTs: number,
  limit = 15,
  pid?: number
): string {
  const all = sessionErrors(cache);
  if (all.length === 0) {
    return 'No errors recorded (main-session stream failures appear here; the status line counts them as ⚠N err).';
  }
  // Same pid scoping as countSessionErrorsSince: a second pi instance in the
  // SAME project shares the persisted buffer, and its post-sessionStart
  // entries must not break the "⚠N err == headline == N events" correlation
  // (review Minor 2026-10-04). Entries without a pid (pre-split history)
  // keep the old behavior.
  const own = (e: SessionError) => pid === undefined || e.pid === undefined || e.pid === pid;
  const sessionEntries = all.filter((e) => e.ts >= sessionStartTs && own(e));
  const older = all.filter((e) => e.ts < sessionStartTs || !own(e));
  const lines: string[] = [`Errors this session: ${sessionEntries.length}`];
  if (sessionEntries.length === 0) lines.push('  (none this session)');
  const showSession = sessionEntries.slice(-limit);
  for (const e of showSession) {
    lines.push(
      `  ${fmtTime(e.ts)}  ${fmtModel(e.ref, 34)} ${e.reason.padEnd(20)} ${e.consequence.padEnd(14)} ${e.detail ?? ''}`.trimEnd()
    );
  }
  const omitted = sessionEntries.length - showSession.length;
  if (omitted > 0) lines.push(`  … ${omitted} older session error(s) omitted (raise the limit: /router errors ${limit + omitted})`);
  if (older.length > 0) {
    lines.push('');
    lines.push(`--- earlier (persisted history, ${older.length}) ---`);
    for (const e of older.slice(-limit)) {
      lines.push(
        `  ${fmtTime(e.ts)}  ${fmtModel(e.ref, 34)} ${e.reason.padEnd(20)} ${e.consequence.padEnd(14)} ${e.detail ?? ''}`.trimEnd()
      );
    }
  }
  return lines.join('\n');
}
