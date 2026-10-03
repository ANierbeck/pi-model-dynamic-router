// Release gate (owner rule 2026-10-02): every release build ships with the
// extension's log level at "warn" or "error" — quiet logs for end users,
// failures still visible. The shipped router-config.json's `log_level` is
// the effective default for anyone installing the package, so it must be
// one of the two quiet levels. AGENTS.md §1 references this test as part of
// the release checklist.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

const configPath = resolvePath(__dirname, '..', 'router-config.json');

describe('release gate — shipped log level is quiet', () => {
  it('router-config.json sets log_level to warn or error', () => {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(['warn', 'error']).toContain(cfg.log_level);
  });
});
