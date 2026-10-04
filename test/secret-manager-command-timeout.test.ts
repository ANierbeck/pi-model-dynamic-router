// test/secret-manager-command-timeout.test.ts
// The REAL timeout kill, without any mock: a key command that hangs (locked
// keychain, pinentry prompt) must be terminated at the timeout and resolve
// to null — never block the synchronous discovery/registration path (owner
// requirement 2026-10-04: "gesperrter Schlüsselbund darf nicht hängen").
// Separate file because the other secret-manager tests mock execSync.

import { it, expect } from 'vitest';
import { resolveKeyRef } from '../src/discovery.ts';

it('a long-running key command is killed at the timeout and resolves to null', { timeout: 9000 }, () => {
  const t = Date.now();
  const r = resolveKeyRef('!sleep 10', {});
  expect(r).toBeNull();
  // The kill happens at the module constant (5 s), well below the sleep.
  expect(Date.now() - t).toBeLessThan(8000);
});
