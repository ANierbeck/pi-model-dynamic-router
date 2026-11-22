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
 * site: the pre-migration session restore in src/event-handlers.ts
 * (review round 2026-11-21; plan
 * docs/plans/2026-11-21-continue-restores-group.md). Anything else — most
 * of all a per-prompt switch — must fail here.
 *
 * Migration plan step 2 (docs/plans/2026-11-21-virtual-models-migration.md)
 * removed the OTHER site: `set_model_from_group` (src/tools.ts) now pins the
 * group on the session branch instead of switching. The restore's site
 * stays: Pi resolves a resumed session's model from the branch selection
 * BEFORE extensions load (sdk.js getBranchSelection), so an old branch that
 * fell back to the physical model can only be moved to router/dynamic
 * through pi.setModel — the only live-switch API — at session_start (spike
 * condition F7). Pi's own _recordModelSelection then appends the virtual
 * model_change to the branch, and every later resume hands over to Pi's
 * virtual-model branch selection with no router call at all.
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

  // Migration plan step 2 (T4/T5): the tool's call site is gone (it pins
  // now); exactly the F7 old-session restore remains.
  it('keeps exactly ONE call site under the virtual-models migration', () => {
    let total = 0;
    const perFile: string[] = [];
    for (const file of productionSources()) {
      const calls = setModelCallLines(file).length;
      total += calls;
      if (calls > 0) perFile.push(`${path.relative(repoRoot, file)}: ${calls}`);
    }
    expect(perFile, 'remaining setModel call sites').toEqual([
      `${path.join('src', 'event-handlers.ts')}: 1`,
    ]);
    expect(total).toBe(1);
  });

  it('only src/event-handlers.ts calls setModel()', () => {
    const offenders: string[] = [];
    let toolsCalls = 0;
    let restoreCalls = 0;
    for (const file of productionSources()) {
      const calls = setModelCallLines(file);
      const rel = path.relative(repoRoot, file);
      if (rel === path.join('src', 'tools.ts')) {
        toolsCalls = calls.length;
        continue;
      }
      if (rel === path.join('src', 'event-handlers.ts')) {
        restoreCalls = calls.length;
        continue;
      }
      for (const line of calls) offenders.push(`${rel}: ${line.trim()}`);
    }
    expect(offenders).toEqual([]);
    // The migration removed the tool's call site (pin instead of switch) and
    // kept the restore's — both pins must hold, otherwise the regex has
    // silently stopped matching and this test proves nothing.
    expect(toolsCalls).toBe(0);
    expect(restoreCalls).toBe(1);
  });
});
