// test/home-isolation.test.ts
// Guards test/setup/isolate-home.ts: no test may see the developer's real
// home directory. The real ~/.pi/agent/router-config.user.json leaked into
// the suite and masked a red CI for four pushes (ADR-0009).

import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadLayeredConfig } from '../src/config-loader.js';

describe('test home isolation', () => {
  it('homedir() is a throwaway temp dir, not the real home', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');
    // userInfo() reads the passwd entry, not HOME, so it is the real home.
    expect(os.homedir()).not.toBe(actual.userInfo().homedir);
    expect(fs.realpathSync(os.homedir()).startsWith(fs.realpathSync(actual.tmpdir()))).toBe(true);
    expect(process.env.HOME).toBe(os.homedir());
  });

  it('loadLayeredConfig picks up no global user override', () => {
    const repoRoot = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
    const { sources } = loadLayeredConfig(repoRoot, os.tmpdir());
    expect(sources.some((s) => s.endsWith('router-config.user.json'))).toBe(false);
  });

  it('router state (dynamic config, scan cache) lives in a per-file temp dir, not the checkout', () => {
    const repoRoot = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
    const stateDir = process.env.PI_ROUTER_STATE_DIR;
    expect(stateDir).toBeTruthy();
    expect(fs.realpathSync(stateDir!)).not.toBe(fs.realpathSync(repoRoot));
    expect(fs.existsSync(path.join(stateDir!, '.cache'))).toBe(true);
  });
});
