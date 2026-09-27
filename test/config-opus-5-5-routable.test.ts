// test/config-opus-5-5-routable.test.ts
// Guards the re-enablement of claude-bridge/claude-opus-5-5 (2026-09-27).
//
// The owner had *opus* excluded via the USER-layer router-config.user.json
// pattern list since the expensive-opus era. With Opus 5.5 released, the
// owner re-enabled routing for exactly this model (older opus generations
// 4-5..4-8 and claude-opus-5 stay excluded; all fable models stay
// excluded). Enabling requires BOTH:
//
//   1. The user-layer exclusion no longer matches opus-5-5 — that change
//      lives in ~/.pi/agent/router-config.user.json, outside this repo, so
//      it cannot be guarded here. If it ever regresses, the symptom is a
//      missing candidate in every group — check the router log line
//      "Exclude rules removed N model(s)".
//   2. THIS repo's config gives the model a known cost and a GDPval score.
//      Pi's model registry does not price claude-bridge/claude-opus-5-5
//      (scan log 2026-09-27: "9 model(s) with unknown cost"), and routing
//      ALWAYS excludes unknown-cost models from max_cost_per_m groups
//      (src/routing.ts — neither a pay-per-token nor a sunk-cost path can
//      rank them). Without a model_metrics entry the model would silently
//      vanish from every cost-capped group even though no exclusion
//      pattern matches it. That silent-disappearance failure mode is what
//      this test guards.
//
// Cost basis: cost_per_m 0.0000015 ($1.50/M) — the same subscription
// sunk-cost assumption as every other claude-bridge peer (sonnet-5,
// opus-5, fable-5). GDPval 1900: above opus-5 (1860) and sonnet-5 (1603),
// per the owner's decision 2026-09-27 — Opus 5.5 as the strategic-tier
// alternative to Sonnet 5.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isExcluded, type ExcludeContext } from '../src/exclude.js';
import type { Config, Cache } from '../src/types.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoCfg = JSON.parse(
  readFileSync(join(repoRoot, 'router-config.json'), 'utf-8')
) as Config;

const OPUS_5_5 = 'claude-bridge/claude-opus-5-5';

describe('router-config.json keeps claude-opus-5-5 routable (re-enabled 2026-09-27)', () => {
  it('has a known cost for opus-5-5 (no silent unknown-cost exclusion)', () => {
    const metric = repoCfg.model_metrics?.[OPUS_5_5];
    expect(metric, `model_metrics["${OPUS_5_5}"] missing — opus-5-5 would silently vanish from every cost-capped group`).toBeTruthy();
    expect(metric?.cost_per_m).toBeGreaterThan(0);
  });

  it('has a GDPval score ranking it above sonnet-5 (the owner’s intent)', () => {
    const g = repoCfg.gdpval_builtin?.['claude-opus-5-5'];
    const sonnet = repoCfg.gdpval_builtin?.['claude-sonnet-5'];
    expect(g, 'gdpval_builtin["claude-opus-5-5"] missing — opus-5-5 cannot be ranked').toBeTruthy();
    expect(sonnet).toBeTruthy();
    expect(g!, 'opus-5-5 should rank above sonnet-5 (1603) as the strategic alternative').toBeGreaterThan(sonnet!);
  });

  it('is not excluded by the repo-layer exclude rules', () => {
    const ctx: ExcludeContext = { rules: repoCfg.exclude!, cfg: repoCfg, cache: { available_models: [] } };
    expect(isExcluded(OPUS_5_5, ctx), 'repo exclude rules must never match opus-5-5').toBe(false);
  });
});
