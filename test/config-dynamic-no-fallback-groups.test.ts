// The dynamic group's `fallback_groups` config entry is dead config that
// only PRETENDS to have routing semantics (owner finding 2026-10-02):
// - resolve('dynamic') short-circuits to null — the dynamic group is
//   resolved per-prompt by the classifier hook, never via the group cascade,
//   so its own fallback_groups are never consulted.
// - The orchestrator reads the TARGET group's fallback_groups (auto-generated
//   for every non-dynamic group), never the dynamic group's.
// - dynamic-config's auto-generation explicitly never assigns fallback_groups
//   to the dynamic group (pinned in dynamic-config.test.ts) — a manual entry
//   in router-config.json contradicts the code's own design intent.
// The only observable effect was the "(→ strategic → tactical → …)" suffix in
// /router status, which implied a fallback cascade that does not exist.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

const configPath = resolvePath(__dirname, '..', 'router-config.json');

describe('router-config.json — dynamic group honesty', () => {
  const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
  const dyn = cfg.model_groups?.dynamic;

  it('defines a dynamic group', () => {
    expect(dyn).toBeTruthy();
    expect(dyn.method).toBe('dynamic');
  });

  it('has no fallback_groups on the dynamic group (dead config, misleading status)', () => {
    expect(dyn.fallback_groups).toBeUndefined();
  });

  it('does not claim Ollama-only classification in its description (cloud-first since 2026-09-27)', () => {
    expect(dyn.description).toBeTruthy();
    expect(dyn.description.toLowerCase()).not.toContain('via ollama');
  });
});
