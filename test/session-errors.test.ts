// test/session-errors.test.ts
//
// Locks the /router errors feature to the owner's CORRELATION requirement
// (2026-09-27): "when the status line shows three errors, I want to see
// exactly those three." One ring buffer (persisted, FIFO cap) is the single
// source of truth for BOTH the status-line counter (entries with ts >=
// sessionStart) and the /router errors report. Scope: MAIN-SESSION stream
// failures only — recordStreamFailure is the push site; probe/scan paths
// (recordBlocklistFailure etc.) must not flood the buffer.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SESSION_ERROR_CAP,
  pushSessionError,
  recordSessionErrorFromFailure,
  sessionErrors,
  countSessionErrorsSince,
  formatErrorsReport,
} from '../src/session-errors.ts';
import { recordBlocklistFailure } from '../src/model-blocklist.ts';
import { CacheManager } from '../src/cache.ts';
import type { Cache } from '../src/types.ts';

function freshCache(): Cache {
  return {} as Cache;
}

const T0 = 1_700_000_000_000;

describe('recordSessionErrorFromFailure (push-site seam, review I3/I4)', () => {
  it('hard limit WITHOUT key rotation → cooldown <secs>s', () => {
    const cache = freshCache();
    recordSessionErrorFromFailure({ cache, ref: 'mistral/zai-glm-5-3', reason: 'rate_limit_exceeded', hardLimited: true, rotated: false, limitSecs: 120, now: T0 });
    expect(sessionErrors(cache)[0].consequence).toBe('cooldown 120s');
  });

  it('hard limit WITH key rotation → key rotated (NOT cooldown 0s — review I4)', () => {
    const cache = freshCache();
    // recordLimit rotates first and sets NO cooldown on the ref; a naive
    // `cooldown ${limitSecs}s` label would read 'cooldown 0s' and poison
    // incident analysis.
    recordSessionErrorFromFailure({ cache, ref: 'mistral/zai-glm-5-3', reason: 'rate_limit_exceeded', hardLimited: true, rotated: true, limitSecs: 0, now: T0 });
    expect(sessionErrors(cache)[0].consequence).toBe('key rotated');
  });

  it('soft path → soft backoff, with detail threaded and sanitized', () => {
    const cache = freshCache();
    recordSessionErrorFromFailure({
      cache,
      ref: 'mistral/mistral-medium-3.5',
      reason: 'provider_error',
      errorText: '422 status\ncode (no\tbody)',
      hardLimited: false,
      rotated: false,
      limitSecs: 0,
      now: T0,
    });
    const e = sessionErrors(cache)[0];
    expect(e.consequence).toBe('soft backoff');
    expect(e.detail).toBe('422 status code (no body)'); // whitespace collapsed
  });
});

describe('probe paths do NOT touch the buffer (scope decision)', () => {
  it('recordBlocklistFailure (probe/scan path) leaves session_errors empty', () => {
    const cache = freshCache();
    // Verbatim router.log guardrail signature (as pinned in
    // model-blocklist.test.ts) — known-permanent, recorded by probes.
    const GUARDRAIL =
      '404: {"message":"0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy. We removed them for the following reasons (an endpoint may have matched multiple reasons):\\nFree model training violation (guardrail): 1 endpoint excluded","code":404,"metadata":{"input_endpoint_count":1,"ineligibility_reasons":[{"reason":"free-model-training-violation-by-guardrail","endpoint_count":1}],"failed_routing_step":"Filter by Guardrails"}}';
    recordBlocklistFailure(cache, 'openrouter/thinkingmachines/inkling:free', GUARDRAIL);
    expect(cache.model_blocklist).toBeDefined();
    expect(sessionErrors(cache)).toEqual([]); // the 429/404 noise wave stays out
  });
});

describe('persistence round-trip (review I3)', () => {
  it('CacheManager save → fresh load keeps the buffer intact', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-errors-'));
    fs.mkdirSync(path.join(dir, '.cache'), { recursive: true });
    const file = path.join(dir, '.cache', 'scan-cache.json');
    fs.writeFileSync(file, JSON.stringify({ available_models: [] }));
    const cm = new CacheManager(dir);
    const cache = cm.loadCache();
    pushSessionError(cache, { ts: T0, ref: 'mistral/zai-glm-5-3', reason: 'provider_error', detail: 'boom', consequence: 'soft backoff' });
    cm.saveCache(cache);

    // a fresh manager (e.g. next pi process) sees the same persisted entries
    const cm2 = new CacheManager(dir);
    const reloaded = cm2.loadCache();
    expect(reloaded.session_errors).toHaveLength(1);
    expect(reloaded.session_errors![0]).toEqual({ ts: T0, ref: 'mistral/zai-glm-5-3', reason: 'provider_error', detail: 'boom', consequence: 'soft backoff', pid: process.pid });
  });
});

describe('session-errors ring buffer', () => {
  it('pushes entries chronologically and persists via the cache object', () => {
    const cache = freshCache();
    pushSessionError(cache, { ts: T0, ref: 'mistral/zai-glm-5-3', reason: 'provider_error', detail: '422 status code (no body)', consequence: 'soft backoff' });
    pushSessionError(cache, { ts: T0 + 5_000, ref: 'mistral/mistral-medium-3.5', reason: 'rate_limit_exceeded', consequence: 'cooldown 120s' });
    const entries = sessionErrors(cache);
    expect(entries).toHaveLength(2);
    expect(entries[0].ref).toBe('mistral/zai-glm-5-3');
    expect(entries[1].consequence).toBe('cooldown 120s');
  });

  it('caps the buffer at SESSION_ERROR_CAP (FIFO — oldest dropped)', () => {
    const cache = freshCache();
    for (let i = 0; i < SESSION_ERROR_CAP + 10; i++) {
      pushSessionError(cache, { ts: T0 + i, ref: `m/${i}`, reason: 'provider_error', consequence: 'soft backoff' });
    }
    const entries = sessionErrors(cache);
    expect(entries).toHaveLength(SESSION_ERROR_CAP);
    // oldest surviving entry is the 11th pushed (first 10 dropped)
    expect(entries[0].ref).toBe('m/10');
    expect(entries[entries.length - 1].ref).toBe(`m/${SESSION_ERROR_CAP + 9}`);
  });

  it('corrupted cache (non-array session_errors) is repaired, not thrown (review M3)', () => {
    const cache = freshCache();
    (cache as any).session_errors = 'corrupted';
    expect(() =>
      pushSessionError(cache, { ts: T0, ref: 'm/a', reason: 'provider_error', consequence: 'soft backoff' })
    ).not.toThrow();
    expect(Array.isArray(cache.session_errors)).toBe(true);
    expect(sessionErrors(cache)).toHaveLength(1);
  });

  it('trims detail snippets to 120 chars', () => {
    const cache = freshCache();
    const long = 'x'.repeat(300);
    pushSessionError(cache, { ts: T0, ref: 'm/a', reason: 'provider_error', detail: long, consequence: 'soft backoff' });
    expect(sessionErrors(cache)[0].detail).toHaveLength(120);
  });
});

describe('session-errors status correlation', () => {
  it('countSessionErrorsSince counts ONLY entries at/after sessionStart', () => {
    const cache = freshCache();
    const sessionStart = T0 + 100;
    // two from an earlier process (persisted history), three this session
    pushSessionError(cache, { ts: T0, ref: 'm/old1', reason: 'provider_error', consequence: 'soft backoff' });
    pushSessionError(cache, { ts: T0 + 50, ref: 'm/old2', reason: 'provider_error', consequence: 'soft backoff' });
    pushSessionError(cache, { ts: sessionStart, ref: 'm/now1', reason: 'rate_limit_exceeded', consequence: 'cooldown 60s' });
    pushSessionError(cache, { ts: sessionStart + 10, ref: 'm/now2', reason: 'empty_response', consequence: 'soft backoff' });
    pushSessionError(cache, { ts: sessionStart + 20, ref: 'm/now3', reason: 'provider_error', consequence: 'soft backoff' });

    expect(countSessionErrorsSince(cache, sessionStart)).toBe(3);
  });
});

describe('formatErrorsReport', () => {
  it('headline count matches the status-line count exactly; older entries below a divider', () => {
    const cache = freshCache();
    const sessionStart = T0 + 100;
    pushSessionError(cache, { ts: T0, ref: 'm/old', reason: 'provider_error', detail: 'old failure', consequence: 'soft backoff' });
    pushSessionError(cache, { ts: sessionStart + 1, ref: 'mistral/zai-glm-5-3', reason: 'rate_limit_exceeded', detail: 'Too many requests', consequence: 'cooldown 120s' });
    pushSessionError(cache, { ts: sessionStart + 2, ref: 'mistral/mistral-medium-3.5', reason: 'provider_error', detail: '422 status code (no body)', consequence: 'soft backoff' });

    const report = formatErrorsReport(cache, sessionStart, 15);
    // headline: exactly the status-line count (2), not the buffer size (3)
    expect(report).toMatch(/Errors this session: 2/);
    // both session entries with model, reason, consequence, detail
    expect(report).toContain('mistral/zai-glm-5-3');
    expect(report).toContain('rate_limit_exceeded');
    expect(report).toContain('cooldown 120s');
    expect(report).toContain('422 status code (no body)');
    // the older entry is separated under a divider
    expect(report).toMatch(/earlier|history/i);
    expect(report).toContain('m/old');
  });

  it('respects the limit (default 15): newest entries win', () => {
    const cache = freshCache();
    for (let i = 0; i < 20; i++) {
      pushSessionError(cache, { ts: T0 + i, ref: `m/${String(i).padStart(2, '0')}`, reason: 'provider_error', consequence: 'soft backoff' });
    }
    const report = formatErrorsReport(cache, T0, 5);
    expect(report).toContain('m/19');
    expect(report).toContain('m/15');
    expect(report).not.toContain('m/14');
  });

  it('empty buffer → honest empty state', () => {
    const report = formatErrorsReport(freshCache(), T0, 15);
    expect(report).toMatch(/no errors/i);
  });
});
