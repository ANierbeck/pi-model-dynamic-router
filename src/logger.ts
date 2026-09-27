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
// Levels: debugLog/debugLogOnce lines are written only at level "debug"
// (ROUTER_LOG_LEVEL or the config's `log_level`). Each log file rotates at
// maxBytes into <file>.1 … <file>.<keep-1>; the oldest is dropped. Without
// this, router.log reached ~2M lines / 322 MB, 75% of it one repeated
// [diag] line.
//
// Log format: `<ISO timestamp>  <msg><suffix>` where suffix is
// ` <error-stack|message|stringified>` when extra is provided.

import { homedir } from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type LogLevel = 'info' | 'debug';

// Resolved lazily: the home directory can change between module load and first
// write (tests isolate it per file).
const homeLogPath = () => path.join(homedir(), '.pi', 'logs', 'router.log');
let projectLogPath: string | null = null;
let level: LogLevel = process.env.ROUTER_LOG_LEVEL === 'debug' ? 'debug' : 'info';
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

/** Write a single line to both the global and project-local router logs. */
export function writeLogLine(line: string): void {
  try {
    append(homeLogPath(), line);
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
}

/** ROUTER_LOG_LEVEL wins over the configured level. */
export function setLogLevel(configured: LogLevel | undefined): void {
  const env = process.env.ROUTER_LOG_LEVEL;
  level = env === 'debug' || env === 'info' ? env : (configured ?? 'info');
}

export function configureLogRotation(opts: { maxBytes: number; keep: number }): void {
  rotation = { maxBytes: opts.maxBytes, keep: Math.max(1, opts.keep) };
  rotationRetryAt.clear();
}

/** Write a raw (already-formatted) line to both router logs. */
export function appendRawLog(line: string): void {
  writeLogLine(line);
}

/** Structured router log. */
export function routerLog(msg: string, extra?: unknown): void {
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
