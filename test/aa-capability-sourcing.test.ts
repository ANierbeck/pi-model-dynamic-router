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
    expect(metricsModule.lookupCapability('mistral/zai-glm-5-3', 'coding') === 2130).toBe(true);
    const other = { available_models: [], capability_profiles: { 'zai-glm-5-3': { briefcase: 1 } } } as any;
    metricsModule.setCache(other);
    expect(metricsModule.lookupCapability('mistral/zai-glm-5-3', 'coding')).toBeNull();
  });

  it('unknown ref/profile returns null', () => {
    expect(metricsModule.lookupCapability('mistral/never-heard-of', 'briefcase')).toBeNull();
  });
});
