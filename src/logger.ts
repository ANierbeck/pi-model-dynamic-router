// src/logger.ts
// Shared router logger — the SINGLE source of truth for router log output.
//
// Why this exists (D2): before this module, four source files wrote diagnostic
// output via `console.*` (content-classifier.ts 11, cost-tracker.ts 6,
// escalation.ts 4, metrics.ts 1). Those calls bypass Pi's TUI and can land in
// the user's input field, polluting the prompt. They also had no access to
// the router's structured file logger (routerLog/writeLogLine), which lived
// as private functions in index.ts. This module exposes the same file-backed
// logger to every src/ module so they stop using console.* for diagnostics.
//
// Contract: routerLog(msg, extra?) writes a timestamped line to BOTH the
// global (~/.pi/logs/router.log) and the project-local (.pi/logs/router.log)
// log files. It never writes to stdout/stderr. setProjectLogDir(cwd) sets
// the project-local mirror path; call it on session_start (index.ts does).
//
// Levels: error < warn < info < debug (ROUTER_LOG_LEVEL or the config's
// `log_level`). errorLog/warnLog classify failures (release builds ship at
// "warn" or "error" — owner rule 2026-10-02, gated by
// config-release-log-level.test.ts); routerLog/appendRawLog are info-class
// and suppressed below "info"; debugLog/debugLogOnce need "debug". Each log
// file rotates at
// maxBytes into <file>.1 … <file>.<keep-1>; the oldest is dropped. Without
// this, router.log reached ~2M lines / 322 MB, 75% of it one repeated
// [diag] line.
//
// Log format: `<ISO timestamp>  <msg><suffix>` where suffix is
// ` <error-stack|message|stringified>` when extra is provided.

import { homedir } from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

// A line of class C is written iff rank(C) <= rank(level): "error" keeps only
// hard failures, "warn" adds operational problems, "info" adds routine
// narration, "debug" adds diagnostics. "debug" is the most verbose level.
const LEVEL_RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

// Resolved lazily: the home directory can change between module load and first
// write (tests isolate it per file).
const homeLogPath = () => path.join(homedir(), '.pi', 'logs', 'router.log');
let projectLogPath: string | null = null;
// Provenance tag for the GLOBAL log (live finding 2026-10-03: concurrent pi
// instances in different projects interleave there with no way to tell them
// apart). '<project-basename>/<pid>'; 'pi' until session_start names the
// project. The project-local mirror stays untagged — the file itself is the
// provenance there.
let projectTag = 'pi';
let level: LogLevel = ['error', 'warn', 'debug'].includes(process.env.ROUTER_LOG_LEVEL ?? '')
  ? (process.env.ROUTER_LOG_LEVEL as LogLevel)
  : 'info';
let rotation = { maxBytes: 20 * 1024 * 1024, keep: 5 };

const ensuredDirs = new Set<string>();
// After a failed rotation, retry only after this many ms: a permanently blocked
// slot would otherwise cost an rm/rename attempt on every single line.
const ROTATION_RETRY_MS = 60_000;
const rotationRetryAt = new Map<string, number>();
const lastOnce = new Map<string, string>();

function ensureLogDirFor(logPath: string): void {
  const dir = path.dirname(logPath);
  if (ensuredDirs.has(dir) && fs.existsSync(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
  ensuredDirs.add(dir);
}

function rotate(logPath: string): void {
  const last = `${logPath}.${rotation.keep - 1}`;
  if (fs.existsSync(last)) fs.rmSync(last);
  for (let i = rotation.keep - 2; i >= 1; i--) {
    if (fs.existsSync(`${logPath}.${i}`)) fs.renameSync(`${logPath}.${i}`, `${logPath}.${i + 1}`);
  }
  if (rotation.keep > 1) fs.renameSync(logPath, `${logPath}.1`);
  else fs.rmSync(logPath);
}

// The size is read from disk on every write rather than counted per process:
// several Pi sessions append to the same file, and a per-process counter
// rotated too late and then rotated a fresh file again (review 2026-09-27).
function append(logPath: string, line: string): void {
  ensureLogDirFor(logPath);
  const size = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  const retryAt = rotationRetryAt.get(logPath) ?? 0;
  if (size > 0 && size + Buffer.byteLength(line) + 1 > rotation.maxBytes && Date.now() >= retryAt) {
    try {
      rotate(logPath);
      rotationRetryAt.delete(logPath);
    } catch (err) {
      // Another process rotated in between (ENOENT) or a slot is blocked:
      // never lose the line over it — append to whatever is there now, say
      // why the file keeps growing, and back off.
      rotationRetryAt.set(logPath, Date.now() + ROTATION_RETRY_MS);
      const reason = err instanceof Error ? err.message : String(err);
      fs.appendFileSync(logPath, `${new Date().toISOString()}  [router] log rotation failed, retrying in ${ROTATION_RETRY_MS / 1000}s: ${reason}\n`);
    }
  }
  fs.appendFileSync(logPath, line + '\n');
}

/** Tag a fully formatted line: insert " [<tag>] " right after the ISO timestamp. */
function withTag(line: string): string {
  const tag = `[${projectTag}/${process.pid}]`;
  const m = line.match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)(\s+)(.*)$/);
  return m ? `${m[1]}  ${tag} ${m[3]}` : `${tag} ${line}`;
}

/** Write a single line to both the global and project-local router logs. */
export function writeLogLine(line: string): void {
  const home = homeLogPath();
  // pi started directly in the home directory: both targets are the SAME
  // file — write it once (tagged), never twice.
  if (projectLogPath && path.resolve(projectLogPath) === path.resolve(home)) {
    try {
      append(home, withTag(line));
    } catch {}
    return;
  }
  try {
    append(home, withTag(line));
  } catch {}
  if (projectLogPath) {
    try {
      append(projectLogPath, line);
    } catch {}
  }
}

/** Set the project-local log mirror path. Call on session_start. */
export function setProjectLogDir(cwd: string | undefined): void {
  projectLogPath = cwd ? path.join(cwd, '.pi', 'logs', 'router.log') : null;
  projectTag = cwd && path.basename(cwd) ? path.basename(cwd) : 'pi';
}

/** ROUTER_LOG_LEVEL wins over the configured level. */
export function setLogLevel(configured: LogLevel | undefined): void {
  const env = process.env.ROUTER_LOG_LEVEL;
  const valid = (v: string | undefined): v is LogLevel =>
    v === 'error' || v === 'warn' || v === 'info' || v === 'debug';
  level = valid(env) ? env : valid(configured) ? configured : 'info';
}

export function configureLogRotation(opts: { maxBytes: number; keep: number }): void {
  rotation = { maxBytes: opts.maxBytes, keep: Math.max(1, opts.keep) };
  rotationRetryAt.clear();
}

/** Write a raw (already-formatted) line to both router logs (info class). */
export function appendRawLog(line: string): void {
  if (LEVEL_RANK.info > LEVEL_RANK[level]) return;
  writeLogLine(line);
}

/** Structured router log (info class: suppressed at "warn"/"error"). */
export function routerLog(msg: string, extra?: unknown): void {
  logAt('info', msg, extra);
}

/** Operational problem (rate limit, model failed, fallback engaged,
 * wedge) — written at "warn" and every more verbose level. */
export function warnLog(msg: string, extra?: unknown): void {
  logAt('warn', msg, extra);
}

/** Hard failure (all candidates failed, config load failed, a feature is
 * disabled) — written at EVERY level, including "error". */
export function errorLog(msg: string, extra?: unknown): void {
  logAt('error', msg, extra);
}

function logAt(cls: LogLevel, msg: string, extra?: unknown): void {
  if (LEVEL_RANK[cls] > LEVEL_RANK[level]) return;
  const suffix = extra
    ? ` ${extra instanceof Error ? (extra.stack ?? extra.message) : String(extra)}`
    : '';
  writeLogLine(`${new Date().toISOString()}  ${msg}${suffix}`);
}

/** Diagnostic line, written only at level "debug". */
export function debugLog(msg: string, extra?: unknown): void {
  if (level === 'debug') routerLog(msg, extra);
}

/**
 * Diagnostic line for a recurring state (e.g. why a model is skipped):
 * written only when the message for `key` differs from the last one.
 */
export function debugLogOnce(key: string, msg: string): void {
  if (lastOnce.get(key) === msg) return;
  lastOnce.set(key, msg);
  debugLog(msg);
}

/** Forget the last message for `key`, so the next debugLogOnce writes again. */
export function forgetDebugOnce(key: string): void {
  lastOnce.delete(key);
}
