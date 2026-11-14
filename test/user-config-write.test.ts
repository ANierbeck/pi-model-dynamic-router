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

describe('UserConfigStore.applyDelta — table paths (config plan Phase 2)', () => {
  it('sets one classifier key and keeps exclude, the sibling keys and unrelated settings', () => {
    fs.writeFileSync(
      userFile,
      JSON.stringify({
        log_level: 'debug',
        exclude: { models: ['a/b'] },
        classifier: { local: { model: 'ollama/x:1b' }, cloud: { model: 'acme/c' } },
      })
    );
    const res = store().applyDelta({ paths: [{ path: 'classifier.cloud.enabled', value: false }] });
    expect(res.ok).toBe(true);
    expect(readUser()).toEqual({
      log_level: 'debug',
      exclude: { models: ['a/b'] },
      classifier: { local: { model: 'ollama/x:1b' }, cloud: { model: 'acme/c', enabled: false } },
    });
  });

  it('unset removes only that leaf and drops parents it leaves empty', () => {
    fs.writeFileSync(userFile, JSON.stringify({ classifier: { cloud: { model: 'acme/c' } } }));
    const res = store().applyDelta({ paths: [{ path: 'classifier.cloud.model', unset: true }] });
    expect(res.ok).toBe(true);
    expect(readUser()).toEqual({});
  });

  it.each([
    'providers.x.enabled',
    'classifier.log.store_text',
    'integrations.laya.enabled',
    'classifier.cloud.enable',
  ])('refuses "%s" — not a settable table key — and writes nothing', (path) => {
    const res = store().applyDelta({ paths: [{ path, value: true }] });
    expect(res.ok).toBe(false);
    expect(fs.existsSync(userFile)).toBe(false);
  });

  it('refuses a value of the wrong kind for the key', () => {
    const res = store().applyDelta({
      paths: [{ path: 'classifier.cloud.enabled', value: 'yes' }],
    });
    expect(res.ok).toBe(false);
    expect(fs.existsSync(userFile)).toBe(false);
  });

  it('refuses when a section on the way is not an object, and keeps the file', () => {
    const before = JSON.stringify({ classifier: 'oops' });
    fs.writeFileSync(userFile, before);
    const res = store().applyDelta({ paths: [{ path: 'classifier.cloud.enabled', value: true }] });
    expect(res.ok).toBe(false);
    expect(fs.readFileSync(userFile, 'utf-8')).toBe(before);
  });

  it('a write removes the pre-2.0 spelling of the same key from the user file', () => {
    fs.writeFileSync(
      userFile,
      JSON.stringify({
        model_groups: { dynamic: { method: 'dynamic', classifier_cloud_chain: true } },
        classifier_log: { keep: 2, enabled: true },
      })
    );
    const res = store().applyDelta({
      paths: [
        { path: 'classifier.cloud.enabled', value: false },
        { path: 'classifier.log.enabled', value: false },
      ],
    });
    expect(res.ok).toBe(true);
    expect(readUser()).toEqual({
      model_groups: { dynamic: { method: 'dynamic' } },
      classifier_log: { keep: 2 },
      classifier: { cloud: { enabled: false }, log: { enabled: false } },
    });
  });
});
