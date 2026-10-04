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
// 2. vitest majors are muted until the dedicated vitest-5 migration
//    round (AGENTS.md §4 forbids lowering the coverage threshold to
//    unblock the red run such a bump currently causes).
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

  it('the host dependency is never auto-bumped', () => {
    // Host upgrades are deliberate, planned rounds (see the 0.99.1
    // hardening plan); a Dependabot "chore(deps)" PR must never decide
    // which pi version the router runs inside.
    const ignored = npm.ignore ?? [];
    expect(ignored).toContainEqual({ 'dependency-name': '@earendil-works/pi-coding-agent' });
  });

  it('vitest majors are muted until the dedicated migration round', () => {
    const ignored = npm.ignore ?? [];
    expect(ignored).toContainEqual({
      'dependency-name': 'vitest',
      'update-types': ['version-update:semver-major'],
    });
    expect(ignored).toContainEqual({
      'dependency-name': '@vitest/*',
      'update-types': ['version-update:semver-major'],
    });
  });

  it('github-actions updates are configured weekly', () => {
    expect(actions.schedule).toEqual({ interval: 'weekly', day: 'monday' });
  });
});
