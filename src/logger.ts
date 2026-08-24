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
// Log format: `<ISO timestamp>  <msg><suffix>` where suffix is
// ` <error-stack|message|stringified>` when extra is provided.

import { homedir } from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

const HOME_LOG_PATH = path.join(homedir(), '.pi', 'logs', 'router.log');
let projectLogPath: string | null = null;

const ensuredDirs = new Set<string>();

function ensureLogDirFor(logPath: string): void {
  const dir = path.dirname(logPath);
  if (ensuredDirs.has(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
  ensuredDirs.add(dir);
}

/** Write a single line to both the global and project-local router logs. */
export function writeLogLine(line: string): void {
  try {
    ensureLogDirFor(HOME_LOG_PATH);
    fs.appendFileSync(HOME_LOG_PATH, line + '\n');
  } catch {}
  if (projectLogPath) {
    try {
      ensureLogDirFor(projectLogPath);
      fs.appendFileSync(projectLogPath, line + '\n');
    } catch {}
  }
}

/** Set the project-local log mirror path. Call on session_start. */
export function setProjectLogDir(cwd: string | undefined): void {
  projectLogPath = cwd ? path.join(cwd, '.pi', 'logs', 'router.log') : null;
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
