// /router laya serve|stop — the sidecar lifecycle (plan
// docs/plans/2026-11-17-laya-sidecar-lifecycle.md).
//
// The supervisor is tested with an injected spawn and an injected liveness
// check: a test must never start a real server or signal a real pid.

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  answerFromHealth,
  sidecarPaths,
  readRecordedPid,
  isPidAlive,
  startSidecar,
  stopSidecar,
  describeSidecar,
  portFromEndpoint,
  endpointProblem,
  sidecarEnv,
  type SupervisorDeps,
} from '../src/laya-sidecar-supervisor.ts';

function tmpState(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'laya-sup-'));
}

interface Fakes {
  deps: SupervisorDeps;
  spawn: ReturnType<typeof vi.fn>;
}

function fakes(
  over: {
    alive?: (pid: number) => boolean;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    onSpawn?: (cmd: string, args: string[]) => void;
    /** Fired by the test to simulate the OS refusing the spawn asynchronously. */
    emit?: { error?: (err: Error) => void };
  } = {}
): Fakes {
  const spawn = vi.fn((cmd: string, args: string[]) => {
    over.onSpawn?.(cmd, args);
    return {
      pid: 4242,
      unref: () => {},
      on: (event: string, handler: (err: Error) => void) => {
        if (over.emit && event === 'error') over.emit.error = handler;
      },
    };
  });
  // The clock advances only while the supervisor waits, like a real one: a
  // constant clock would make the SIGTERM grace loop spin forever.
  let clock = 1_700_000_000_000;
  return {
    spawn,
    deps: {
      execPath: '/usr/local/bin/node',
      cliPath: '/opt/router/dist/laya-model-install.js',
      spawn: spawn as unknown as SupervisorDeps['spawn'],
      isPidAlive: over.alive ?? (() => true),
      kill: over.kill ?? (() => {}),
      sleep: async (ms: number) => {
        clock += ms;
      },
      now: () => clock,
    },
  };
}

describe('portFromEndpoint', () => {
  it('reads the port the router actually talks to', () => {
    expect(portFromEndpoint('http://127.0.0.1:8089')).toBe(8089);
    expect(portFromEndpoint('http://localhost:9000/')).toBe(9000);
  });

  it('falls back to the documented default when the endpoint has no port', () => {
    expect(portFromEndpoint(undefined)).toBe(8089);
    expect(portFromEndpoint('http://127.0.0.1')).toBe(8089);
    expect(portFromEndpoint('not a url')).toBe(8089);
  });
});

describe('endpointProblem', () => {
  it('accepts what this sidecar can actually serve', () => {
    expect(endpointProblem(undefined)).toBeNull();
    expect(endpointProblem('http://127.0.0.1:8089')).toBeNull();
    expect(endpointProblem('http://localhost:9000/')).toBeNull();
    expect(endpointProblem('http://[::1]:8089')).toBeNull();
  });

  it('rejects endpoints that would leave the router calling a port nobody listens on', () => {
    expect(endpointProblem('https://127.0.0.1:8089')).toMatch(/plain http/);
    expect(endpointProblem('http://127.0.0.1')).toMatch(/no port|explicit/i);
    expect(endpointProblem('http://10.0.0.5:8089')).toMatch(/this machine|127\.0\.0\.1 only/);
    expect(endpointProblem('http://127.0.0.1:8089/laya')).toMatch(/path/);
    expect(endpointProblem('nonsense')).toMatch(/not a URL/);
  });
});

describe('sidecarEnv', () => {
  it('passes what the sidecar needs and none of pi credentials', () => {
    const env = sidecarEnv({
      PATH: '/usr/bin',
      HOME: '/home/pi',
      OPENROUTER_API_KEY: 'sk-or-secret',
      MISTRAL_API_KEY: 'secret',
      ANTHROPIC_API_KEY: 'secret',
    } as NodeJS.ProcessEnv);
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/pi' });
  });
});

describe('readRecordedPid', () => {
  it('is null when nothing was recorded', () => {
    expect(readRecordedPid(tmpState())).toBeNull();
  });

  it('reads a numeric pid and ignores garbage', () => {
    const dir = tmpState();
    fs.writeFileSync(sidecarPaths(dir).pidFile, '1234\n');
    expect(readRecordedPid(dir)).toBe(1234);
    fs.writeFileSync(sidecarPaths(dir).pidFile, 'not a pid');
    expect(readRecordedPid(dir)).toBeNull();
  });
});

describe('isPidAlive', () => {
  it('reports a live process as alive (signal 0 succeeds)', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('reports a died process as gone (ESRCH)', () => {
    const kill = () => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    };
    expect(isPidAlive(999_999, kill as never)).toBe(false);
  });

  it('treats a permission error as alive: the process exists, we just may not signal it', () => {
    const kill = () => {
      const err = new Error('not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    };
    expect(isPidAlive(999_999, kill as never)).toBe(true);
  });
});

describe('startSidecar', () => {
  it('spawns node with the sidecar CLI, detached, and records the pid', async () => {
    const dir = tmpState();
    let seen: { cmd: string; args: string[] } | undefined;
    const f = fakes({ onSpawn: (cmd, args) => (seen = { cmd, args }) });
    const res = await startSidecar(
      { stateDir: dir, checkpoint: 'router@1.0.0', port: 8089 },
      f.deps
    );
    expect(res).toMatchObject({ ok: true, pid: 4242 });
    expect(seen?.cmd).toBe('/usr/local/bin/node');
    expect(seen?.args).toEqual([
      '/opt/router/dist/laya-model-install.js',
      'serve',
      'router@1.0.0',
      '--port',
      '8089',
    ]);
    expect(readRecordedPid(dir)).toBe(4242);
  });

  it('never uses a shell: the command is an argument array', async () => {
    const dir = tmpState();
    const f = fakes();
    await startSidecar({ stateDir: dir, checkpoint: 'router@1.0.0', port: 8089 }, f.deps);
    const opts = f.spawn.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(opts?.shell).toBeUndefined();
    expect(opts?.detached).toBe(true);
  });

  it('writes stdout and stderr into a log file in the state dir', async () => {
    const dir = tmpState();
    const f = fakes();
    await startSidecar({ stateDir: dir, checkpoint: 'router@1.0.0', port: 8089 }, f.deps);
    const opts = f.spawn.mock.calls[0]?.[2] as { stdio?: unknown[] };
    expect(sidecarPaths(dir).logFile).toContain(dir);
    expect(opts.stdio?.[0]).toBe('ignore');
    // Both output descriptors are an OPEN FILE, not 'ignore'/'inherit': opening
    // the log alone would create the file while the output went elsewhere.
    expect(typeof opts.stdio?.[1]).toBe('number');
    expect(opts.stdio?.[1]).toBe(opts.stdio?.[2]);
    expect(opts.stdio?.[1]).not.toBe(1);
    expect(opts.stdio?.[1]).not.toBe(2);
  });

  it('refuses a second start while a recorded process answers', async () => {
    const dir = tmpState();
    fs.writeFileSync(sidecarPaths(dir).pidFile, '4242');
    const f = fakes({ alive: () => true });
    const res = await startSidecar(
      {
        stateDir: dir,
        checkpoint: 'router@1.0.0',
        port: 8089,
        whoAnswers: async () => ({ pid: 4242 }),
      },
      f.deps
    );
    expect(res).toMatchObject({ ok: false });
    expect(res.ok === false && res.error).toMatch(/already running/i);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it('cleans a pid file whose process is gone and starts anyway', async () => {
    const dir = tmpState();
    fs.writeFileSync(sidecarPaths(dir).pidFile, '4242');
    const f = fakes({ alive: () => false });
    const res = await startSidecar(
      { stateDir: dir, checkpoint: 'router@1.0.0', port: 8089 },
      f.deps
    );
    expect(res.ok).toBe(true);
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });

  it('refuses when a recorded process is alive but does not answer, instead of replacing it', async () => {
    const dir = tmpState();
    fs.writeFileSync(sidecarPaths(dir).pidFile, '4242');
    const f = fakes({ alive: () => true });
    const res = await startSidecar(
      { stateDir: dir, checkpoint: 'router@1.0.0', port: 8089, whoAnswers: async () => null },
      f.deps
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/does not answer|not answering/i);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it('refuses when the model is not installed', async () => {
    const dir = tmpState();
    const f = fakes();
    const res = await startSidecar(
      { stateDir: dir, checkpoint: 'router@1.0.0', port: 8089, installed: () => false },
      f.deps
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/\/router laya install/);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it('refuses when the ONNX runtime is missing, and names the fix', async () => {
    const dir = tmpState();
    const f = fakes();
    const res = await startSidecar(
      { stateDir: dir, checkpoint: 'router@1.0.0', port: 8089, runtimeOk: () => false },
      f.deps
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/runtime/i);
    expect(f.spawn).not.toHaveBeenCalled();
  });
});

describe('startSidecar — the safety net around a real process', () => {
  it('hands the sidecar no provider credentials', async () => {
    const dir = tmpState();
    const f = fakes();
    process.env.OPENROUTER_API_KEY = 'sk-or-must-not-leak';
    try {
      await startSidecar({ stateDir: dir, checkpoint: 'router@1.0.0', port: 8089 }, f.deps);
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
    const opts = f.spawn.mock.calls[0]?.[2] as { env?: Record<string, string> };
    expect(opts.env).toBeDefined();
    expect(JSON.stringify(opts.env)).not.toContain('must-not-leak');
    expect(Object.keys(opts.env ?? {})).not.toContain('OPENROUTER_API_KEY');
  });

  it('refuses an endpoint it cannot serve, before spawning anything', async () => {
    const dir = tmpState();
    const f = fakes();
    const res = await startSidecar(
      { stateDir: dir, checkpoint: 'router@1.0.0', port: 8089, endpoint: 'http://10.0.0.5:8089' },
      f.deps
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/this machine|127\.0\.0\.1 only/);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it('refuses when a sidecar already answers but no pid is recorded (started in a terminal)', async () => {
    const dir = tmpState();
    const f = fakes();
    const res = await startSidecar(
      {
        stateDir: dir,
        checkpoint: 'router@1.0.0',
        port: 8089,
        whoAnswers: async () => ({ pid: 4242 }),
      },
      f.deps
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/started outside pi/i);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it('reports success only once /health answers', async () => {
    const dir = tmpState();
    const f = fakes();
    let probe = 0;
    const res = await startSidecar(
      {
        stateDir: dir,
        checkpoint: 'router@1.0.0',
        port: 8089,
        // Nothing listening yet, then it comes up: the normal startup.
        whoAnswers: async () => (++probe > 2 ? { pid: 4242 } : null),
      },
      f.deps
    );
    expect(res).toMatchObject({ ok: true, pid: 4242 });
    expect(probe).toBeGreaterThan(2);
  });

  it('stops the child again when /health never answers, and keeps no record', async () => {
    const dir = tmpState();
    const killed: NodeJS.Signals[] = [];
    const f = fakes({ alive: () => true, kill: (_p, sig) => killed.push(sig) });
    const res = await startSidecar(
      { stateDir: dir, checkpoint: 'router@1.0.0', port: 8089, whoAnswers: async () => null },
      f.deps
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/did not answer/i);
    expect(killed).toContain('SIGTERM');
    expect(readRecordedPid(dir)).toBeNull();
  });

  it('survives an asynchronous spawn error and reports it', async () => {
    const dir = tmpState();
    const emit: { error?: (err: Error) => void } = {};
    const f = fakes({ emit });
    const res = await startSidecar(
      {
        stateDir: dir,
        checkpoint: 'router@1.0.0',
        port: 8089,
        whoAnswers: async () => {
          emit.error?.(new Error('spawn ENOENT'));
          return null;
        },
      },
      f.deps
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/failed to start.*ENOENT/i);
    expect(readRecordedPid(dir)).toBeNull();
  });

  it('refuses a concurrent start while the pid file is reserved', async () => {
    const dir = tmpState();
    fs.writeFileSync(sidecarPaths(dir).pidFile, ''); // reserved, not yet written
    const f = fakes();
    const res = await startSidecar(
      { stateDir: dir, checkpoint: 'router@1.0.0', port: 8089 },
      f.deps
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/starting|in a moment/i);
    expect(f.spawn).not.toHaveBeenCalled();
  });
});

describe('stopSidecar', () => {
  it('signals the recorded pid and removes the file', async () => {
    const dir = tmpState();
    fs.writeFileSync(sidecarPaths(dir).pidFile, '4242');
    const killed: [number, NodeJS.Signals][] = [];
    // Alive until the signal lands, then gone — the normal SIGTERM path.
    let alive = true;
    const f = fakes({
      alive: () => alive,
      kill: (pid, sig) => {
        killed.push([pid, sig]);
        alive = false;
      },
    });
    const res = await stopSidecar(dir, f.deps, async () => ({ pid: 4242 }));
    expect(res).toMatchObject({ ok: true, pid: 4242 });
    expect(killed[0]).toEqual([4242, 'SIGTERM']);
    expect(fs.existsSync(sidecarPaths(dir).pidFile)).toBe(false);
  });

  it('escalates to SIGKILL when the process ignores SIGTERM', async () => {
    const dir = tmpState();
    fs.writeFileSync(sidecarPaths(dir).pidFile, '4242');
    const killed: [number, NodeJS.Signals][] = [];
    // Alive for the first probe (SIGTERM grace), gone afterwards would end it early;
    // keep it alive so the escalation path is the one exercised.
    const f = fakes({ alive: () => true, kill: (pid, sig) => killed.push([pid, sig]) });
    await stopSidecar(dir, f.deps, async () => ({ pid: 4242 }));
    // The target matters: signalling another pid would kill somebody else's work.
    expect(killed).toEqual([
      [4242, 'SIGTERM'],
      [4242, 'SIGKILL'],
    ]);
    expect(fs.existsSync(sidecarPaths(dir).pidFile)).toBe(true); // never exited
  });

  it('keeps the record and says so when the process survives SIGKILL', async () => {
    const dir = tmpState();
    fs.writeFileSync(sidecarPaths(dir).pidFile, '4242');
    const f = fakes({ alive: () => true });
    const res = await stopSidecar(dir, f.deps, async () => ({ pid: 4242 }));
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/still alive/i);
    expect(fs.existsSync(sidecarPaths(dir).pidFile)).toBe(true);
  });

  it('refuses to kill a live pid that does not answer as the sidecar (pid reuse)', async () => {
    const dir = tmpState();
    fs.writeFileSync(sidecarPaths(dir).pidFile, '4242');
    const killed: NodeJS.Signals[] = [];
    const f = fakes({ alive: () => true, kill: (_p, sig) => killed.push(sig) });
    const res = await stopSidecar(dir, f.deps, async () => null);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/different process|does not answer/i);
    expect(killed).toEqual([]);
    expect(fs.existsSync(sidecarPaths(dir).pidFile)).toBe(true);
  });

  it('treats a process that exits between the check and the signal as stopped', async () => {
    const dir = tmpState();
    fs.writeFileSync(sidecarPaths(dir).pidFile, '4242');
    let alive = true;
    const f = fakes({
      alive: () => alive,
      kill: () => {
        alive = false;
        const err = new Error('no such process') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      },
    });
    const res = await stopSidecar(dir, f.deps, async () => ({ pid: 4242 }));
    expect(res).toMatchObject({ ok: true, pid: 4242 });
    expect(fs.existsSync(sidecarPaths(dir).pidFile)).toBe(false);
  });

  it('says so when nothing is recorded', async () => {
    const dir = tmpState();
    const f = fakes();
    const res = await stopSidecar(dir, f.deps);
    expect(res).toMatchObject({ ok: false });
    expect(res.ok === false && res.error).toMatch(/no sidecar/i);
  });

  it('removes a stale pid file even when the process is already gone', async () => {
    const dir = tmpState();
    fs.writeFileSync(sidecarPaths(dir).pidFile, '4242');
    const f = fakes({ alive: () => false });
    const res = await stopSidecar(dir, f.deps);
    expect(res.ok).toBe(false);
    expect(fs.existsSync(sidecarPaths(dir).pidFile)).toBe(false);
  });
});

describe('describeSidecar', () => {
  it('reports not running when nothing is recorded', () => {
    const dir = tmpState();
    expect(describeSidecar(dir, fakes({ alive: () => false }).deps)).toMatchObject({
      running: false,
    });
  });

  it('reports the pid when the recorded process is alive', () => {
    const dir = tmpState();
    fs.writeFileSync(sidecarPaths(dir).pidFile, '4242');
    expect(describeSidecar(dir, fakes({ alive: () => true }).deps)).toMatchObject({
      running: true,
      pid: 4242,
    });
  });

  it('does not report a dead recorded pid as running', () => {
    const dir = tmpState();
    fs.writeFileSync(sidecarPaths(dir).pidFile, '4242');
    expect(describeSidecar(dir, fakes({ alive: () => false }).deps)).toMatchObject({
      running: false,
    });
  });
});

// Sourcery PR #190: a /health answer proves that SOME sidecar listens on the
// endpoint, not that the recorded pid is it. After a crash the OS may hand the
// recorded number to an unrelated process while a sidecar started in a
// terminal answers on the port — signalling the recorded pid then kills
// somebody else's work. The sidecar reports its own pid on /health; only an
// answer carrying exactly the recorded (or just spawned) pid counts.
describe('the answering pid is the identity, not the answer itself', () => {
  it('stop: does not signal the recorded pid when a different sidecar answers', async () => {
    const dir = tmpState();
    fs.writeFileSync(sidecarPaths(dir).pidFile, '4242');
    const killed: number[] = [];
    const f = fakes({ alive: () => true, kill: (pid) => killed.push(pid) });
    const res = await stopSidecar(dir, f.deps, async () => ({ pid: 9999 }));
    expect(killed).toEqual([]);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/9999/);
    expect(res.ok === false && res.error).toMatch(/4242/);
    expect(fs.existsSync(sidecarPaths(dir).pidFile)).toBe(true);
  });

  it('stop: does not signal when the answer carries no pid (identity unknown)', async () => {
    const dir = tmpState();
    fs.writeFileSync(sidecarPaths(dir).pidFile, '4242');
    const killed: number[] = [];
    const f = fakes({ alive: () => true, kill: (pid) => killed.push(pid) });
    const res = await stopSidecar(dir, f.deps, async () => ({}));
    expect(killed).toEqual([]);
    expect(res.ok === false && res.error).toMatch(/does not report its pid/i);
  });

  it('start: a different sidecar answering does not confirm the spawned child', async () => {
    const dir = tmpState();
    const killed: number[] = [];
    let probes = 0;
    const f = fakes({ alive: () => true, kill: (pid) => killed.push(pid) });
    const res = await startSidecar(
      {
        stateDir: dir,
        checkpoint: 'router@1.0.0',
        port: 8089,
        // Nobody answers before the spawn; afterwards a foreign sidecar does.
        whoAnswers: async () => (++probes > 1 ? { pid: 9999 } : null),
      },
      f.deps
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/9999/);
    expect(killed).toContain(4242); // our own child, stopped again
    expect(killed).not.toContain(9999);
    expect(fs.existsSync(sidecarPaths(dir).pidFile)).toBe(false);
  });

  it('start: a recorded live pid is not "already running" when another pid answers', async () => {
    const dir = tmpState();
    fs.writeFileSync(sidecarPaths(dir).pidFile, '4242');
    const f = fakes({ alive: () => true });
    const res = await startSidecar(
      {
        stateDir: dir,
        checkpoint: 'router@1.0.0',
        port: 8089,
        whoAnswers: async () => ({ pid: 9999 }),
      },
      f.deps
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).not.toMatch(/already running \(pid 4242\)/);
    expect(res.ok === false && res.error).toMatch(/9999/);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it('answerFromHealth reads only a positive integer pid', () => {
    const read = answerFromHealth;
    expect(read(null)).toBeNull();
    expect(read({ status: 'ok', pid: 4242 })).toEqual({ pid: 4242 });
    for (const pid of ['4242', 0, -1, 4.5, Number.NaN, 2 ** 53]) {
      expect(read({ status: 'ok', pid })).toEqual({});
    }
    expect(read({ status: 'ok' })).toEqual({});
  });
});
