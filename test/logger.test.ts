// test/logger.test.ts
// Log levels, change-only debug lines and size-based rotation. router.log
// had grown to ~2M lines / 322 MB, 75% of it one repeated [diag] line.

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  routerLog,
  warnLog,
  errorLog,
  debugLog,
  debugLogOnce,
  setLogLevel,
  configureLogRotation,
} from '../src/logger.ts';

const logPath = () => path.join(os.homedir(), '.pi', 'logs', 'router.log');
const read = (p = logPath()) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '');

beforeEach(() => {
  fs.rmSync(path.dirname(logPath()), { recursive: true, force: true });
  configureLogRotation({ maxBytes: 20 * 1024 * 1024, keep: 5 });
  setLogLevel('info');
});

describe('log levels', () => {
  it('drops debug lines at info level and writes them at debug level', () => {
    debugLog('[diag] hidden');
    routerLog('[router] visible');
    expect(read()).not.toContain('hidden');
    expect(read()).toContain('visible');

    setLogLevel('debug');
    debugLog('[diag] now shown');
    expect(read()).toContain('now shown');
  });

  it('gates by severity: errorLog always, warnLog from warn, info from info (release levels 2026-10-02)', () => {
    setLogLevel('error');
    errorLog('[router] hard failure');
    warnLog('[router] soft problem');
    routerLog('[router] routine info');
    debugLog('[diag] noise');
    expect(read()).toContain('hard failure');
    expect(read()).not.toContain('soft problem');
    expect(read()).not.toContain('routine info');
    expect(read()).not.toContain('noise');

    setLogLevel('warn');
    errorLog('[router] hard2');
    warnLog('[router] soft2');
    routerLog('[router] routine2');
    expect(read()).toContain('hard2');
    expect(read()).toContain('soft2');
    expect(read()).not.toContain('routine2');

    setLogLevel('info');
    routerLog('[router] routine3');
    expect(read()).toContain('routine3');
  });

  it('keeps warn/error lines at debug level too (debug is the most verbose)', () => {
    setLogLevel('debug');
    errorLog('[router] e');
    warnLog('[router] w');
    expect(read()).toContain('e');
    expect(read()).toContain('w');
  });

  it('debugLogOnce writes a key again only when its message changes', () => {
    setLogLevel('debug');
    debugLogOnce('skip:a', '[diag] a skipped: no key');
    debugLogOnce('skip:a', '[diag] a skipped: no key');
    debugLogOnce('skip:a', '[diag] a skipped: not registered');
    debugLogOnce('skip:b', '[diag] b skipped: no key');
    const lines = read().split('\n').filter(Boolean);
    expect(lines.filter((l) => l.includes('a skipped: no key'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('a skipped: not registered'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('b skipped'))).toHaveLength(1);
  });
});

describe('rotation', () => {
  it('rotates at maxBytes and keeps at most `keep` files', () => {
    configureLogRotation({ maxBytes: 200, keep: 3 });
    for (let i = 0; i < 40; i++) routerLog(`[router] line ${i} ${'x'.repeat(40)}`);
    const dir = path.dirname(logPath());
    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual(['router.log', 'router.log.1', 'router.log.2']);
    for (const f of files) expect(fs.statSync(path.join(dir, f)).size).toBeLessThanOrEqual(200 + 120);
    expect(read()).toContain('line 39');
    expect(read(path.join(dir, 'router.log.1'))).not.toContain('line 39');
  });

  it('rotates an oversized existing log on the first write', () => {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.writeFileSync(logPath(), 'old\n'.repeat(100));
    configureLogRotation({ maxBytes: 200, keep: 5 });
    routerLog('[router] fresh');
    expect(read()).not.toContain('old');
    expect(read(`${logPath()}.1`)).toContain('old');
  });

  it('sees writes from other processes (shared log file, review 2026-09-27)', () => {
    configureLogRotation({ maxBytes: 300, keep: 3 });
    routerLog('[router] mine');
    // Another Pi session appends to the same file.
    fs.appendFileSync(logPath(), 'other process line\n'.repeat(30));
    routerLog('[router] mine again');
    expect(read()).toContain('mine again');
    expect(read()).not.toContain('other process line');
    expect(read(`${logPath()}.1`)).toContain('other process line');
  });

  it('keeps the line when rotation fails (e.g. another process rotated first)', () => {
    configureLogRotation({ maxBytes: 100, keep: 2 });
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.writeFileSync(logPath(), 'x'.repeat(200));
    // An undeletable router.log.1 makes the rotation throw.
    fs.mkdirSync(`${logPath()}.1`);
    fs.writeFileSync(path.join(`${logPath()}.1`, 'blocker'), '');
    routerLog('[router] must not be lost');
    expect(read()).toContain('must not be lost');
  });

  it('backs off after a failed rotation instead of retrying on every line', () => {
    configureLogRotation({ maxBytes: 100, keep: 2 });
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.writeFileSync(logPath(), 'x'.repeat(200));
    fs.mkdirSync(`${logPath()}.1`);
    fs.writeFileSync(path.join(`${logPath()}.1`, 'blocker'), '');
    for (let i = 0; i < 5; i++) routerLog(`[router] line ${i}`);
    const failures = read().split('\n').filter((l) => l.includes('log rotation failed'));
    expect(failures).toHaveLength(1);
    expect(read()).toContain('line 4');
  });
});
