// test/aa-capability-sourcing.test.ts
// Guards the AA multi-benchmark capability sourcing (ADR-0023 round 2,
// docs/plans/2026-10-04-aa-multi-benchmark-sourcing.md).
//
// Empirical basis (2026-10-04): the GDPval leaderboard page the router
// ALREADY scrapes embeds per-model entries with every benchmark column —
// briefcaseElo (Elo scale, with breakdown), scicode and terminalBench40
// (0–1 percentages), plus automationBench/gdpPdf/omniscience. Production
// parses ONE field (gdpval) and discards the rest. This round extracts a
// per-slug capability profile from the SAME payload:
//   briefcase = AA-Briefcase Elo (agentic knowledge work — the planning score)
//   coding    = 3000 * max(scicode, terminalBench40) (monotonic blend —
//               only intra-group ORDER matters; floors never see it)
//
// The parser is EXPORTED from src/scan-runner.ts (unlike the legacy
// extractGdpvalScores, which is mirrored in test/aa-gdpval-scrape.test.ts
// and can drift) — these tests import the real implementation.
//
// Fixture shapes below are cut from the real 2026-10-04 payload
// (/tmp/aa-gdpval.html): escaped-JSON RSC entries; production normalizes
// \\" before parsing and the fixtures apply the identical normalization.

import { describe, it, expect, beforeEach } from 'vitest';
import { extractCapabilityProfiles } from '../src/scan-runner.js';
import { Router as RoutingRouter } from '../src/routing.js';
import * as metricsModule from '../src/metrics.js';
import type { Cache } from '../src/types.js';

// Real payload shape, two entries: one with every field, one with a
// MISSING briefcaseElo (its coding score must still be captured — the
// plan's chunk-parsing requirement; a greedy cross-entry regex would
// either lose it or mix fields across entries).
const RAW_FIXTURE = String.raw`
{\"slug\":\"claude-opus-5-5\",\"name\":\"Claude Opus 5.5 (Max, Default Fallback)\"}
{\"slug\":\"glm-5-3\",\"name\":\"GLM-5.3\"}
{\"slug\":\"medium-no-briefcase\",\"name\":\"Medium No Briefcase\"}
{"id":"x","displayName":"Claude Opus 5.5 (Max, Default Fallback)","creator":{"name":"Anthropic"},"gdpvalBreakdown":{"elo":1900},"automationBench":{"calendly":{"completion":0.96}},"enterpriseOpsGym":null,"enterpriseOpsGymAvgConversationTurns":null,"briefcaseElo":1810.2,"briefcaseBreakdown":{"elo":1810.2,"lower95ci":1795.14,"upper95ci":1819.97,"analyticalQuality":40},"opennessIndex":null,"scicode":0.66,"tau2":null,"tauBanking":null,"terminalbenchHard":null,"terminalBench21":null,"terminalBench40":0.596,"confidenceInterval":1}
{"id":"y","displayName":"GLM-5.3","creator":{"name":"Z AI"},"gdpvalBreakdown":{"elo":1643.62},"briefcaseElo":1700.5,"scicode":0.71,"terminalBench40":0.62,"confidenceInterval":1}
{"id":"z","displayName":"Medium No Briefcase","creator":{"name":"Mistral"},"gdpvalBreakdown":{"elo":933},"scicode":0.55,"terminalBench40":0.5,"confidenceInterval":1}
`;

// Production applies this normalization in scan() before parsing.
const FIXTURE_HTML = RAW_FIXTURE.replace(/\\"/g, '"');

// ── Task 2: parser ────────────────────────────────────────────────────────

describe('extractCapabilityProfiles (AA payload parsing)', () => {
  const profiles = extractCapabilityProfiles(FIXTURE_HTML);

  it('extracts briefcaseElo (Elo scale) per slug', () => {
    expect(profiles['claude-opus-5-5']?.briefcase).toBe(1810.2);
    expect(profiles['glm-5-3']?.briefcase).toBe(1700.5);
  });

  it('blends coding = 3000 * max(scicode, terminalBench40)', () => {
    // opus: max(0.66, 0.596) = 0.66 → 1980; glm: max(0.71, 0.62) = 0.71 → 2130
    expect(profiles['claude-opus-5-5']?.coding).toBe(1980);
    expect(profiles['glm-5-3']?.coding).toBe(2130);
  });

  it('an entry WITHOUT briefcaseElo still gets its coding column (no cross-entry field mixing)', () => {
    // A greedy regex over the whole payload could pair entry z's scicode
    // with entry y's briefcaseElo — the chunk-parse must not.
    expect(profiles['medium-no-briefcase']).toBeDefined();
    expect(profiles['medium-no-briefcase']?.briefcase).toBeUndefined();
    expect(profiles['medium-no-briefcase']?.coding).toBe(1650); // 3000 * 0.55
  });

  it('resolves slugs via the displayName→slug table (parenthetical suffix stripped)', () => {
    // displayName "Claude Opus 5.5 (Max, Default Fallback)" → slug claude-opus-5-5
    expect(profiles['claude-opus-5-5']).toBeDefined();
  });

  it('entries with no capability fields produce no profile', () => {
    expect(profiles['unknown-bare-model']).toBeUndefined();
  });

  it('empty/failed payload yields an empty object (fail-closed, never partial garbage)', () => {
    expect(extractCapabilityProfiles('<html>redesign</html>')).toEqual({});
  });
});

// ── Task 3: persist + lookup ──────────────────────────────────────────────

// ── 2026-10-13 payload shape (live regression) ────────────────────────────
// The AA page moved the capability columns OUT of the displayName-keyed
// leaderboard entries into an `initialModels` array: each record carries its
// own slug ("identity for free", no displayName table) plus creator and the
// benchmark fields. The old entryRe (id/displayName/creator) matches NOTHING
// on the live page anymore — the scan logged 'No capability profiles
// extracted - AA payload shape may have drifted' and the cache ended up with
// 0 profiles, so score_by groups silently fell back to gdpval.
// Realistic fragment, field order and values from the live payload
// (https://artificialanalysis.ai/evaluations/gdpval-aa, captured 2026-10-13).
const NEW_SHAPE_FIXTURE = String.raw`
{"slug":"gdpval-aa","initialModels":[
{"id":"2f3c4dc9-a450-4303-8697-0237257cf08f","slug":"claude-opus-5-5","name":"Claude Opus 5.5 (Max, Default Fallback)","shortName":"Claude Opus 5.5 (max with fallback)","suffix":"Max, Default Fallback","release":{"slug":"claude-opus-5-5","name":"Claude Opus 5.5"},"chartDefaultSelected":true,"mitigationStatus":"standard","releaseDate":"2026-09-22","deprecated":false,"isReasoning":true,"isOpenWeights":false,"sizeClass":"large","inputModalityImage":true,"creator":{"id":"f0aa413f-e8ae-4fcd-9c48-0e049f4f3128","slug":"anthropic","name":"Anthropic","color":"#cc785c","logo":"/img/logos/anthropic.svg"},"intelligenceIndex":57.62,"elo":1900.1,"gdpval":1900.1,"mmluPro":null,"enterpriseOpsGym":null,"enterpriseOpsGymAvgConversationTurns":null,"briefcaseElo":1807.05,"briefcaseBreakdown":{"elo":1807.05,"lower95ci":1796.5,"upper95ci":1819.61},"opennessIndex":null,"scicode":0.66898,"tau2":null,"tauBanking":null,"terminalbenchHard":null,"terminalBench21":null,"terminalBench40":0.5924,"confidenceInterval":1},
{"id":"b171d979-5ec1-45de-b8b9-db1ee65e77ec","slug":"qwen3-8-27b","name":"Qwen3.8 27B","shortName":"Qwen3.8 27B","release":{"slug":"qwen3-8-27b","name":"Qwen3.8 27B"},"chartDefaultSelected":false,"mitigationStatus":"standard","releaseDate":"2026-09-05","deprecated":false,"isReasoning":false,"isOpenWeights":true,"sizeClass":"small","inputModalityImage":false,"creator":{"id":"c31f6f6d-1c5d-4f2f-8e9c-3e4b3b6f1a11","slug":"qwen","name":"Qwen","color":"#6f42c1","logo":"/img/logos/qwen.svg"},"intelligenceIndex":34.1,"elo":1419.13,"gdpval":1419.13,"mmluPro":null,"enterpriseOpsGym":null,"enterpriseOpsGymAvgConversationTurns":null,"briefcaseElo":1397.08,"briefcaseBreakdown":{"elo":1397.08},"opennessIndex":0.7,"scicode":0.46644,"tau2":null,"tauBanking":null,"terminalbenchHard":null,"terminalBench21":null,"terminalBench40":null,"confidenceInterval":1},
{"id":"d4e5f6a7-b8c9-4d2f-8a9c-3e4b3b6f1a22","slug":"no-capability-model","name":"No Capability Model","shortName":"No Capability Model","release":{"slug":"no-capability-model","name":"No Capability Model"},"creator":{"id":"c31f6f6d-1c5d-4f2f-8e9c-3e4b3b6f1a11","slug":"qwen","name":"Qwen","color":"#6f42c1","logo":"/img/logos/qwen.svg"},"elo":800,"gdpval":800,"scicode":null,"terminalBench40":null}
]}
{"creators":[{"id":"f0aa413f-e8ae-4fcd-9c48-0e049f4f3128","slug":"anthropic","name":"Anthropic","color":"#cc785c","logo":"/img/logos/anthropic.svg"},{"id":"c31f6f6d-1c5d-4f2f-8e9c-3e4b3b6f1a11","slug":"qwen","name":"Qwen","color":"#6f42c1","logo":"/img/logos/qwen.svg"}]}
`.replace(/\\/g, '"');

describe('extractCapabilityProfiles (2026-10-13 initialModels shape)', () => {
  const profiles = extractCapabilityProfiles(NEW_SHAPE_FIXTURE);

  it('extracts briefcase and coding from records that carry their own slug', () => {
    expect(profiles['claude-opus-5-5']).toEqual({
      briefcase: 1807.05,
      coding: Math.round(3000 * 0.66898 * 100) / 100, // scicode 0.66898 > terminalBench40 0.5924
    });
    expect(profiles['qwen3-8-27b']).toEqual({
      briefcase: 1397.08,
      coding: Math.round(3000 * 0.46644 * 100) / 100, // terminalBench40 null → scicode alone
    });
  });

  it('provider objects (creators array) never produce profiles or swallow records', () => {
    expect(profiles['anthropic']).toBeUndefined();
    expect(profiles['qwen']).toBeUndefined();
    expect(profiles['no-capability-model']).toBeUndefined(); // no capability fields → no profile
  });

  it('the legacy displayName shape still parses (backward compatibility)', () => {
    // The old stage must keep working — some AA routes still embed it.
    const legacy = extractCapabilityProfiles(FIXTURE_HTML);
    expect(legacy['claude-opus-5-5']).toBeTruthy();
  });
});

// ── Sourcery PR #69 round: stage-2 robustness guards ───────────────────────
// Verified findings from the PR #69 review (2026-10-13), each red-first:
//   1. Stage 2 REPLACED the whole legacy profile for a shared slug, losing
//      valid legacy fields the Stage-2 record did not carry (per-field merge
//      instead — Stage 2 wins per field, legacy fields survive).
//   2. A model record whose first field after "name" is unknown (future AA
//      field) was not recognized as a record head, so its capability values
//      were absorbed into the PREVIOUS record's chunk — silent
//      misattribution of benchmark scores to the wrong slug. Unknown-field
//      records must BOUND chunks (missing data beats wrong data).
//   3. A measured coding score of exactly 0 was dropped by the `best > 0`
//      filter — a 0% benchmark result is data (rank last on the column), not
//      absence (gdpval proxy fallback).
describe('extractCapabilityProfiles (PR #69 round: merge/boundary/zero guards)', () => {
  it('merges Stage-2 fields per-field over the legacy profile instead of replacing it', () => {
    const html = [
      '{"slug":"merged-model","name":"Merged Model"}',
      // Legacy stage: briefcaseElo only, no coding columns.
      '{"id":"a","displayName":"Merged Model","creator":{"name":"X"},"briefcaseElo":1700.5,"confidenceInterval":1}',
      // Stage 2: coding columns only, no briefcaseElo.
      '{"id":"11111111-1111-1111-1111-111111111111","slug":"merged-model","name":"Merged Model","shortName":"MM","scicode":0.5}',
    ].join('\n');
    const profiles = extractCapabilityProfiles(html);
    expect(profiles['merged-model']).toEqual({ briefcase: 1700.5, coding: 1500 });
  });

  it('a record with an UNKNOWN field after "name" still bounds its chunk (no score misattribution)', () => {
    const html = [
      // rec-a carries NO capabilities. rec-b's head field is unknown to the
      // discriminator — before the fix, rec-a's chunk absorbed rec-b's
      // briefcaseElo and rec-a got a briefcase it does not have.
      '{"id":"11111111-1111-1111-1111-111111111111","slug":"rec-a","name":"A","shortName":"A","release":"2026"}',
      '{"id":"22222222-2222-2222-2222-222222222222","slug":"rec-b","name":"B","brandNewField":"x","briefcaseElo":1500}',
    ].join('\n');
    const profiles = extractCapabilityProfiles(html);
    expect(profiles['rec-a']).toBeUndefined();
    expect(profiles['rec-b']?.briefcase).toBe(1500);
  });

  it('a measured coding score of exactly 0 is recorded (0 is data, not absence)', () => {
    const html =
      '{"id":"33333333-3333-3333-3333-333333333333","slug":"zero-bench","name":"Z","shortName":"Z","scicode":0,"terminalBench40":0}';
    const profiles = extractCapabilityProfiles(html);
    expect(profiles['zero-bench']?.coding).toBe(0);
  });
});

describe('lookupCapability (metrics.ts)', () => {
  beforeEach(() => {
    metricsModule.setConfig({
      model_groups: {},
      model_metrics: {
        'mistral/zai-glm-5-3': { cost_per_m: 1.4, throughput_tps: 60, avg_latency_ms: 1200 },
      },
      providers: {},
      gdpval_builtin: { 'zai-glm-5-3': 1644 },
    } as any);
    const cache: Cache = {
      available_models: [],
      capability_profiles: {
        'zai-glm-5-3': { briefcase: 1700.5, coding: 2130 },
      },
    } as any;
    metricsModule.setCache(cache);
  });

  it('resolves a ref → slug → profile column', () => {
    expect(metricsModule.lookupCapability('mistral/zai-glm-5-3', 'briefcase')).toBe(1700.5);
    expect(metricsModule.lookupCapability('mistral/zai-glm-5-3', 'coding')).toBe(2130);
  });

  it('absent column returns null (NOT 0 — null is the gdpval-fallback signal)', () => {
    const other = { available_models: [], capability_profiles: { 'zai-glm-5-3': { briefcase: 1 } } } as any;
    metricsModule.setCache(other);
    expect(metricsModule.lookupCapability('mistral/zai-glm-5-3', 'coding')).toBeNull();
  });

  it('unknown ref/profile returns null', () => {
    expect(metricsModule.lookupCapability('mistral/never-heard-of', 'briefcase')).toBeNull();
  });
});

// ── Task 4: task-type-aware scoring (calculateScore + Group.score_by) ─────
//
// Fixtures mirror production shapes from the 2026-10-04 scan cache.
// The critical distinction to make PROVABLE: the column must be able to
// REVERSE an ordering that gdpval (+ window cost tiebreak) would produce
// the other way around — otherwise the column looks decorative.

const TASK4_CONFIG = {
  model_groups: {
    planning: { method: 'best', min_gdpval: 1700, score_by: 'briefcase', fallback_groups: [] },
    tactical: { method: 'best', min_gdpval: 600, score_by: 'coding', fallback_groups: [] },
    legacy: { method: 'best', min_gdpval: 600, fallback_groups: [] },
  },
  model_metrics: {
    // Sunk-cost subscription pricing: opus slightly CHEAPER in effCost than
    // sonnet here, so under gdpval-only ranking the window would pick opus —
    // the briefcase column must be what flips it to sonnet.
    'claude-bridge/claude-opus-5-5': { cost_per_m: 1.5e-6, throughput_tps: 100, avg_latency_ms: 1000 },
    'claude-bridge/claude-sonnet-5-5': { cost_per_m: 2.0e-6, throughput_tps: 100, avg_latency_ms: 1000 },
    'mistral/zai-glm-5-3': { cost_per_m: 1.4, throughput_tps: 60, avg_latency_ms: 1200 },
    'mistral/mistral-medium-3.5': { cost_per_m: 0.4, throughput_tps: 80, avg_latency_ms: 900 },
  },
  providers: {},
  gdpval_builtin: {
    'claude-opus-5-5': 1900,
    'claude-sonnet-5-5': 1844,
    'zai-glm-5-3': 1644,
    'mistral-medium-3.5': 933,
  },
  best_quality_window: 0.05,
} as any;

const TASK4_PROFILES = {
  // briefcase: sonnet clearly ahead AND opus outside the 5% window on the
  // column scale (1824 floor) — unambiguous column ordering.
  'claude-sonnet-5-5': { briefcase: 1920 },
  'claude-opus-5-5': { briefcase: 1810 },
  // coding: medium (0.4 $/M, cheap) ahead of glm — the column can beat the
  // expensive tank within the equivalence window.
  'zai-glm-5-3': { coding: 2130 },
  'mistral-medium-3.5': { coding: 2200 },
};

describe('task-type-aware scoring (score_by threading)', () => {
  let router: any;
  beforeAll(() => {
    metricsModule.setConfig(TASK4_CONFIG);
    metricsModule.setCache({ available_models: [], capability_profiles: TASK4_PROFILES } as any);
    metricsModule.setModelRegistry({ find: () => undefined } as any);
    router = new RoutingRouter(TASK4_CONFIG, { available_models: [], capability_profiles: TASK4_PROFILES } as any, new Map());
  });

  it('calculateScore uses the column when present', () => {
    expect(metricsModule.calculateScore('claude-bridge/claude-sonnet-5-5', 'briefcase')).toBe(1920);
    expect(metricsModule.calculateScore('mistral/mistral-medium-3.5', 'coding')).toBe(2200);
  });

  it('calculateScore falls back to gdpval when the column is absent for the model', () => {
    // glm-5-3 has NO briefcase in its profile → gdpval 1644
    expect(metricsModule.calculateScore('mistral/zai-glm-5-3', 'briefcase')).toBe(1644);
    // no column at all → gdpval (pre-round behavior)
    expect(metricsModule.calculateScore('claude-bridge/claude-opus-5-5')).toBe(1900);
    expect(metricsModule.calculateScore('claude-bridge/claude-opus-5-5', 'gdpval')).toBe(1900);
  });

  it("sortBy('best', 'briefcase') ranks by the column — reversing gdpval's pick", () => {
    // gdpval+window would pick opus (cheaper effCost within the 5% window);
    // the briefcase column (1920 vs 1810, outside the window) picks sonnet.
    const sorted = router.sortBy(['claude-bridge/claude-opus-5-5', 'claude-bridge/claude-sonnet-5-5'], 'best', 'briefcase');
    expect(sorted[0]).toBe('claude-bridge/claude-sonnet-5-5');
    expect(sorted[1]).toBe('claude-bridge/claude-opus-5-5');
  });

  it("sortBy('best', 'coding') lets the cheap model win within the column window", () => {
    const sorted = router.sortBy(['mistral/zai-glm-5-3', 'mistral/mistral-medium-3.5'], 'best', 'coding');
    expect(sorted[0]).toBe('mistral/mistral-medium-3.5');
  });

  it("score_by absent → pure gdpval ordering (regression pin, pre-round behavior)", () => {
    // legacy group: no score_by → sortBy without a column → opus first (gdpval max)
    const sorted = router.sortBy(['claude-bridge/claude-opus-5-5', 'claude-bridge/claude-sonnet-5-5'], 'best', 'gdpval');
    expect(sorted[0]).toBe('claude-bridge/claude-opus-5-5');
  });

  it('resolveGroup threads g.score_by end-to-end (planning → briefcase ordering)', () => {
    const cache = {
      available_models: [
        { provider: 'claude-bridge', id: 'claude-opus-5-5' },
        { provider: 'claude-bridge', id: 'claude-sonnet-5-5' },
        { provider: 'mistral', id: 'zai-glm-5-3' },
      ] as any,
      capability_profiles: TASK4_PROFILES,
    } as any;
    const r = new RoutingRouter(TASK4_CONFIG, cache, new Map());
    const res = r.resolve('planning');
    // Floor stays on GDPval: glm (1644 < 1700) is EXCLUDED even though its
    // briefcase would qualify — floors gate, columns only order.
    expect(res?.candidates).not.toContain('mistral/zai-glm-5-3');
    expect(res?.selected).toBe('claude-bridge/claude-sonnet-5-5');
  });

  it('floors remain GDPval-only: a model passing the column but failing the floor is still excluded', () => {
    const cache = {
      available_models: [
        { provider: 'mistral', id: 'zai-glm-5-3' },
      ] as any,
      capability_profiles: { 'zai-glm-5-3': { briefcase: 2100 } },
    } as any;
    const r = new RoutingRouter(TASK4_CONFIG, cache, new Map());
    // briefcase 2100 would rank anywhere — the gdpval floor 1700 excludes it.
    expect(r.resolve('planning')).toBeNull();
  });
});

// ── Config wiring (router-config.json ships the columns) ──────────────────

describe('shipped config wiring', () => {
  it('router-config.json: planning and design score by briefcase, code_complex by coding', () => {
    const cfg = JSON.parse(readFileSyncConfig());
    expect(cfg.model_groups.planning.score_by).toBe('briefcase');
    expect(cfg.model_groups.design.score_by).toBe('briefcase');
    expect(cfg.model_groups.code_complex.score_by).toBe('coding');
  });

  it('standard and simple keep gdpval (no score_by — column never leaks downward)', () => {
    const cfg = JSON.parse(readFileSyncConfig());
    expect(cfg.model_groups.standard.score_by ?? 'gdpval').toBe('gdpval');
    expect(cfg.model_groups.simple.score_by ?? 'gdpval').toBe('gdpval');
  });
});

function readFileSyncConfig(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs');
  return fs.readFileSync(new URL('../router-config.json', import.meta.url), 'utf8');
}
