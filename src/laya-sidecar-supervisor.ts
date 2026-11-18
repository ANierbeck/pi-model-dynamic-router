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
/** How long SIGKILL gets to be visible, and how long a new start may take. */
const KILL_CONFIRM_MS = 2000;
const START_CONFIRM_MS = 15_000;
const START_POLL_MS = 200;

export interface SidecarPaths {
  pidFile: string;
  logFile: string;
}

export function sidecarPaths(stateDir: string): SidecarPaths {
  return { pidFile: path.join(stateDir, PID_FILE), logFile: path.join(stateDir, LOG_FILE) };
}

/** The hosts that mean "this machine". Anything else needs a network round trip. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Why the configured endpoint cannot be served by this sidecar, or null when it
 * can. The sidecar binds `127.0.0.1` and speaks plain HTTP at the root, so an
 * endpoint that asks for anything else would leave the router looking where
 * nothing listens — better to refuse than to start a server nobody reaches.
 */
export function endpointProblem(endpoint: string | undefined): string | null {
  if (!endpoint) return null; // the documented default is exactly what we serve
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return `${endpoint} is not a URL`;
  }
  if (url.protocol !== 'http:')
    return `${endpoint} is not plain http; the sidecar serves plain http only`;
  if (!LOOPBACK_HOSTS.has(url.hostname))
    return `${endpoint} does not point at this machine; the sidecar binds 127.0.0.1 only`;
  if (!url.port)
    return `${endpoint} carries no port; the sidecar needs an explicit http://127.0.0.1:<port>`;
  if (url.pathname !== '/' && url.pathname !== '')
    return `${endpoint} carries a path; the sidecar serves /health and /classify at the root`;
  return null;
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

/**
 * The environment the sidecar inherits. Deliberately an allowlist: `spawn`
 * without `env` hands the child every variable pi has, which includes provider
 * credentials when pi was started with them in its environment. The sidecar
 * needs none of that — it reads its checkpoint from argv and loads local files.
 */
export function sidecarEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ'] as const;
  const out: Record<string, string> = {};
  for (const key of keep) {
    const value = source[key];
    if (typeof value === 'string' && value) out[key] = value;
  }
  return out;
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
  /** The configured endpoint, validated before anything is spawned. */
  endpoint?: string;
  /** Checks that the model is installed and verifies; false blocks the start. */
  installed?: () => boolean;
  /** Checks the ONNX runtime; false blocks the start with a pointer at install. */
  runtimeOk?: () => boolean;
  /**
   * Asks which sidecar answers on the endpoint. Used three times, and it is not
   * optional in spirit: to recognise an already-running sidecar, to notice one
   * that runs outside pi (no pid file), and to confirm a start actually serves.
   */
  whoAnswers?: () => Promise<SidecarAnswer>;
}

/**
 * What GET /health said about the answering process: null when nothing
 * answered, `{}` when a sidecar answered without naming its pid (an older or
 * foreign build), `{ pid }` otherwise. An answer proves only that SOME sidecar
 * listens; the pid says whether it is the process the router recorded.
 */
export type SidecarAnswer = { pid?: number } | null;

/** Reads the pid out of a /health body; anything but a positive safe integer is no pid. */
export function answerFromHealth(raw: unknown): SidecarAnswer {
  if (raw === null || typeof raw !== 'object') return null;
  const pid = (raw as { pid?: unknown }).pid;
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? { pid } : {};
}

/** How an answer relates to a recorded pid, phrased for the user. */
function foreignAnswer(answer: { pid?: number }, recorded: number): string {
  return answer.pid === undefined
    ? `A Laya sidecar answers on the endpoint but does not report its pid, so it cannot be told ` +
        `apart from whatever now holds the recorded pid ${recorded}`
    : `The Laya sidecar answering on the endpoint is pid ${answer.pid}, not the recorded pid ` +
        `${recorded}; the recorded pid most likely belongs to a different process now`;
}

export type StartResult =
  | {
      ok: true;
      pid: number;
      logFile: string;
    }
  | { ok: false; error: string };

/**
 * Starts the sidecar detached: it outlives `/reload` and a pi restart, which is
 * the point of a long-lived classifier server. Refuses rather than replacing a
 * running one, and refuses when the prerequisites are not in place.
 *
 * Success means "it answers on /health", not "a process exists": a missing
 * native runtime, a taken port or a corrupt install all exit within a second,
 * and reporting those as started would send the user looking in the wrong place.
 */
export async function startSidecar(opts: StartOptions, deps: SupervisorDeps): Promise<StartResult> {
  const problem = endpointProblem(opts.endpoint);
  if (problem) return { ok: false, error: `Cannot start the sidecar: ${problem}.` };
  const ask = opts.whoAnswers ?? null;
  const { pidFile, logFile } = sidecarPaths(opts.stateDir);

  const recorded = readRecordedPid(opts.stateDir);
  if (recorded !== null) {
    const answer = deps.isPidAlive(recorded) && ask ? await ask() : null;
    if (!deps.isPidAlive(recorded)) {
      removePidFile(opts.stateDir);
    } else if (answer?.pid === recorded) {
      return {
        ok: false,
        error: `The Laya sidecar is already running (pid ${recorded}). Use /router laya stop first.`,
      };
    } else if (answer) {
      return {
        ok: false,
        error:
          `${foreignAnswer(answer, recorded)}. Nothing was started. Remove ${pidFile} if the ` +
          `record is stale, and stop the answering sidecar where it was started.`,
      };
    } else {
      return {
        ok: false,
        error:
          `A process with the recorded pid ${recorded} is alive but the sidecar does not answer on ` +
          `port ${opts.port}. Stop it with /router laya stop, or remove ${pidFile} ` +
          `if that pid belongs to something else.`,
      };
    }
  }

  // A sidecar started in a terminal has no pid file. Without this check the
  // start would spawn a second server that cannot bind the port, and the first
  // one would answer while the new pid is recorded.
  if (ask && (await ask())) {
    return {
      ok: false,
      error:
        `A Laya sidecar already answers on port ${opts.port} (started outside pi, so no pid is ` +
        `recorded). Stop it there, or point integrations.laya.endpoint at another port.`,
    };
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

  fs.mkdirSync(opts.stateDir, { recursive: true });
  // Reserve the pid file BEFORE spawning. Two `/router laya serve` calls in the
  // same state dir would otherwise both pass the checks above and spawn, and the
  // second write would leave one process untracked and unstoppable.
  let fd: number;
  try {
    fd = fs.openSync(pidFile, 'wx');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      error:
        code === 'EEXIST'
          ? `Another /router laya serve is starting (${pidFile} exists and holds no pid yet); try again in a moment.`
          : `Cannot write ${pidFile}: ${textOf(err)}`,
    };
  }

  let spawnError = '';
  const log = fs.openSync(logFile, 'a');
  let child: ReturnType<SupervisorDeps['spawn']>;
  try {
    child = deps.spawn(
      deps.execPath,
      [deps.cliPath, 'serve', opts.checkpoint, '--port', String(opts.port)],
      { detached: true, stdio: ['ignore', log, log], env: sidecarEnv() }
    );
  } catch (err) {
    fs.closeSync(fd);
    removePidFile(opts.stateDir);
    return { ok: false, error: `The sidecar did not start: ${textOf(err)}` };
  } finally {
    // Closed here only: closing it in both places threw EBADF from the finally
    // and hid the real reason the spawn failed.
    fs.closeSync(log);
  }
  // Without a listener an async `error` event (ENOENT, EACCES) is unhandled and
  // takes pi down with it.
  child.on('error', (err: Error) => {
    spawnError = textOf(err);
  });

  const pid = child.pid;
  if (!pid) {
    fs.closeSync(fd);
    removePidFile(opts.stateDir);
    return { ok: false, error: 'The sidecar process started without a pid; nothing recorded.' };
  }
  try {
    fs.writeSync(fd, `${pid}\n`);
  } catch (err) {
    fs.closeSync(fd);
    deps.kill(pid, 'SIGKILL');
    removePidFile(opts.stateDir);
    return {
      ok: false,
      error: `The sidecar started (pid ${pid}) but its pid file could not be written: ${textOf(err)}. It was stopped again.`,
    };
  }
  fs.closeSync(fd);
  child.unref();

  if (!ask) return { ok: true, pid, logFile };
  // Only our own child confirms the start. A sidecar that took the port in the
  // meantime answers too, and recording our pid for it would leave the record
  // pointing at a process that is about to exit with "address in use".
  let foreign: { pid?: number } | null = null;
  const deadline = deps.now() + START_CONFIRM_MS;
  while (deps.now() < deadline) {
    if (spawnError) break;
    const answer = await ask();
    if (answer?.pid === pid) return { ok: true, pid, logFile };
    if (answer) {
      foreign = answer;
      break;
    }
    await deps.sleep(START_POLL_MS);
  }
  await terminate(pid, deps);
  removePidFile(opts.stateDir);
  return {
    ok: false,
    error: spawnError
      ? `The sidecar failed to start: ${spawnError} (log: ${logFile})`
      : foreign
        ? `Another Laya sidecar ${foreign.pid === undefined ? '(pid not reported)' : `(pid ${foreign.pid})`} ` +
          `answers on port ${opts.port}, so the one started here (pid ${pid}) could not serve; ` +
          `it was stopped again. Log: ${logFile}`
        : `The sidecar started (pid ${pid}) but /health did not answer within ` +
          `${String(START_CONFIRM_MS / 1000)}s; it was stopped again. Log: ${logFile}`,
  };
}

export type StopResult = { ok: true; pid: number } | { ok: false; error: string };

/**
 * SIGTERM, wait for the grace period, then SIGKILL, then wait until the OS says
 * the process is gone. Nothing is reported as stopped while it still runs: a
 * concurrent `serve` would then find the port taken and the pid file gone.
 */
export async function stopSidecar(
  stateDir: string,
  deps: SupervisorDeps,
  whoAnswers: () => Promise<SidecarAnswer>
): Promise<StopResult> {
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
  // A pid is not an identity. After a crash the OS may hand the number to an
  // unrelated process, and signalling it would kill somebody else's work. An
  // answer on the endpoint is not one either: a sidecar started in a terminal
  // answers too. Only the sidecar reporting exactly the recorded pid is ours.
  const answer = await whoAnswers();
  if (!answer) {
    return {
      ok: false,
      error:
        `A process with the recorded pid ${pid} is alive, but the Laya sidecar does not answer on ` +
        `its endpoint — it is most likely a different process that got the pid. Nothing was killed. ` +
        `Remove ${sidecarPaths(stateDir).pidFile} if the record is stale, or stop the sidecar in its own terminal.`,
    };
  }
  if (answer.pid !== pid) {
    return {
      ok: false,
      error:
        `${foreignAnswer(answer, pid)}. Nothing was killed. Remove ` +
        `${sidecarPaths(stateDir).pidFile} if the record is stale, and stop the answering sidecar where it was started.`,
    };
  }
  await terminate(pid, deps);
  if (deps.isPidAlive(pid)) {
    return {
      ok: false,
      error: `The sidecar (pid ${pid}) is still alive after SIGKILL; its record is kept.`,
    };
  }
  removePidFile(stateDir);
  return { ok: true, pid };
}

/** SIGTERM, grace period, SIGKILL, then a bounded wait for the process to go. */
async function terminate(pid: number, deps: SupervisorDeps): Promise<void> {
  signal(pid, 'SIGTERM', deps);
  const graceEnd = deps.now() + STOP_GRACE_MS;
  while (deps.now() < graceEnd) {
    await deps.sleep(STOP_POLL_MS);
    if (!deps.isPidAlive(pid)) return;
  }
  signal(pid, 'SIGKILL', deps);
  const killEnd = deps.now() + KILL_CONFIRM_MS;
  while (deps.now() < killEnd) {
    await deps.sleep(STOP_POLL_MS);
    if (!deps.isPidAlive(pid)) return;
  }
}

/**
 * A kill that races the process's own exit throws ESRCH ("no such process").
 * That is the outcome we wanted, so it is not an error.
 */
function signal(pid: number, sig: NodeJS.Signals, deps: SupervisorDeps): void {
  try {
    deps.kill(pid, sig);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
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
