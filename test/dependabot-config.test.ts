// Pins the Dependabot policy (.github/dependabot.yml).
//
// First Dependabot run (2026-10-04) opened four update PRs at once, two of
// them duplicate two-major vitest jumps and one a MAJOR bump of the host
// (@earendil-works/pi-coding-agent 0.83 -> 1.0.2). The green CI on that
// host bump proved nothing — the suite mocks most of pi. This test pins the
// noise-prevention rules so they cannot silently disappear:
//
// 1. The host dependency is NEVER auto-bumped — host upgrades are
//    deliberate, planned rounds (docs/plans/2026-09-30-...hardening.md).
// 2. vitest majors are NO LONGER muted: the vitest-5 migration round
//    (2026-11-08) landed vitest 5.1.0 with the pinned coverage thresholds
//    unchanged and green (85.19 % branches vs the pinned 76 % floor —
//    the 74.27 % red-run prediction was measured 2026-10-04 on a much
//    smaller suite). Future vitest majors update through normal grouped
//    Dependabot PRs like everything else.
// 3. Minor/patch updates are grouped (review noise stays low) and run
//    weekly — dependency PRs must not flood the PR queue again.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = parse(readFileSync(path.join(repoRoot, '.github/dependabot.yml'), 'utf8'));

const npm = config.updates.find((u: any) => u['package-ecosystem'] === 'npm');
const actions = config.updates.find((u: any) => u['package-ecosystem'] === 'github-actions');

describe('dependabot config policy', () => {
  it('the npm ecosystem is configured weekly with grouped minor/patch updates', () => {
    expect(npm.schedule).toEqual({ interval: 'weekly', day: 'monday' });
    expect(npm.groups['minor-and-patch']['update-types']).toEqual(['minor', 'patch']);
  });

  // Release review 2026-11-13 (scripts/tests): the open-PR cap was not pinned.
  // Mutation-checked: a cap of 6 turns this red.
  it('both ecosystems cap open update PRs at 5', () => {
    expect(npm['open-pull-requests-limit']).toBe(5);
    expect(actions['open-pull-requests-limit']).toBe(5);
  });

  it('the host dependency is never auto-bumped', () => {
    // Host upgrades are deliberate, planned rounds (see the 0.99.1
    // hardening plan); a Dependabot "chore(deps)" PR must never decide
    // which pi version the router runs inside.
    const ignored = npm.ignore ?? [];
    expect(ignored).toContainEqual({ 'dependency-name': '@earendil-works/pi-coding-agent' });
  });

  it('vitest majors are no longer muted (the vitest-5 round landed 2026-11-08)', () => {
    const ignored = npm.ignore ?? [];
    // The migration is done: vitest 5.1.0 runs the suite green with the
    // pinned coverage thresholds unchanged. A re-added major-ignore would
    // silently freeze vitest again — the exact drift the 2026-10-04 mute
    // was meant to prevent, now in reverse.
    expect(
      ignored.find(
        (e: any) =>
          (e['dependency-name'] === 'vitest' ||
            String(e['dependency-name']).startsWith('@vitest/')) &&
          Array.isArray(e['update-types']) &&
          e['update-types'].includes('version-update:semver-major')
      )
    ).toBeUndefined();
  });

  it('github-actions updates are configured weekly', () => {
    expect(actions.schedule).toEqual({ interval: 'weekly', day: 'monday' });
  });
});
