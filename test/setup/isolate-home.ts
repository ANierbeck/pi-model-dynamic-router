// Every test file gets a fresh, empty home directory. Without this, tests read
// the developer's real ~/.pi/agent/router-config.user.json (and auth.json) and
// write to the real ~/.pi/logs/router.log, so local results diverge from CI
// (ADR-0009). os.homedir() is mocked rather than only setting HOME, because
// the native lookup does not reliably observe process.env writes under
// vitest's worker pools. A test file's own vi.mock('node:os') still wins.
// Homes live under the root created by home-root.ts, which removes them all.

import { vi } from 'vitest';

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

await import('node:os');
