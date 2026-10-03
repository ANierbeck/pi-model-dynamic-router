/**
 * Owner decision 2026-10-03: instance-scoped state must live in the PROJECT
 * directory, not in the router package's global scan cache.
 *
 * Live finding: three concurrent pi instances (different projects) share
 * one dist/.cache/scan-cache.json. saveCache wrote the in-memory object
 * blindly, so the last writer erased the other processes' session_errors
 * and usage_log ("/router cost" windows went structurally zero; another
 * live session's 32 recorded errors were overwritten by a sibling
 * session's save). Writes were also non-atomic — a reader mid-write saw an
 * unparseable file and silently started from an empty cache.
 *
 * Fix (owner picked "instance data only"):
 * - session_errors + usage_log persist to <process-cwd>/.pi/cache/router-state.json
 *   (one process = one project; pi is started in the project dir).
 * - Everything global (scan inventory, gdpval, pricing, cooldowns, blocklist,
 *   health) stays in the shared scan-cache.json — no re-scans, shared
 *   learning preserved.
 * - Both files are written atomically (tmp + rename).
 * - The global save MERGES what other processes wrote since the last sync
 *   (same memory-wins semantics as loadCache) instead of clobbering it.
 * - session_errors entries carry the recording process's pid; the status
 *   counter ignores other processes' entries (their windows overlap).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CacheManager } from '../src/cache.ts';
import { pushSessionError, countSessionErrorsSince, SESSION_ERROR_CAP } from '../src/session-errors.ts';
import type { Cache } from '../src/types.ts';

const stateDir = path.join(os.tmpdir(), 'router-state-global');
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-state-project-'));
const globalCache = () => path.join(stateDir, '.cache', 'scan-cache.json');
const projectState = () => path.join(projectDir, '.pi', 'cache', 'router-state.json');
const readJson = (p: string) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {});
beforeEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(projectState(), { force: true });
});

describe('CacheManager: per-project instance state', () => {
  it('persists session_errors and usage_log to <cwd>/.pi/cache/, not to the global scan cache', () => {
    const mgr = new CacheManager(stateDir, undefined, projectDir);
    const cache = mgr.getCache();
    pushSessionError(cache, {
      ts: Date.now(), ref: 'mistral/x', reason: 'rate_limit_exceeded',
      consequence: 'trying next',
    });
    (cache as any).available_models = [{ provider: 'mistral', id: 'x' }];
    mgr.addUsageLogEntry('mistral/x', 1234);
    mgr.saveCache();

    const proj = readJson(projectState());
    expect(Array.isArray(proj.session_errors)).toBe(true);
    expect(proj.session_errors).toHaveLength(1);
    expect(Array.isArray(proj.usage_log)).toBe(true);
    expect(proj.usage_log).toHaveLength(1);
    expect(proj.available_models).toBeUndefined();

    const glob = readJson(globalCache());
    expect(glob.session_errors).toBeUndefined();
    expect(glob.usage_log).toBeUndefined();
    expect(Array.isArray(glob.available_models)).toBe(true);
  });

  it('adopts session_errors/usage_log from a legacy global cache exactly once', () => {
    // A pre-split global cache carries instance data plus global data.
    fs.mkdirSync(path.dirname(globalCache()), { recursive: true });
    const legacy: Cache = {
      session_errors: [{ ts: 1, ref: 'a/b', reason: 'r', consequence: 'c' }],
      usage_log: [{ ref: 'a/b', tokens: 5, ts: 2 }],
      models_cached: 'x',
    };
    fs.writeFileSync(globalCache(), JSON.stringify(legacy, null, 2));

    const mgr = new CacheManager(stateDir, undefined, projectDir);
    const cache = mgr.getCache();
    expect(cache.session_errors).toHaveLength(1);
    expect(cache.usage_log).toHaveLength(1);
    mgr.saveCache();

    // Moved to the project file, stripped from the global one.
    expect(readJson(projectState()).session_errors).toHaveLength(1);
    expect(readJson(globalCache()).session_errors).toBeUndefined();
    expect(readJson(globalCache()).models_cached).toBe('x');
  });

  it('loadCache keeps entries pushed during the save-debounce window (review P1 2026-10-04)', () => {
    const mgr = new CacheManager(stateDir, undefined, projectDir);
    const cache = mgr.getCache();
    pushSessionError(cache, { ts: 1, ref: 'a/b', reason: 'r', consequence: 'c' });
    mgr.saveCache();
    // Pushed but NOT saved: index.ts debounces the session-error save by 2s,
    // and a subagent session_start can run loadCache() inside that window.
    pushSessionError(cache, { ts: 2, ref: 'a/c', reason: 'r', consequence: 'c' });

    // index.ts rebuilds the manager on load() but keeps the one cache object.
    const mgr2 = new CacheManager(stateDir, mgr.getCache(), projectDir);
    mgr2.loadCache();
    expect((mgr2.getCache().session_errors ?? []).map((e) => e.ts)).toEqual([1, 2]);
    mgr2.saveCache();
    const proj = readJson(projectState());
    expect((proj.session_errors ?? []).map((e: any) => e.ts)).toEqual([1, 2]);
  });

  it("loadCache unions another process's new entries without dropping our unsaved ones", () => {
    const mgr = new CacheManager(stateDir, undefined, projectDir);
    const cache = mgr.getCache();
    pushSessionError(cache, { ts: 1, ref: 'a/b', reason: 'r', consequence: 'c' });
    mgr.saveCache();
    pushSessionError(cache, { ts: 2, ref: 'a/c', reason: 'r', consequence: 'c' }); // unsaved
    // A concurrent same-project instance persists its own entry.
    const disk = readJson(projectState());
    disk.session_errors.push({ ts: 3, ref: 'p/q', reason: 'r', consequence: 'c', pid: 4242 });
    fs.writeFileSync(projectState(), JSON.stringify(disk, null, 2));

    const mgr2 = new CacheManager(stateDir, mgr.getCache(), projectDir);
    mgr2.loadCache();
    expect((mgr2.getCache().session_errors ?? []).map((e) => e.ts)).toEqual([1, 2, 3]);
  });

  it('merges another process\'s global writes instead of clobbering them (merge-on-save)', () => {
    const mgr = new CacheManager(stateDir, undefined, projectDir);
    mgr.getCache().models_cached = 'mine';
    mgr.saveCache();

    // Another process writes between our load and our next save.
    fs.writeFileSync(globalCache(), JSON.stringify({ ...readJson(globalCache()), gdpval_scraped: true }, null, 2));

    mgr.getCache().models_cached = 'mine-2';
    mgr.saveCache();
    const onDisk = readJson(globalCache());
    expect(onDisk.models_cached).toBe('mine-2'); // memory wins for keys it has
    expect(onDisk.gdpval_scraped).toBe(true); // other process's addition survives
  });

  it('does not lose another process\'s project-state entries on save', () => {
    const mgr = new CacheManager(stateDir, undefined, projectDir);
    mgr.getCache().session_errors = [];
    mgr.saveCache();

    // A concurrent same-project instance recorded an error directly to disk.
    const disk = readJson(projectState());
    disk.session_errors = [{ ts: 42, ref: 'p/q', reason: 'r', consequence: 'c', pid: 4242 }];
    fs.writeFileSync(projectState(), JSON.stringify(disk, null, 2));

    pushSessionError(mgr.getCache(), {
      ts: 99, ref: 'a/b', reason: 'r2', consequence: 'c2',
    });
    mgr.saveCache();
    const merged = readJson(projectState()).session_errors as any[];
    expect(merged.some((e) => e.ts === 42 && e.pid === 4242)).toBe(true);
    expect(merged.some((e) => e.ts === 99)).toBe(true);
    // Sorted oldest-first and capped.
    expect(merged.map((e) => e.ts)).toEqual([...merged.map((e) => e.ts)].sort((a, b) => a - b));
  });

  it('writes atomically: the file always parses and no tmp leftovers remain', () => {
    const mgr = new CacheManager(stateDir, undefined, projectDir);
    mgr.getCache().models_cached = 'x'.repeat(10_000);
    mgr.saveCache();
    expect(() => JSON.parse(fs.readFileSync(globalCache(), 'utf-8'))).not.toThrow();
    const leftovers = fs.readdirSync(path.dirname(globalCache())).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('loads instance data from the project file, global data from the scan cache', () => {
    fs.mkdirSync(path.dirname(projectState()), { recursive: true });
    fs.writeFileSync(projectState(), JSON.stringify({
      session_errors: [{ ts: 7, ref: 'a/b', reason: 'r', consequence: 'c', pid: 1 }],
    }));
    fs.mkdirSync(path.dirname(globalCache()), { recursive: true });
    fs.writeFileSync(globalCache(), JSON.stringify({ models_cached: 'g' }));

    const mgr = new CacheManager(stateDir, undefined, projectDir);
    const cache = mgr.getCache();
    expect(cache.session_errors).toHaveLength(1);
    expect(cache.models_cached).toBe('g');
  });
});

describe('session_errors: process provenance', () => {
  it('stamps entries with the recording pid; the counter ignores other processes', () => {
    const cache: Cache = {};
    const t0 = Date.now() - 1000;
    pushSessionError(cache, { ts: t0 + 1, ref: 'a/b', reason: 'r', consequence: 'c' });
    (cache.session_errors as any[])[0].pid = 111; // simulate another process's entry
    pushSessionError(cache, { ts: t0 + 2, ref: 'a/c', reason: 'r', consequence: 'c' });
    expect((cache.session_errors as any[])[1].pid).toBe(process.pid);

    // Own entries count, the other process's does not.
    expect(countSessionErrorsSince(cache, t0, process.pid)).toBe(1);
    // Legacy entries without a pid still count (pre-split history).
    (cache.session_errors as any[])[0].pid = undefined;
    expect(countSessionErrorsSince(cache, t0, process.pid)).toBe(2);
    // Old callers (no pid) keep the pre-existing behavior.
    expect(countSessionErrorsSince(cache, t0)).toBe(2);
    // The FIFO cap still applies.
    for (let i = 0; i < SESSION_ERROR_CAP + 5; i++) {
      pushSessionError(cache, { ts: t0 + 10 + i, ref: `m/${i}`, reason: 'r', consequence: 'c' });
    }
    expect(cache.session_errors).toHaveLength(SESSION_ERROR_CAP);
  });
});
