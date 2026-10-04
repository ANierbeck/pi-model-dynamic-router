/**
 * Static guard for the "router never calls pi.setModel()" invariant.
 *
 * The sticky-model regression pin (consolidated-routing-cache-pins.test.ts,
 * describe 'sticky-model-regression' after the 2026-10-04 suite hygiene
 * round) proves the invariant at runtime, but only for the paths it drives
 * (groupStream/driveStream). Any OTHER module that
 * calls pi.setModel() slips past it — e.g. the legacy
 * setupContentBasedRouting() hook in content-classifier.ts, which switched
 * the session model on every prompt and was only caught by a code review
 * (index.ts refactor, review B, 2026-10-02).
 *
 * This test scans every production source file and allows exactly ONE call
 * site: the user-invoked `set_model_from_group` tool in src/tools.ts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function productionSources(): string[] {
  const srcDir = path.join(repoRoot, 'src');
  const files = fs
    .readdirSync(srcDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(srcDir, f));
  return [path.join(repoRoot, 'index.ts'), ...files];
}

// Matches a call, not a mention in a comment: `.setModel(` preceded by an
// identifier (pi, rt.pi, ...) and not inside a `//` or ` * ` comment line.
function setModelCallLines(file: string): string[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => /\w\.setModel\(/.test(line))
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
}

describe('router never calls pi.setModel() (static guard)', () => {
  it('scans a non-trivial set of production files', () => {
    // Guards against a vacuous pass if the glob ever stops matching.
    expect(productionSources().length).toBeGreaterThan(20);
  });

  it('only src/tools.ts (set_model_from_group) calls setModel()', () => {
    const offenders: string[] = [];
    let toolsCalls = 0;
    for (const file of productionSources()) {
      const calls = setModelCallLines(file);
      const rel = path.relative(repoRoot, file);
      if (rel === path.join('src', 'tools.ts')) {
        toolsCalls = calls.length;
        continue;
      }
      for (const line of calls) offenders.push(`${rel}: ${line.trim()}`);
    }
    expect(offenders).toEqual([]);
    // The one legitimate call site must still exist — otherwise the regex
    // has silently stopped matching and this test proves nothing.
    expect(toolsCalls).toBe(1);
  });
});
