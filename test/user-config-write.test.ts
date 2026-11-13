// Concurrent writers and malformed sections of the user config file
// (review of PR #152): a second router writing at the same time must not
// lose an edit, and a section that is not an object must not be replaced silently.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openUserConfigStore } from '../src/user-config-store.ts';

let agentDir: string;
let userFile: string;
let lockFile: string;

beforeEach(() => {
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-cfg-write-'));
  userFile = path.join(agentDir, 'router-config.user.json');
  lockFile = `${userFile}.lock`;
});

afterEach(() => {
  fs.rmSync(agentDir, { recursive: true, force: true });
});

const store = () => openUserConfigStore({ agentDir });
const readUser = (): unknown => JSON.parse(fs.readFileSync(userFile, 'utf-8'));

describe('UserConfigStore.applyDelta — concurrent writers', () => {
  it('refuses to write while another writer holds the lock, and leaves the file alone', () => {
    fs.writeFileSync(userFile, JSON.stringify({ log_level: 'debug' }));
    fs.writeFileSync(lockFile, '999999');
    const res = store().applyDelta({ exclude: { models: ['a/b'] } });
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error).toMatch(/another/i);
    expect(readUser()).toEqual({ log_level: 'debug' });
    expect(fs.existsSync(lockFile)).toBe(true); // not ours to remove
  });

  it('takes over a stale lock left by a writer that crashed', () => {
    fs.writeFileSync(lockFile, '999999');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile, old, old);
    const res = store().applyDelta({ exclude: { models: ['a/b'] } });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('removes its own lock after a successful write', () => {
    expect(store().applyDelta({ exclude: { models: ['a/b'] } }).ok).toBe(true);
    expect(fs.existsSync(lockFile)).toBe(false);
  });
});

describe('UserConfigStore.applyDelta — non-object sections', () => {
  it('refuses an exclude section that is not an object, and keeps it', () => {
    fs.writeFileSync(userFile, JSON.stringify({ exclude: 'oops' }));
    const res = store().applyDelta({ exclude: { models: ['a/b'] } });
    expect(res.ok).toBe(false);
    expect(readUser()).toEqual({ exclude: 'oops' });
  });

  it('refuses a context_budget section that is not an object, and keeps it', () => {
    fs.writeFileSync(userFile, JSON.stringify({ context_budget: [1] }));
    const res = store().applyDelta({ context_budget: { enabled: true } });
    expect(res.ok).toBe(false);
    expect(readUser()).toEqual({ context_budget: [1] });
  });

  it('refuses an integrations section that is not an object, and keeps it', () => {
    fs.writeFileSync(userFile, JSON.stringify({ integrations: 'oops' }));
    const res = store().applyDelta({ integrations: { laya: { enabled: true } } });
    expect(res.ok).toBe(false);
    expect(readUser()).toEqual({ integrations: 'oops' });
  });

  // Release review 2026-11-13 (Config/CLI, verified against the code): the
  // check covered only the top-level section, so a non-object BLOCK inside an
  // object section was silently replaced with { enabled: true }.
  it('refuses an integration block that is not an object, and keeps it', () => {
    fs.writeFileSync(userFile, JSON.stringify({ integrations: { laya: 'oops' } }));
    const res = store().applyDelta({ integrations: { laya: { enabled: true } } });
    expect(res.ok).toBe(false);
    expect(readUser()).toEqual({ integrations: { laya: 'oops' } });
  });
});
