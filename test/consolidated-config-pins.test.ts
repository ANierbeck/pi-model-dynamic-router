// test/consolidated-config-pins.test.ts
// Consolidation of one-file-per-incident micro tests (suite hygiene round
// 2026-10-04): each former standalone file lives on as its own describe,
// named after the original file - failure output stays greppable. The
// tests themselves are UNCHANGED; hooks and fixtures moved verbatim.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { isExcluded, type ExcludeContext } from '../src/exclude.js';
import type { Config, Cache } from '../src/types.js';
import { vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { piAgentDir } from '../src/config-loader.ts';
import * as metricsModule from '../src/metrics.ts';

describe('config-cloud-first-groups', () => {
  // test/config-cloud-first-groups.test.ts
  // Guards the 2026-09-27 cloud-first routing change: five model groups must
  // rank cloud models ahead of the local Ollama daemon, which had repeatedly
  // pinned the GPU at 100% when hit as a default path (MLX wedge incidents).
  // A silent revert to strict_local/local_first would reintroduce that load.


  const cfg = JSON.parse(readFileSync(join(__dirname, '../router-config.json'), 'utf-8'));

  describe('router-config.json — cloud-first group billing_preference', () => {
    it.each(['scout', 'bulk_reader', 'code_writer'])(
      '%s uses cloud_first (local always last)',
      (group) => {
        expect(cfg.model_groups[group]?.billing_preference).toBe('cloud_first');
      }
    );

    it.each(['trivial', 'simple'])(
      '%s uses local_before_payg (local ahead of payg only)',
      (group) => {
        expect(cfg.model_groups[group]?.billing_preference).toBe('local_before_payg');
      }
    );

    it('no group still uses the old local-biased modes', () => {
      const offenders = Object.entries(cfg.model_groups)
        .filter(([, g]: [string, any]) => g.billing_preference === 'strict_local' || g.billing_preference === 'local_first')
        .map(([name]) => name);
      expect(offenders).toEqual([]);
    });
  });
});


describe('config-dynamic-no-fallback-groups', () => {
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
});


describe('config-opus-5-5-routable', () => {
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
  //   2. The model gets a known cost and a GDPval score. Pi's model registry
  //      does not price claude-bridge models (zeros), and routing ALWAYS
  //      excludes unknown-cost models from max_cost_per_m groups, so an
  //      unpriced model would silently vanish from every cost-capped group.
  //      Since ADR-0025 B2 the cost comes from the subscription cost rule in
  //      src/metrics.ts (epsilon x OpenRouter list price, constant fallback)
  //      instead of a per-model model_metrics sentinel; the provider's
  //      `billing: subscription` is declared in the user layer.
  //
  // GDPval 1900: above opus-5 (1860) and sonnet-5 (1603), per the owner's
  // decision 2026-09-27 — Opus 5.5 as the strategic-tier alternative to
  // Sonnet 5.


  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const repoCfg = JSON.parse(
    readFileSync(join(repoRoot, 'router-config.json'), 'utf-8')
  ) as Config;

  const OPUS_5_5 = 'claude-bridge/claude-opus-5-5';

  describe('router-config.json keeps claude-opus-5-5 routable (re-enabled 2026-09-27)', () => {
    // ADR-0025 B2: the per-model sentinel is gone; the subscription cost rule
    // (src/metrics.ts) gives every subscription model a known cost. A user
    // declares the provider billing in router-config.user.json; the rule does
    // the rest, so the model never silently vanishes from cost-capped groups.
    it('has a known cost for opus-5-5 via the subscription rule (no silent unknown-cost exclusion)', () => {
      expect(repoCfg.model_metrics?.[OPUS_5_5]).toBeUndefined();
      const cfg = { ...repoCfg, providers: { 'claude-bridge': { billing: 'subscription' } } } as Config;
      metricsModule.setConfig(cfg);
      metricsModule.setCache({ available_models: [] } as any);
      metricsModule.setModelRegistry({ find: () => undefined } as any);
      const cost = metricsModule.effCost(OPUS_5_5);
      expect(typeof cost, 'opus-5-5 would silently vanish from every cost-capped group').toBe('number');
      expect(cost as number).toBeGreaterThan(0);
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
});


describe('config-release-log-level', () => {
  // Release gate (owner rule 2026-10-02): every release build ships with the
  // extension's log level at "warn" or "error" — quiet logs for end users,
  // failures still visible. The shipped router-config.json's `log_level` is
  // the effective default for anyone installing the package, so it must be
  // one of the two quiet levels. AGENTS.md §1 references this test as part of
  // the release checklist.


  const configPath = resolvePath(__dirname, '..', 'router-config.json');

  describe('release gate — shipped log level is quiet', () => {
    it('router-config.json sets log_level to warn or error', () => {
      const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(['warn', 'error']).toContain(cfg.log_level);
    });
  });
});


describe('pi-agent-dir-auth', () => {
  // test/pi-agent-dir-auth.test.ts
  // PI_CODING_AGENT_DIR-aware agent dir resolution (piAgentDir) is still
  // required for router-config.user.json loading in container/profile setups
  // (the pi-work container, where ~/.pi is not even mounted).
  //
  // The auth.json part of this file was removed with ADR-0022: the router no
  // longer reads Pi's auth.json at all — pi resolves credentials itself via
  // modelRegistry.getApiKeyForProvider.


  describe('PI_CODING_AGENT_DIR-aware agent dir', () => {
    it('piAgentDir defaults to ~/.pi/agent', () => {
      vi.stubEnv('PI_CODING_AGENT_DIR', '');
      expect(piAgentDir()).toBe(path.join(os.homedir(), '.pi', 'agent'));
    });

    // Pi's own getAgentDir() expands a leading ~ in PI_CODING_AGENT_DIR. A value
    // set without shell expansion (.env file, programmatic setter) would
    // otherwise yield a literal "~/..." path that node:fs cannot open, silently
    // dropping router-config.user.json.
    it('piAgentDir expands a leading ~ like Pi does', () => {
      vi.stubEnv('PI_CODING_AGENT_DIR', '~');
      expect(piAgentDir()).toBe(os.homedir());
      vi.stubEnv('PI_CODING_AGENT_DIR', '~/work/agent');
      expect(piAgentDir()).toBe(path.join(os.homedir(), 'work', 'agent'));
    });
  });
});
