/**
 * Live finding 2026-10-03: three concurrent pi instances (different
 * projects) interleave in the global ~/.pi/logs/router.log with no
 * provenance — correlation was only possible via timestamps. The
 * project-local mirror (<cwd>/.pi/logs/router.log) already exists.
 *
 * Fix (owner 2026-10-03): every line in the GLOBAL log carries a
 * [<project>/<pid>] tag after the timestamp; the project log stays
 * untagged; when both paths are identical (pi started in the home
 * directory) the line is written exactly once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  routerLog,
  setLogLevel,
  setProjectLogDir,
  configureLogRotation,
} from '../src/logger.ts';

const homeLog = () => path.join(os.homedir(), '.pi', 'logs', 'router.log');
const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '');
const lastLine = (p: string) => read(p).trimEnd().split('\n').pop() ?? '';

let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  fs.rmSync(path.dirname(homeLog()), { recursive: true, force: true });
  configureLogRotation({ maxBytes: 20 * 1024 * 1024, keep: 5 });
  setLogLevel('info');
});

afterEach(() => {
  setProjectLogDir(undefined);
  cwdSpy?.mockRestore();
  cwdSpy = undefined;
});

describe('global router.log provenance tag', () => {
  it('home lines carry [<project>/<pid>] after the timestamp; project lines stay untagged', () => {
    setProjectLogDir('/tmp/some-project');
    routerLog('[router] tagged check');
    const tag = `[${path.basename('/tmp/some-project')}/${process.pid}]`;
    expect(lastLine(homeLog())).toContain(tag);
    expect(lastLine(homeLog())).toContain('[router] tagged check');
    // ISO timestamp still leads the line (log tooling contract).
    expect(lastLine(homeLog())).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    const projLog = path.join('/tmp/some-project', '.pi', 'logs', 'router.log');
    expect(read(projLog)).not.toContain(tag);
  });

  it('falls back to a [pi/<pid>] tag before session_start sets the project', () => {
    setProjectLogDir(undefined);
    routerLog('[router] early line');
    expect(lastLine(homeLog())).toContain(`[pi/${process.pid}]`);
  });

  it('writes exactly once when the project log dir IS the home log dir', () => {
    // Pi started directly in the home directory: both paths identical —
    // previously every line was appended twice.
    setProjectLogDir(os.homedir());
    routerLog('[router] dedupe check');
    const content = read(homeLog());
    const occurrences = content.split('[router] dedupe check').length - 1;
    expect(occurrences).toBe(1);
    // The single line still carries the provenance tag.
    expect(lastLine(homeLog())).toContain(`[${path.basename(os.homedir())}/${process.pid}]`);
  });
});
