// The Laya sidecar process: start it detached, stop it, and say what runs
// (plan docs/plans/2026-11-17-laya-sidecar-lifecycle.md).
//
// The router starts a sidecar only when the user asks with `/router laya serve`.
// Nothing here starts silently: a sidecar that dies stays dead until someone
// acts, and a recorded process is never replaced behind the user's back.
//
// This is one of two files in src/ allowed to touch child_process (the other is
// src/laya-runtime-install.ts for its `npm ci`); the exemption is pinned in
// test/router-never-touches-auth-json.test.ts. Always an argument array, never
// a shell.
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LAYA_DEFAULT_ENDPOINT } from './laya-classifier.ts';
import { textOf } from './utils.ts';

const PID_FILE = 'laya-sidecar.pid';
const LOG_FILE = 'laya-sidecar.log';
/** How long SIGTERM gets before SIGKILL, and how often to look. */
const STOP_GRACE_MS = 3000;
const STOP_POLL_MS = 100;

export interface SidecarPaths {
  pidFile: string;
  logFile: string;
}

export function sidecarPaths(stateDir: string): SidecarPaths {
  return { pidFile: path.join(stateDir, PID_FILE), logFile: path.join(stateDir, LOG_FILE) };
}

/**
 * The port the router talks to. Read from `integrations.laya.endpoint` so the
 * started sidecar and the router's client side cannot disagree; the documented
 * default fills in when the endpoint carries no explicit port.
 */
export function portFromEndpoint(endpoint: string | undefined): number {
  if (!endpoint) return portOf(LAYA_DEFAULT_ENDPOINT);
  try {
    const url = new URL(endpoint);
    return url.port ? Number(url.port) : portOf(LAYA_DEFAULT_ENDPOINT);
  } catch {
    return portOf(LAYA_DEFAULT_ENDPOINT);
  }
}

function portOf(endpoint: string): number {
  try {
    const port = new URL(endpoint).port;
    return port ? Number(port) : 8089;
  } catch {
    return 8089;
  }
}

/** The pid recorded for the sidecar, or null when none (or garbage) was written. */
export function readRecordedPid(stateDir: string): number | null {
  let raw: string;
  try {
    raw = fs.readFileSync(sidecarPaths(stateDir).pidFile, 'utf8');
  } catch {
    return null;
  }
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function removePidFile(stateDir: string): void {
  fs.rmSync(sidecarPaths(stateDir).pidFile, { force: true });
}

/**
 * Signal 0 asks the OS whether the process exists. EPERM means it exists but
 * belongs to someone else, which still counts as alive: the pid is in use.
 */
export function isPidAlive(
  pid: number,
  kill: (pid: number, signal: 0) => void = (p, signal) => process.kill(p, signal)
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface SupervisorDeps {
  execPath: string;
  /** The built CLI that carries the `serve` subcommand (dist/laya-model-install.js). */
  cliPath: string;
  spawn: (
    cmd: string,
    args: string[],
    opts: Record<string, unknown>
  ) => Pick<ChildProcess, 'pid' | 'unref' | 'on'>;
  isPidAlive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface StartOptions {
  stateDir: string;
  /** `model@version`, as the manifest names it. */
  checkpoint: string;
  port: number;
  /** Checks that the model is installed and verifies; false blocks the start. */
  installed?: () => boolean;
  /** Checks the ONNX runtime; false blocks the start with a pointer at install. */
  runtimeOk?: () => boolean;
  /** Asks the sidecar whether it answers; used only for the double-start guard. */
  healthAnswers?: () => Promise<boolean>;
}

export type StartResult = { ok: true; pid: number; logFile: string } | { ok: false; error: string };

/**
 * Starts the sidecar detached: it outlives `/reload` and a pi restart, which is
 * the point of a long-lived classifier server. Refuses rather than replacing a
 * running one, and refuses when the prerequisites are not in place.
 */
export async function startSidecar(opts: StartOptions, deps: SupervisorDeps): Promise<StartResult> {
  const recorded = readRecordedPid(opts.stateDir);
  if (recorded !== null) {
    if (!deps.isPidAlive(recorded)) {
      removePidFile(opts.stateDir);
    } else {
      // Alive: it may be ours (already serving) or an unrelated process that got
      // the pid after a crash. Ask the sidecar itself before deciding.
      const answers = opts.healthAnswers ? await opts.healthAnswers() : true;
      if (answers) {
        return {
          ok: false,
          error: `The Laya sidecar is already running (pid ${recorded}). Use /router laya stop first.`,
        };
      }
      return {
        ok: false,
        error:
          `A process with the recorded pid ${recorded} is alive but the sidecar does not answer on ` +
          `port ${opts.port}. Stop it with /router laya stop, or remove ${sidecarPaths(opts.stateDir).pidFile} ` +
          `if that pid belongs to something else.`,
      };
    }
  }
  if (opts.installed && !opts.installed()) {
    return { ok: false, error: 'The Laya model is not installed: run /router laya install first.' };
  }
  if (opts.runtimeOk && !opts.runtimeOk()) {
    return {
      ok: false,
      error: 'The ONNX runtime is missing: run /router laya install (it installs the runtime too).',
    };
  }

  const { pidFile, logFile } = sidecarPaths(opts.stateDir);
  fs.mkdirSync(opts.stateDir, { recursive: true });
  const log = fs.openSync(logFile, 'a');
  let child: ReturnType<SupervisorDeps['spawn']>;
  try {
    child = deps.spawn(
      deps.execPath,
      [deps.cliPath, 'serve', opts.checkpoint, '--port', String(opts.port)],
      { detached: true, stdio: ['ignore', log, log] }
    );
  } catch (err) {
    return { ok: false, error: `The sidecar did not start: ${textOf(err)}` };
  } finally {
    fs.closeSync(log);
  }
  const pid = child.pid;
  if (!pid)
    return { ok: false, error: 'The sidecar process started without a pid; nothing recorded.' };
  child.unref();
  fs.writeFileSync(pidFile, `${pid}\n`);
  return { ok: true, pid, logFile };
}

export type StopResult = { ok: true; pid: number } | { ok: false; error: string };

/**
 * SIGTERM, wait for the grace period, then SIGKILL. A stale pid file is removed
 * either way, so a crashed sidecar never blocks the next start.
 */
export async function stopSidecar(stateDir: string, deps: SupervisorDeps): Promise<StopResult> {
  const pid = readRecordedPid(stateDir);
  if (pid === null) {
    return { ok: false, error: 'No sidecar is recorded for this router; nothing to stop.' };
  }
  if (!deps.isPidAlive(pid)) {
    removePidFile(stateDir);
    return {
      ok: false,
      error: `The recorded sidecar (pid ${pid}) was not running; its pid file is gone.`,
    };
  }
  deps.kill(pid, 'SIGTERM');
  const deadline = deps.now() + STOP_GRACE_MS;
  while (deps.now() < deadline) {
    await deps.sleep(STOP_POLL_MS);
    if (!deps.isPidAlive(pid)) {
      removePidFile(stateDir);
      return { ok: true, pid };
    }
  }
  deps.kill(pid, 'SIGKILL');
  removePidFile(stateDir);
  return { ok: true, pid };
}

export interface SidecarState {
  running: boolean;
  pid?: number;
}

/** What the status line shows: a recorded pid that is still alive. */
export function describeSidecar(stateDir: string, deps: SupervisorDeps): SidecarState {
  const pid = readRecordedPid(stateDir);
  if (pid === null || !deps.isPidAlive(pid)) return { running: false };
  return { running: true, pid };
}

/** The real dependencies, for the /router handler. */
export function defaultSupervisorDeps(cliPath: string): SupervisorDeps {
  return {
    execPath: process.execPath,
    cliPath,
    spawn: (cmd, args, opts) => spawn(cmd, args, opts as Parameters<typeof spawn>[2]),
    isPidAlive: (pid) => isPidAlive(pid),
    kill: (pid, signal) => process.kill(pid, signal),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}
