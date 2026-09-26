// globalSetup: one temp root for all per-file test homes (see isolate-home.ts).
// Removed wholesale on teardown — per-file cleanup cannot be relied on, because
// vitest skips afterAll in fully skipped files and workers may exit without
// emitting 'exit'.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export default function setup(): () => void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'router-test-homes-'));
  process.env.ROUTER_TEST_HOME_ROOT = root;
  return () => fs.rmSync(root, { recursive: true, force: true });
}
