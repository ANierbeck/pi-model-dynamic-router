// Contract test for the nightly mutation-testing setup (owner decision
// 2026-10-04: "nightly mutation testing einbauen"). Written RED-FIRST
// against a repository with no Stryker config and no nightly workflow.
//
// The contract pinned here:
// 1. Stryker mutates the DECISION CORE (metrics + routing) plus, per Phase 2
//    (2026-10-08, owner go), ONE module at a time —
//    src/stream-orchestrator.ts is the first extension. The rest of src/ stays
//    out until Phase 1's yield justifies further extension.
// 2. The nightly workflow runs on a schedule + manual dispatch, and NEVER
//    on pull_request/push — mutation results must never gate PRs (they
//    are report-only; findings flow through triage, not red checks).
// 3. The run is report-only: no break threshold that could fail a green
//    main before a baseline score has even been measured.
// 4. The Stryker sandbox/output dirs stay out of the repo and the package.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, file), 'utf8'));
}

describe('nightly mutation testing', () => {
  it('mutations are limited to the decision core + the single Phase 2 module', () => {
    const cfg = readJson('stryker.config.json');
    expect(cfg.testRunner).toBe('vitest');
    // Phase 1 decision core, Phase 2 scope extension (2026-10-08, owner go):
    // one module at a time, no suite-wide mutation.
    expect([...cfg.mutate].sort()).toEqual([
      'src/metrics.ts',
      'src/routing.ts',
      'src/stream-orchestrator.ts',
    ]);

    // Every mutate target must actually exist — a stale glob would make the
    // nightly run vacuously green (0 mutants "killed").
    for (const target of cfg.mutate) {
      expect(fs.existsSync(path.join(repoRoot, target))).toBe(true);
    }
  });

  it('uses only real Stryker options (no silently-ignored keys)', () => {
    // A bare "comment" key is an unknown option: Stryker only warns, so a
    // typo'd option would be silently ignored the same way. Free-text notes
    // must use the underscore-prefixed form Stryker documents.
    const cfg = readJson('stryker.config.json');
    expect(Object.keys(cfg)).not.toContain('comment');
  });

  it('the workflow caches exactly the incremental file Stryker writes', () => {
    // Incremental mode only pays off across nights if the cached path IS
    // the file Stryker reads/writes; a mismatch silently re-runs all
    // ~1670 mutants every night (first draft cached .stryker-tmp/...).
    const cfg = readJson('stryker.config.json');
    expect(cfg.incremental).toBe(true);
    expect(typeof cfg.incrementalFile).toBe('string');
    const wf = fs.readFileSync(path.join(repoRoot, '.github/workflows/mutation-nightly.yml'), 'utf8');
    const cacheStep = wf.slice(wf.indexOf('actions/cache'));
    expect(cacheStep).toContain(`path: ${cfg.incrementalFile}`);
    // The cache must be re-saved every night: a fixed key is immutable in
    // actions/cache, so results would freeze at the first night's state.
    expect(cacheStep).toMatch(/key: .*github\.run_id/);
    expect(cacheStep).toMatch(/restore-keys:/);
    // The incremental file must stay out of git.
    const gitignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
    expect(gitignore).toMatch(/^reports\/$/m);
  });

  it('the job budget covers a full cold run (~75 min locally, ~100 min both modules)', () => {
    const wf = fs.readFileSync(path.join(repoRoot, '.github/workflows/mutation-nightly.yml'), 'utf8');
    const m = wf.match(/timeout-minutes:\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(240);
  });

  it('is report-only: no break threshold fails the nightly run', () => {
    const cfg = readJson('stryker.config.json');
    expect(cfg.thresholds?.break ?? 0).toBe(0);
  });

  it('nightly workflow triggers on schedule and dispatch, never on PRs', () => {
    const wf = fs.readFileSync(path.join(repoRoot, '.github/workflows/mutation-nightly.yml'), 'utf8');
    expect(wf).toMatch(/schedule:/);
    expect(wf).toMatch(/workflow_dispatch:/);
    expect(wf).not.toMatch(/pull_request:/);
    expect(wf).not.toMatch(/^(\s*)push:/m);
    // The report must be uploaded as an artifact so triage does not
    // depend on scrolling the CI log.
    expect(wf).toMatch(/upload-artifact/);
  });

  it('keeps the report artifact for the maximum retention window (triage happens days later)', () => {
    const wf = fs.readFileSync(path.join(repoRoot, '.github/workflows/mutation-nightly.yml'), 'utf8');
    const m = wf.match(/retention-days:\s*(\d+)/);
    expect(m, 'upload step must set retention-days explicitly').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(90);
  });

  it('stryker sandbox and report dirs are ignored, not committed or shipped', () => {
    const gitignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
    expect(gitignore).toMatch(/\.stryker-tmp/);
    const pkg = readJson('package.json');
    const shipped: string[] = pkg.files ?? [];
    expect(shipped.some((f: string) => f.includes('.stryker') || f.startsWith('reports'))).toBe(false);
  });
});
