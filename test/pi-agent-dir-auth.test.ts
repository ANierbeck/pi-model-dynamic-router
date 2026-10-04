// test/pi-agent-dir-auth.test.ts
// PI_CODING_AGENT_DIR-aware agent dir resolution (piAgentDir) is still
// required for router-config.user.json loading in container/profile setups
// (the pi-work container, where ~/.pi is not even mounted).
//
// The auth.json part of this file was removed with ADR-0022: the router no
// longer reads Pi's auth.json at all — pi resolves credentials itself via
// modelRegistry.getApiKeyForProvider.

import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { piAgentDir } from '../src/config-loader.ts';

describe('PI_CODING_AGENT_DIR-aware agent dir', () => {
  it('piAgentDir defaults to ~/.pi/agent', () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '');
    expect(piAgentDir()).toBe(path.join(os.homedir(), '.pi', 'agent'));
  });

  // Pi's own getAgentDir() expands a leading ~ in PI_CODING_AGENT_DIR. A value
  // set without shell expansion (.env file, programmatic setter) would
  // otherwise yield a literal "~/..." path that node:fs cannot open, silently
  // dropping router-config.user.json.
  it('piAgentDir expands a leading ~ like Pi does', () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '~');
    expect(piAgentDir()).toBe(os.homedir());
    vi.stubEnv('PI_CODING_AGENT_DIR', '~/work/agent');
    expect(piAgentDir()).toBe(path.join(os.homedir(), 'work', 'agent'));
  });
});
