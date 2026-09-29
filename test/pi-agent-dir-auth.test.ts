// test/pi-agent-dir-auth.test.ts
// Regression: discovery read Pi's auth.json from a hardcoded ~/.pi/agent, so
// a Pi profile running with PI_CODING_AGENT_DIR (the pi-work container, where
// ~/.pi is not even mounted) never saw its own auth entries.

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadAuthFile } from '../src/discovery.ts';
import { piAgentDir } from '../src/config-loader.ts';

describe('PI_CODING_AGENT_DIR-aware agent dir', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('piAgentDir defaults to ~/.pi/agent', () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '');
    expect(piAgentDir()).toBe(path.join(os.homedir(), '.pi', 'agent'));
  });

  // Pi's own getAgentDir() expands a leading ~ in PI_CODING_AGENT_DIR. A value
  // set without shell expansion (.env file, programmatic setter) would
  // otherwise yield a literal "~/..." path that node:fs cannot open, silently
  // dropping auth.json and router-config.user.json.
  it('piAgentDir expands a leading ~ like Pi does', () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '~');
    expect(piAgentDir()).toBe(os.homedir());
    vi.stubEnv('PI_CODING_AGENT_DIR', '~/work/agent');
    expect(piAgentDir()).toBe(path.join(os.homedir(), 'work', 'agent'));
  });

  it('loadAuthFile reads auth.json from a ~-relative PI_CODING_AGENT_DIR', () => {
    tmpDir = fs.mkdtempSync(path.join(os.homedir(), '.pi-agent-dir-test-'));
    fs.writeFileSync(
      path.join(tmpDir, 'auth.json'),
      JSON.stringify({ requesty: { type: 'api_key', key: 'tilde-marker' } })
    );
    vi.stubEnv('PI_CODING_AGENT_DIR', `~/${path.basename(tmpDir)}`);
    expect(loadAuthFile()).toEqual({ requesty: { type: 'api_key', key: 'tilde-marker' } });
  });

  it('loadAuthFile reads auth.json from PI_CODING_AGENT_DIR', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-dir-'));
    fs.writeFileSync(
      path.join(tmpDir, 'auth.json'),
      JSON.stringify({ requesty: { type: 'api_key', key: 'work-profile-marker' } })
    );
    vi.stubEnv('PI_CODING_AGENT_DIR', tmpDir);
    expect(loadAuthFile()).toEqual({ requesty: { type: 'api_key', key: 'work-profile-marker' } });
  });
});
