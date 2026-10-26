// Regression guard for the dependency-security fixes (AGENTS.md section 10):
// Dependabot #42-#45 (fast-uri < 3.1.9, URI confusions under ajv/stryker) and
// #48 (undici < 8.12.2, DoS via excessive content-encodings — host-pinned, so
// an `overrides` entry in package.json is what holds the patched version in
// place). A later lock refresh or a removed override can silently resolve the
// vulnerable versions again; this test makes that a red suite, not a silent
// regression (review round on PR #78).
//
// Red evidence: run against the origin/main lockfile (fast-uri 3.1.8,
// undici 8.10.2) this test fails both assertions.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const lock = JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8')) as {
  packages: Record<string, { version?: string }>;
};

/** Every version the lockfile resolves for a package (including nested ones). */
function resolvedVersions(name: string): string[] {
  const out = new Set<string>();
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`)) {
      if (entry.version) out.add(entry.version);
    }
  }
  return [...out];
}

const cmp = (a: string, b: string): number => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
};

describe('dependency lock security (Dependabot #42-#45, #48)', () => {
  it('resolves only patched fast-uri (>= 3.1.9)', () => {
    const versions = resolvedVersions('fast-uri');
    expect(versions.length, 'fast-uri must appear in the lockfile').toBeGreaterThan(0);
    for (const v of versions) {
      expect(cmp(v, '3.1.9'), `fast-uri ${v} is below the patched 3.1.9`).toBeGreaterThanOrEqual(0);
    }
  });

  it('resolves only patched undici (>= 8.12.2) — the override must not be dropped', () => {
    const versions = resolvedVersions('undici');
    expect(versions.length, 'undici must appear in the lockfile').toBeGreaterThan(0);
    for (const v of versions) {
      expect(cmp(v, '8.12.2'), `undici ${v} is below the patched 8.12.2 (overrides entry removed?)`).toBeGreaterThanOrEqual(0);
    }
  });

  it("package.json still carries the undici override (host pins 8.10.2 — without the override every npm install re-vulnerabilizes)", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      overrides?: Record<string, string>;
    };
    expect(pkg.overrides?.undici, 'overrides.undici must stay until the host bumps upstream').toBe('8.12.2');
  });
});
