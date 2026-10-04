// test/secret-manager-command.test.ts
// Regression / feature tests for "!..." shell-command key resolution
// (owner request 2026-10-04): pi's auth.json supports a `!`-prefixed key that
// is executed at runtime (docs/providers.md), but the router's resolveKeyRef
// only handled "!pass show". Without the fix a "!..." value was sent raw as a
// bearer token → 401.
//
// Security note: resolved values are trimmed, never logged, and discarded on
// error/timeout. No real keys are used in these tests; execSync is mocked
// throughout (the REAL timeout kill is pinned separately in
// secret-manager-command-timeout.test.ts, which does not mock).

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import * as d from '../src/discovery.ts';
import { DiscoveryManager } from '../src/discovery.ts';
import type { Config, Cache } from '../src/types.ts';

vi.mock('node:child_process', () => ({ execSync: vi.fn() }));

function freshCfg(): Config {
  return { providers: {}, model_groups: {}, model_metrics: {} };
}

function freshCache(): Cache {
  return {};
}

function resolve(key: string, auth: Record<string, unknown> = {}): string | null {
  return d.resolveKeyRef(key, auth as Parameters<typeof d.resolveKeyRef>[1]);
}

/** Points the mocked execSync at `impl` and returns its call counter. */
function mockExec(impl: () => string): { calls: () => number } {
  const fn = vi.mocked(execSync);
  fn.mockImplementation(impl as unknown as typeof execSync);
  return { calls: () => fn.mock.calls.length };
}

afterEach(() => {
  vi.mocked(execSync).mockReset();
  vi.restoreAllMocks();
  if (typeof d.clearKeyCommandCache === 'function') d.clearKeyCommandCache();
});

describe('resolveKeyRef handles "!..." shell commands', () => {
  it('(a) a raw "!..." command is executed, output trimmed', () => {
    mockExec(() => ' testkey\n');
    expect(resolve('!echo testkey')).toBe('testkey');
  });

  it('(a) empty output resolves to null', () => {
    mockExec(() => '   \n');
    expect(resolve('!echo empty')).toBeNull();
  });

  it('(b) an auth.json entry with a "!..." key value is executed via __auth_json__', () => {
    mockExec(() => 'authcommandval\n');
    expect(resolve('__auth_json__:foo', { foo: { key: '!echo authcommandval' } })).toBe(
      'authcommandval'
    );
  });

  it('(b) the same works for the legacy "__oauth__" marker', () => {
    mockExec(() => 'oauthcmdval\n');
    expect(resolve('__oauth__:bar', { bar: { key: '!echo oauthcmdval' } })).toBe('oauthcmdval');
  });

  it('(b) a plain (non-command) auth.json key is returned literally, no env lookup', () => {
    // pi treats a bare auth.json key as a literal (no $-template resolution);
    // the router must not accidentally resolve it as an env var name.
    const old = process.env.CMDTEST_PLAIN;
    process.env.CMDTEST_PLAIN = 'from-env';
    try {
      expect(resolve('__auth_json__:p', { p: { key: 'CMDTEST_PLAIN' } })).toBe('CMDTEST_PLAIN');
    } finally {
      process.env.CMDTEST_PLAIN = old;
    }
  });

  it('(c) a failing command resolves to null (not to the literal string)', () => {
    mockExec(() => {
      throw Object.assign(new Error('no such command'), { code: 'ENOENT' });
    });
    expect(resolve('!thiscommanddoesnotexist')).toBeNull();
  });

  it('(c) a non-zero exit resolves to null (not to the literal string)', () => {
    mockExec(() => {
      throw Object.assign(new Error('exit 1'), { status: 1 });
    });
    expect(resolve('!false')).toBeNull();
  });

  it('(d) a timeout error resolves to null (does not hang the process)', () => {
    mockExec(() => {
      throw Object.assign(new Error('timed out'), { timedOut: true });
    });
    expect(resolve('!longcommand')).toBeNull();
  });

  it('(e) the legacy "!pass show" marker is executed unchanged', () => {
    mockExec(() => 'passshowval\n');
    expect(resolve('!pass show foo/bar')).toBe('passshowval');
  });

  it('(e) a failing "!pass show" resolves to null (pre-existing behavior)', () => {
    mockExec(() => {
      throw Object.assign(new Error('pass not found'), { code: 'ENOENT' });
    });
    expect(resolve('!pass show nonexistent')).toBeNull();
  });

  it('(f) env vars are still resolved (no regression)', () => {
    const old = process.env.CMDTEST_VAR;
    process.env.CMDTEST_VAR = 'envresolved';
    try {
      expect(resolve('CMDTEST_VAR')).toBe('envresolved');
    } finally {
      process.env.CMDTEST_VAR = old;
    }
  });

  it('(f) __cli_oauth__ is unchanged (no regression)', () => {
    const tmp = fs.mkdtempSync('/tmp/secret-cmd-');
    try {
      fs.writeFileSync(tmp + '/creds.json', JSON.stringify({ token: 'cli-token-val' }));
      expect(resolve('__cli_oauth__:' + tmp + '/creds.json:token')).toBe('cli-token-val');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('(f) __local__ and raw keys are unchanged (no regression)', () => {
    expect(resolve('__local__')).toBe('local');
    expect(resolve('rawlegacykey123')).toBe('rawlegacykey123');
  });

  it('caching: the same command runs only once per process', () => {
    const m = mockExec(() => 'v\n');
    expect(resolve('!cachea')).toBe('v');
    expect(resolve('!cachea')).toBe('v');
    expect(m.calls()).toBe(1);
  });

  it('caching: different commands are cached separately', () => {
    const m = mockExec(() => 'v\n');
    expect(resolve('!cacheb')).toBe('v');
    expect(resolve('!cachec')).toBe('v');
    expect(m.calls()).toBe(2);
  });

  it('caching: a failed command result is also cached', () => {
    const m = mockExec(() => {
      throw Object.assign(new Error('fail'), { status: 1 });
    });
    expect(resolve('!cachefail')).toBeNull();
    expect(resolve('!cachefail')).toBeNull();
    expect(m.calls()).toBe(1);
  });

  it('discoverKeys() stores only the marker, never the resolved command or its output (requirement 2)', () => {
    vi.spyOn(DiscoveryManager.prototype, 'loadAuth').mockReturnValue({
      mistral: { key: '!echo secret-output-that-must-not-end-up-in-cfg' },
    });

    const dm = new DiscoveryManager(freshCfg(), freshCache());
    dm.discoverKeys();

    const mistralKeys = dm.getConfig().providers?.mistral?.keys ?? [];
    const authEntry = mistralKeys.find((k) => k.label === 'auth.json');
    expect(authEntry?.key).toBe('__auth_json__:mistral');
    // No resolved output anywhere in the persistable config.
    expect(JSON.stringify(dm.getConfig())).not.toContain(
      'secret-output-that-must-not-end-up-in-cfg'
    );
  });

  it('resolveKeyValue() resolves an auth.json command entry end-to-end (the live 2026-10-04 shape)', () => {
    vi.spyOn(DiscoveryManager.prototype, 'loadAuth').mockReturnValue({
      mistral: { type: 'api_key', key: '!echo vibe-plan-key-value' },
    });
    mockExec(() => 'vibe-plan-key-value\n');

    const dm = new DiscoveryManager(freshCfg(), freshCache());
    expect(dm.resolveKeyValue('__auth_json__:mistral')).toBe('vibe-plan-key-value');
  });
});
