// Regression guard for the dependency-security fixes (AGENTS.md section 10):
// Dependabot #42-#45 (fast-uri < 3.1.9, URI confusions under ajv/stryker) and
// #48 (undici < 8.12.2, DoS via excessive content-encodings — the host pinned
// the vulnerable 8.10.2 until 1.5.0, then its own patched 8.12.3). A later lock
// refresh can silently resolve the vulnerable versions again. The old
// `overrides` entry is gone (AGENTS.md section 10: overrides are the last resort).
// This test makes a regression a red suite, not a silent one. It
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

  it('resolves only patched undici (>= 8.12.2)', () => {
    const versions = resolvedVersions('undici');
    expect(versions.length, 'undici must appear in the lockfile').toBeGreaterThan(0);
    for (const v of versions) {
      expect(cmp(v, '8.12.2'), `undici ${v} is below the patched 8.12.2 (host pin regressed or an override forces it?)`).toBeGreaterThanOrEqual(0);
    }
  });

  it('the top-level undici is the host\'s own pin, so no override is needed (the host pins a patched version since 1.5.0)', () => {
    const host = lock.packages['node_modules/@earendil-works/pi-coding-agent'];
    const pinned = host?.dependencies?.undici;
    expect(pinned, 'the pi host must declare undici in the lockfile').toBeDefined();
    expect(cmp(pinned!, '8.12.2'), `the host pins undici ${pinned}, below the patched 8.12.2`).toBeGreaterThanOrEqual(0);
    expect(lock.packages['node_modules/undici']?.version, 'top-level undici must equal the host pin').toBe(pinned);
  });
});
