// Host-upgrade gate (AGENTS §10): the shell helpers in
// spikes/virtual-models/gate-lib.sh and the exit decision of
// spikes/virtual-models/router-shape-run.ts. The gate scripts themselves need
// an installed pi and run by hand; their decision logic lives here so a
// regression (a gate that always passes, or always fails) is caught by the suite.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PI_1_6_0_EXPECTED_FAIL, shapeVerdict } from '../spikes/virtual-models/shape-verdict.ts';

const SPIKES = path.resolve(__dirname, '../spikes/virtual-models');
const LIB = path.join(SPIKES, 'gate-lib.sh');

interface ShResult {
  code: number | null;
  out: string;
  err: string;
}

function sh(body: string, env: Record<string, string | undefined> = {}): ShResult {
  const r = spawnSync('bash', ['-c', `source "${LIB}"; ${body}`], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 20_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-gate-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('gate-lib.sh: counts', () => {
  it('same_count treats a padded count as equal (macOS wc -l pads with spaces)', () => {
    expect(sh('same_count 2 "       2"').code).toBe(0);
    expect(sh('same_count 2 "       3"').code).toBe(1);
  });

  it('count_lines prints an unpadded number, 0 for a missing file', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'f'), 'a\nb\n');
    expect(sh(`count_lines "${d}/f"`).out).toBe('2\n');
    expect(sh(`count_lines "${d}/missing"`).out).toBe('0\n');
  });
});

describe('gate-lib.sh: route_reasons', () => {
  it('joins the route() reasons of a probe log in order', () => {
    const d = tmp();
    fs.writeFileSync(
      path.join(d, 'routes.jsonl'),
      '{"t":1,"reason":"user","picked":"spike-a"}\n{"t":2,"reason":"retry","picked":"spike-c"}\n'
    );
    expect(sh(`route_reasons "${d}/routes.jsonl"`).out).toBe('user,retry\n');
    expect(sh(`route_reasons "${d}/missing"`).out).toBe('\n');
  });
});

describe('gate-lib.sh: check_case', () => {
  // check_case LABEL WANT_REASONS GOT_REASONS WANT_HUNG GOT_HUNG WANT_EXIT GOT_EXIT WANT_ANSWER GOT_ANSWER
  it('passes when every observed outcome matches the baseline', () => {
    const r = sh('check_case "plain 429" user,retry user,retry no no 0 0 ok "ok"');
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('FAIL');
  });

  it('fails on a different retry sequence with the same route() count', () => {
    const r = sh('check_case "x" user,retry user,continuation no no 0 0 ok ok');
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL');
    expect(r.out).toContain('user,continuation');
  });

  it('fails when a case that must finish hangs, and when the hanging case stops hanging', () => {
    expect(sh('check_case "x" user user no yes 0 143 ok ""').code).toBe(1);
    expect(sh('check_case "stall" user user yes no - 0 "" "Request was aborted"').code).toBe(1);
  });

  it('ignores the exit status of a case that hangs by baseline (it was killed)', () => {
    expect(sh('check_case "stall" user user yes yes - 143 "" ""').code).toBe(0);
  });

  it('fails on a different exit status or answer', () => {
    expect(sh('check_case "x" user user no no 0 1 ok ok').code).toBe(1);
    expect(sh('check_case "x" user user no no 0 0 ok "429: rate limit"').code).toBe(1);
  });

  it('matches the answer as a prefix, and <empty> only an empty answer', () => {
    expect(sh('check_case "x" user user no no 0 0 "429: {" "429: {\\"message\\":1}"').code).toBe(0);
    expect(sh('check_case "x" user user no no 0 0 "<empty>" ""').code).toBe(0);
    expect(sh('check_case "x" user user no no 0 0 "<empty>" "ok"').code).toBe(1);
  });
});

describe('gate-lib.sh: bounded waits', () => {
  it('run_bounded returns the command status, 124 on expiry, and kills the command', () => {
    expect(sh('run_bounded 5 bash -c "exit 3"').code).toBe(3);
    const t0 = Date.now();
    expect(sh('run_bounded 1 sleep 30').code).toBe(124);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('wait_for_line returns 0 once the line appears, 1 after the bound', () => {
    const d = tmp();
    const f = path.join(d, 'server.log');
    expect(
      sh(
        `( sleep 0.3; echo "fake provider on 8791" > "${f}" ) & wait_for_line "${f}" "fake provider on" 5`
      ).code
    ).toBe(0);
    expect(sh(`wait_for_line "${d}/never.log" "fake provider on" 1`).code).toBe(1);
  });
});

describe('gate-lib.sh: resolve_out_dir', () => {
  it('creates a fresh private directory when SPIKE_OUT is unset', () => {
    const r = sh('resolve_out_dir vm-gate', { SPIKE_OUT: undefined, TMPDIR: tmp() });
    expect(r.code).toBe(0);
    const dir = r.out.trim();
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('refuses a SPIKE_OUT that is a symlink', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'real'));
    fs.symlinkSync(path.join(d, 'real'), path.join(d, 'link'));
    const r = sh('resolve_out_dir vm-gate', { SPIKE_OUT: path.join(d, 'link') });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('symlink');
  });

  it('uses an explicit SPIKE_OUT directory as given', () => {
    const d = tmp();
    const r = sh('resolve_out_dir vm-gate', { SPIKE_OUT: path.join(d, 'out') });
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(path.join(d, 'out'));
  });
});

describe('shape-verdict: the Pi 1.6.0 baseline', () => {
  const pass = (id: string): { id: string; ok: boolean } => ({ id, ok: true });

  it('records G1b as the known Pi 1.6.0 failure', () => {
    expect([...PI_1_6_0_EXPECTED_FAIL]).toEqual(['G1b']);
  });

  it('passes the baseline run: G1b fails as recorded, INFO rows have no criterion', () => {
    const v = shapeVerdict([
      pass('A1'),
      { id: 'G1', ok: null },
      { id: 'G1b', ok: false },
      pass('G1c'),
    ]);
    expect(v).toEqual({ exitCode: 0, unexpectedFail: [], unexpectedPass: [] });
  });

  it('fails on any other failed check', () => {
    const v = shapeVerdict([
      { id: 'G1b', ok: false },
      { id: 'B1', ok: false },
    ]);
    expect(v.exitCode).toBe(1);
    expect(v.unexpectedFail).toEqual(['B1']);
  });

  it('fails when the recorded failure no longer fails, so the baseline gets re-recorded', () => {
    const v = shapeVerdict([pass('G1b')]);
    expect(v.exitCode).toBe(1);
    expect(v.unexpectedPass).toEqual(['G1b']);
  });
});

describe('the gate scripts use the shared decision logic', () => {
  const read = (f: string): string => fs.readFileSync(path.join(SPIKES, f), 'utf8');

  it('run-retry-matrix.sh decides per case with check_case, bounded, in a private out dir', () => {
    const s = read('run-retry-matrix.sh');
    expect(s).toContain('source "$here/gate-lib.sh"');
    expect(s).toContain('check_case ');
    expect(s).toContain('resolve_out_dir ');
    expect(s).toContain('wait_for_line ');
    expect(s).not.toMatch(/\[ "\$calls" != "\$want" \]/);
  });

  it('run-router-shape.sh waits for the server, bounds the runner and keeps its exit status', () => {
    const s = read('run-router-shape.sh');
    expect(s).toContain('source "$here/gate-lib.sh"');
    expect(s).toContain('wait_for_line ');
    expect(s).toContain('run_bounded ');
    expect(s).toContain('resolve_out_dir ');
  });

  it('router-shape-run.ts exits with the shape verdict', () => {
    const s = read('router-shape-run.ts');
    expect(s).toContain("from './shape-verdict.ts'");
    expect(s).toContain('process.exit(verdict.exitCode)');
  });
});
