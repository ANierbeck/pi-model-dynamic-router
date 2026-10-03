// src/cache.ts
// Cache handling for the pi-model-router

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Cache, SessionError } from './types.ts';

/** The usage_log entry shape (inline in types.ts's Cache interface). */
type UsageEntry = { ref: string; tokens: number; ts: number };
import { SESSION_ERROR_CAP } from './session-errors.ts';

// ── Cache Management ───────────────────────────────────────────────────────

// Per cache object: the file state (mtime + size) it was last synced with,
// by a read or a write. Keyed by the object, not the manager, because index.ts
// rebuilds the manager on every load() but keeps the one cache object.
const lastSync = new WeakMap<Cache, string>();
// Same, for the per-project instance-state file.
const lastProjectSync = new WeakMap<Cache, string>();

/**
 * Instance-scoped state — persisted to <process-cwd>/.pi/cache/, NOT to the
 * shared scan cache (owner decision 2026-10-03). Live finding: three
 * concurrent pi instances in different projects share the router package's
 * scan-cache.json; blind last-writer-wins saves erased each other's
 * session_errors and usage_log. One process = one project (pi is started in
 * the project dir), so index.ts passes process.cwd() as the scope. Worktree subagents
 * share the main process and thus the main project's file — documented
 * limitation, mirrors the pre-split behavior where everything went to one
 * global file anyway.
 */
const INSTANCE_KEYS = ['session_errors', 'usage_log'] as const;



/** Atomic JSON write: temp file in the same directory, then rename. */
function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function fileStateOf(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '';
  }
}

function readJsonIfExists(file: string): Record<string, unknown> {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    /* absent or torn */
  }
  return {};
}

/**
 * Append-merge instance entries: memory entries not already on disk are
 * added, disk entries are kept, the result is sorted by `ts` ascending.
 *
 * Deliberately NO within-side dedupe (live pin: two REAL failed attempts in
 * the same millisecond — same ref, same reason, same detail — must both
 * survive; a value-union collapsed them and broke the "one entry per real
 * attempt" contract). Memory entries already present on disk (from an
 * earlier save of this process) are dropped by the key so re-saves do not
 * accumulate duplicates. Cross-process collisions of byte-identical entries
 * within one millisecond are accepted and documented.
 */
function appendInstanceArray<T extends { ts: number }>(
  disk: T[] | undefined,
  memory: T[] | undefined,
  entryKey: (e: T) => string
): T[] {
  const diskKeys = new Set((disk ?? []).map(entryKey));
  const out: T[] = [...(disk ?? [])];
  for (const e of memory ?? []) if (!diskKeys.has(entryKey(e))) out.push(e);
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/**
 * Adds what another process wrote without discarding in-memory state: keys
 * the memory lacks are taken from disk, and for record-valued keys
 * (model_blocklist, exhausted_keys, …) the missing entries. On a conflict
 * the memory wins — it may hold changes not saved yet.
 */
function mergeExternal(memory: Cache, disk: Cache): void {
  const mem = memory as Record<string, unknown>;
  for (const [key, diskValue] of Object.entries(disk as Record<string, unknown>)) {
    const memValue = mem[key];
    if (memValue === undefined) {
      mem[key] = diskValue;
    } else if (isRecord(memValue) && isRecord(diskValue)) {
      for (const [sub, v] of Object.entries(diskValue)) if (!(sub in memValue)) memValue[sub] = v;
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Manages the cache for the pi-model-router
 */
export class CacheManager {
  private cache: Cache;
  private cachePath: string;

  /**
   * `existing` is the caller's in-memory cache: a manager rebuilt on reload
   * must keep writing that one object instead of a fresh copy from disk.
   */
  private readonly projectPath: string | null;

  /**
   * `projectDir` scopes the instance state (session_errors, usage_log) to
   * <projectDir>/.pi/cache/router-state.json — the owner's "instance data
   * lives in the project directory" decision. Omit it and instance keys keep
   * persisting to the global scan cache (the pre-split behavior — used by
   * tests and any embedding that manages state itself). index.ts passes
   * process.cwd(): one pi process = one project.
   */
  constructor(stateDir: string, existing?: Cache, projectDir?: string) {
    this.cachePath = path.join(stateDir, '.cache', 'scan-cache.json');
    this.projectPath = projectDir ? path.join(projectDir, '.pi', 'cache', 'router-state.json') : null;
    if (existing) {
      this.cache = existing;
    } else {
      this.cache = {};
      this.loadCache();
    }
  }

  /** mtime + size of the cache file, or '' when there is none. */
  private fileState(): string {
    try {
      const st = fs.statSync(this.cachePath);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return '';
    }
  }

  private readFromDisk(): Cache {
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      if (fs.existsSync(this.cachePath)) {
        return JSON.parse(fs.readFileSync(this.cachePath, 'utf-8'));
      }
    } catch {
      /* first run */
    }
    return {};
  }

  /**
   * Syncs the manager's object with disk and returns it; the object's identity
   * never changes, so every holder (index.ts, DiscoveryManager,
   * RateLimitManager, router, metrics) keeps seeing the same state.
   *
   * - First load of an object: fills it from disk.
   * - Later loads (every session_start, in-process subagents included): the
   *   memory is authoritative — the router saves only every 10 turns, so
   *   rate-limit cooldowns, model health, watchdog state and Tier-2 streaks
   *   may not be on disk yet. Disk is read only if another process wrote the
   *   file since the last sync, and its additions are merged in
   *   (mergeExternal). Review 2026-09-27: replacing the object's contents
   *   dropped that state; replacing the object let a stale holder undo the
   *   re-read and overwrite the other process's writes.
   */
  loadCache(): Cache {
    const known = lastSync.get(this.cache);
    const state = this.fileState();
    if (known !== undefined && known === state) {
      this.loadInstanceState();
      return this.cache;
    }
    const disk = this.readFromDisk();
    if (known === undefined && Object.keys(this.cache).length === 0) Object.assign(this.cache, disk);
    else mergeExternal(this.cache, disk);
    lastSync.set(this.cache, state);
    this.loadInstanceState();
    return this.cache;
  }

  /**
   * Overlays the per-project instance state (session_errors, usage_log)
   * from <projectDir>/.pi/cache/router-state.json.
   *
   * - File unchanged since our last overlay/save → SKIP: memory is
   *   authoritative (it may hold entries pushed during the 2s save-debounce
   *   window; a wholesale replace here silently dropped them — review P1
   *   2026-10-04, the exact state-loss class this round set out to fix).
   * - File changed (another process wrote) → UNION: disk entries plus our
   *   not-yet-saved memory entries, deduped across the boundary only
   *   (appendInstanceArray — within-side duplicates are real events).
   * - File has no entry for a key → whatever memory holds stays (pre-split
   *   legacy data from the global cache is adopted on the next save).
   */
  private loadInstanceState(): void {
    if (!this.projectPath) return;
    const projState = fileStateOf(this.projectPath);
    const known = lastProjectSync.get(this.cache);
    if (known !== undefined && known === projState) return;
    const proj = readJsonIfExists(this.projectPath);
    if (Array.isArray(proj.session_errors)) {
      this.cache.session_errors = appendInstanceArray(
        proj.session_errors as SessionError[],
        this.cache.session_errors,
        (e) => `${e.ts}|${e.ref}|${e.reason}|${e.detail ?? ''}|${e.consequence}|${e.pid ?? ''}`
      ).slice(-SESSION_ERROR_CAP);
    }
    if (Array.isArray(proj.usage_log)) {
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      this.cache.usage_log = appendInstanceArray(
        proj.usage_log as UsageEntry[],
        this.cache.usage_log,
        (e) => `${e.ts}|${e.ref}|${e.tokens}`
      ).filter((e) => e.ts > cutoff);
    }
    lastProjectSync.set(this.cache, projState);
  }

  /**
   * Saves the cache. Two files, two strategies (live finding 2026-10-03:
   * blind last-writer-wins writes erased other processes' state):
   *
   * - GLOBAL scan cache: merge-on-save — what other processes wrote since
   *   our last sync is merged in (memory wins, disk fills gaps; same
   *   semantics as loadCache). Instance keys are STRIPPED from the global
   *   write; they moved to the project file (one-time migration: a legacy
   *   global cache's entries are adopted by the project file on the first
   *   save, then gone from the global one).
   * - PROJECT instance file: union-merge with what other same-project
   *   processes wrote (dedupe by entry identity), sorted by ts.
   *
   * Both writes are atomic (tmp + rename) — a concurrent reader can no
   * longer observe a torn file, parse it as `{}` and silently wipe state.
   *
   * Known trade-off (same as loadCache's mergeExternal): a key deleted by
   * one process can be resurrected from disk by another process's concurrent
   * save. Cooldowns are time-based and self-expiring, so this is benign.
   */
  saveCache(cache?: Cache): void {
    const data = cache ?? this.cache;

    // ── global part ────────────────────────────────────────────────────
    const knownGlobal = lastSync.get(data);
    const globalState = this.fileState();
    if (knownGlobal === undefined || knownGlobal !== globalState) {
      mergeExternal(data, this.readFromDisk());
    }
    const globalPart: Record<string, unknown> = { ...(data as Record<string, unknown>) };
    if (this.projectPath) for (const k of INSTANCE_KEYS) delete globalPart[k];
    writeJsonAtomic(this.cachePath, globalPart);
    lastSync.set(data, this.fileState());

    if (!this.projectPath) {
      // No project scope: instance keys stay in the global file (the
      // pre-split behavior — tests and self-managing embeddings).
      return;
    }

    // ── per-project instance part ──────────────────────────────────────
    const projState = fileStateOf(this.projectPath);
    const knownProj = lastProjectSync.get(data);
    // Disk is read only when it changed since our last sync: while we are
    // the last writer, memory already contains everything we persisted —
    // and memory-internal duplicates are REAL events, never deduped.
    const diskProj =
      knownProj === undefined || knownProj !== projState ? readJsonIfExists(this.projectPath) : {};
    const errors = appendInstanceArray(
      diskProj.session_errors as SessionError[] | undefined,
      (data as Record<string, unknown>).session_errors as SessionError[] | undefined,
      (e) => `${e.ts}|${e.ref}|${e.reason}|${e.detail ?? ''}|${e.consequence}|${e.pid ?? ''}`
    ).slice(-SESSION_ERROR_CAP);
    const usageCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const usage = appendInstanceArray(
      diskProj.usage_log as UsageEntry[] | undefined,
      (data as Record<string, unknown>).usage_log as UsageEntry[] | undefined,
      (e) => `${e.ts}|${e.ref}|${e.tokens}`
    ).filter((e) => e.ts > usageCutoff);
    writeJsonAtomic(this.projectPath, { session_errors: errors, usage_log: usage });
    lastProjectSync.set(data, fileStateOf(this.projectPath));
  }

  /**
   * Returns the current cache
   */
  getCache(): Cache {
    return this.cache;
  }

  /**
   * Updates the cache
   */
  updateCache(updates: Partial<Cache>): void {
    Object.assign(this.cache, updates);
    this.saveCache();
  }

  /**
   * Sets the timestamp of the last scan
   */
  setLastScanTimestamp(timestamp: number = Date.now()): void {
    this.updateCache({ lastScanTimestamp: timestamp });
  }

  /**
   * Checks whether the cache is still valid (max. 30 days old).
   *
   * Also rejects a cache that is timestamp-fresh but EMPTY (0 available
   * models) — this was F8 in the 2026-09-02 architecture review: the
   * repo-root `.cache/scan-cache.json` had a fresh `lastScanTimestamp` but
   * `available_models: 0`, `gdpval_scores: 0`, `openrouter_pricing: 0`.
   * Both the empty cache and the populated dist cache passed the 30-day
   * freshness check, so neither triggered a rescan — tests/dev ran against
   * zero models. An empty-but-fresh cache is almost certainly a write
   * failure or a partial cache; force a rescan so the next scan repopulates
   * it rather than silently serving nothing.
   */
  isScanCacheValid(cache: Cache = this.cache): boolean {
    const lastScan = cache.lastScanTimestamp;
    if (lastScan === undefined) return false;

    const thirtyDaysInMs = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds
    const now = Date.now();
    const diff = now - lastScan;
    // Check lower bound: diff >= 0 (no future timestamps) and < 30 days
    if (!(diff >= 0 && diff < thirtyDaysInMs)) return false;

    // Sanity check (F8): a fresh timestamp with zero models means the cache
    // is useless — force a rescan so we don't serve an empty cache forever.
    const modelCount = cache.available_models?.length ?? 0;
    if (modelCount === 0) return false;

    return true;
  }

  /**
   * Resets the cache
   */
  resetCache(): void {
    for (const key of Object.keys(this.cache)) delete (this.cache as Record<string, unknown>)[key];
    // A reset is a WIPE: remove both files so the merge-on-save paths have
    // nothing to resurrect, then persist the (now empty) state fresh.
    try { fs.rmSync(this.cachePath, { force: true }); } catch {}
    if (this.projectPath) try { fs.rmSync(this.projectPath, { force: true }); } catch {}
    this.saveCache();
  }

  /**
   * Updates the GDPval scores in the cache
   */
  updateGdpvalScores(scores: Record<string, number>): void {
    this.cache.gdpval_scores = scores;
    this.cache.gdpval_scraped = true;
    this.saveCache();
  }

  /**
   * Updates the available models in the cache
   */
  updateAvailableModels(models: { id: string; provider: string; cost_per_m: number }[]): void {
    this.cache.available_models = models;
    this.cache.models_cached = new Date().toISOString();
    this.saveCache();
  }

  /**
   * Updates the benchmarks in the cache
   */
  updateBenchmarks(benchmarks: Record<string, number>): void {
    this.cache.benchmarks = benchmarks;
    this.saveCache();
  }

  /**
   * Updates the OpenRouter pricing list in the cache
   */
  updateOpenRouterPricing(pricing: Record<string, { input: number; output: number }>): void {
    this.cache.openrouter_pricing = pricing;
    this.saveCache();
  }

  /**
   * Adds a new entry to the usage log
   */
  addUsageLogEntry(ref: string, tokens: number): void {
    if (!this.cache.usage_log) this.cache.usage_log = [];
    this.cache.usage_log.push({ ref, tokens, ts: Date.now() });
    // Trim log to last 30 days
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    this.cache.usage_log = this.cache.usage_log.filter((e) => e.ts > cutoff);
    this.saveCache();
  }

  /**
   * Updates the exhausted keys in the cache
   */
  updateExhaustedKeys(exhaustedKeys: Record<string, number>): void {
    this.cache.exhausted_keys = exhaustedKeys;
    this.saveCache();
  }

  /**
   * Updates the cost mux values in the cache
   */
  updateCostMux(costMux: Record<string, number>, costMuxLastBump: Record<string, string>): void {
    this.cache.cost_mux = costMux;
    this.cache.cost_mux_last_bump = costMuxLastBump;
    this.saveCache();
  }
}
