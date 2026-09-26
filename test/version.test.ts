import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readRouterVersion } from '../src/version.ts';

describe('readRouterVersion', () => {
  it('returns a real version string, never "unknown"', () => {
    const v = readRouterVersion();
    expect(typeof v).toBe('string');
    expect(v.length).toBeGreaterThan(0);
    expect(v).not.toBe('unknown');
  });

  it('matches the version field in the repo package.json', () => {
    // Cross-check against the package.json read from the test's own
    // location (also the repo root). If the relative path in version.ts
    // ever drifts, readRouterVersion falls back to 'unknown' and this fails.
    const pkg = JSON.parse(
      fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8'),
    );
    expect(readRouterVersion()).toBe(pkg.version);
  });
});
