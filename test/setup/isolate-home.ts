// Every test file gets a fresh, empty home directory and a fresh router state
// directory. Without this, tests read the developer's real
// ~/.pi/agent/router-config.user.json (and auth.json), write to the real
// ~/.pi/logs/router.log, and back up / overwrite the checkout's own
// router-config.dynamic.json and .cache/scan-cache.json (ADR-0009, ADR-0015).
// os.homedir() is mocked rather than only setting HOME, because the native
// lookup does not reliably observe process.env writes under vitest's worker
// pools. A test file's own vi.mock('node:os') still wins.
// Everything lives under the root created by home-root.ts, which removes it.

import { vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = process.env.ROUTER_TEST_HOME_ROOT ?? actual.tmpdir();
  const home = mkdtempSync(join(root, 'home-'));
  process.env.HOME = home;
  const homedir = () => home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

const { tmpdir } = await import('node:os');
const stateDir = mkdtempSync(join(process.env.ROUTER_TEST_HOME_ROOT ?? tmpdir(), 'state-'));
mkdirSync(join(stateDir, '.cache'));
process.env.PI_ROUTER_STATE_DIR = stateDir;
