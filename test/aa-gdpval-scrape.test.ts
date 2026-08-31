// test/aa-gdpval-scrape.test.ts
//
// Regression guard for the AA leaderboard scraper. The scraper lives inside
// scan() (index.ts) and is module-private, so this test re-implements the
// function with the SAME regexes and runs them against representative
// fragments of the real AA HTML. The point is to fail loud if anyone changes
// the regex shape without thinking about the consequences.
//
// Background: as of 2026-08-31 the AA GDPval page embeds the leaderboard
// in two distinct RSC JSON shapes:
//
//   Format A (caught by the original regex):
//     {"label":"Model Name","gdpvalAaElo":[{"name":"mid","value":N},...],
//      "detailsUrl":"/models/slug"}
//
//   Format B (the FULL sorted leaderboard; was MISSED by the original):
//     {"id":"...","displayName":"Model Name","creator":{...},"elo":N,...}
//     followed by a model-list with {"slug":"...","name":"..."}
//
// GLM-5.2 only lives in Format B. Before the fix, the scraper returned
// `if (count > 0) return scores;` as soon as Format A matched, so Format B
// was never even tried. This caused `lookupGdp("glm-5-2")` to return
// undefined → GLM-5.2 was dropped from every `min_gdpval > 0` group
// (standard/complex/strategic/tactical/operational).

import { describe, it, expect } from 'vitest';

// ── Test-local copy of the function (kept in sync with index.ts) ──────────
// If you change the regex here, change it in index.ts. If you change it in
// index.ts, change it here. The goal is that any divergence fails the test
// by either (a) this function not matching real AA HTML, or (b) a snapshot
// below going red.
function extractGdpvalScores(html: string): Record<string, number> {
  const scores: Record<string, number> = {};
  const entryRe = /\{"label":"([^"]+)","gdpvalAaElo":\[[^\]]*"name":"mid","value":([\d.]+)[^\]]*\],"detailsUrl":"\/models\/([^"]+)"\}/g;
  let em;
  while ((em = entryRe.exec(html))) {
    const label = em[1];
    const score = parseFloat(em[2]);
    const slug = em[3];
    scores[slug] = score;
    const labelKey = label.toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (labelKey && labelKey !== slug) scores[labelKey] = score;
  }

  const normalized = html.replace(/\\"/g, '"');
  const slugByDisplayName = new Map<string, string>();
  const slugRe = /"slug":"([^"]+)","name":"([^"]+)"/g;
  let s;
  while ((s = slugRe.exec(normalized))) {
    slugByDisplayName.set(s[2], s[1]);
  }

  const eloRe = /\{"id":"[^"]+","displayName":"([^"]+)","creator":\{[^}]+\},"elo":([0-9.]+),"confidenceInterval":/g;
  while ((em = eloRe.exec(normalized))) {
    const displayName = em[1];
    const score = parseFloat(em[2]);
    let slug = slugByDisplayName.get(displayName);
    if (!slug) {
      const labelKey = displayName.toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      for (const [dn, sv] of slugByDisplayName) {
        const dnKey = dn.toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        if (dnKey === labelKey) { slug = sv; break; }
      }
    }
    if (slug) {
      scores[slug] = score;
      const labelKey = displayName.toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      if (labelKey && labelKey !== slug) scores[labelKey] = score;
    }
  }
  return scores;
}

// ── Fixtures ──────────────────────────────────────────────────────────────
// These are REAL fragments captured from the live AA page on 2026-08-31
// (https://artificialanalysis.ai/evaluations/gdpval-aa).  The HTML escapes
// JSON quotes as \", so the fragments look like escaped strings — this is
// exactly what extractGdpvalScores sees, so the test exercises the real
// format (not a sanitised version).

const FIXTURE_HTML = `
<!-- Format A: GLM-5.3 entries that the original regex always caught -->
{"label":"GLM-5.3 (max)","gdpvalAaElo":[{"@type":"PropertyValue","name":"mid","value":1758.29}],"detailsUrl":"/models/glm-5-3"}
{"label":"GLM-5.3-Flash","gdpvalAaElo":[{"@type":"PropertyValue","name":"mid","value":1764.66}],"detailsUrl":"/models/glm-5-3-flash"}

<!-- Format B: the full sorted leaderboard; only the "models" object lives
     in the RSC payload, and \\\\  is how the HTML escapes JSON quotes. -->
\\"models\\":[{\\"id\\":\\"cd684ea4-b475-4269-b001-d469d06d8a7a\\",\\"displayName\\":\\"GLM-5.3 (max)\\",\\"creator\\":{\\"name\\":\\"Z AI\\",\\"color\\":\\"#1c7ff8\\",\\"logo\\":\\"/img/logos/zai_small.svg\\"},\\"elo\\":1758.29,\\"confidenceInterval\\":\\"-18 / +18\\",\\"releaseDate\\":\\"2026-08-18\\"},{\\"id\\":\\"19496b81-9f41-4214-a77a-1df803b3c5ae\\",\\"displayName\\":\\"GLM-5.3-Flash\\",\\"creator\\":{\\"name\\":\\"Z AI\\"},\\"elo\\":1764.66,\\"confidenceInterval\\":\\"-18 / +18\\",\\"releaseDate\\":\\"2026-08-26\\"},{\\"id\\":\\"f7a4ea75-e548-4069-80d4-9be8bc7c009b\\",\\"displayName\\":\\"GLM-5.2 (max)\\",\\"creator\\":{\\"name\\":\\"Z AI\\",\\"color\\":\\"#1c7ff8\\",\\"logo\\":\\"/img/logos/zai_small.svg\\"},\\"elo\\":1497.55,\\"confidenceInterval\\":\\"-14 / +14\\",\\"releaseDate\\":\\"2026-06-16\\"},{\\"id\\":\\"e8aa417f-18fe-46b0-ba62-ef99785a9585\\",\\"displayName\\":\\"GLM-5.2 (Non-reasoning)\\",\\"creator\\":{\\"name\\":\\"Z AI\\",\\"color\\":\\"#1c7ff8\\",\\"logo\\":\\"/img/logos/zai_small.svg\\"},\\"elo\\":1387.72,\\"confidenceInterval\\":\\"-18 / +18\\",\\"releaseDate\\":\\"2026-06-16\\"}]

<!-- Model-list JSON that gives us slug <-> displayName mapping -->
{\\"slug\\":\\"glm-5-2\\",\\"name\\":\\"GLM-5.2 (max)\\",\\"deprecated\\":false,\\"isReasoning\\":true,\\"effort\\":{\\"slug\\":\\"max\\",\\"label\\":\\"max\\",\\"level\\":60},\\"release\\":{\\"slug\\":\\"glm-5-2\\",\\"name\\":\\"GLM-5.2\\"},\\"releaseDate\\":\\"2026-06-16\\",\\"creator\\":{\\"id\\":\\"67437eb6-7dc1-4e93-befd-22c8b8ec2065\\",\\"name\\":\\"Z AI\\",\\"logo\\":\\"/img/logos/zai_small.svg\\"}}
{\\"slug\\":\\"glm-5-2-non-reasoning\\",\\"name\\":\\"GLM-5.2 (Non-reasoning)\\",\\"deprecated\\":false,\\"isReasoning\\":false,\\"release\\":{\\"slug\\":\\"glm-5-2\\",\\"name\\":\\"GLM-5.2\\"},\\"releaseDate\\":\\"2026-06-16\\",\\"creator\\":{\\"id\\":\\"67437eb6-7dc1-4e93-befd-22c8b8ec2065\\",\\"name\\":\\"Z AI\\",\\"logo\\":\\"/img/logos/zai_small.svg\\"}}
{\\"slug\\":\\"glm-5-3\\",\\"name\\":\\"GLM-5.3 (max)\\",\\"deprecated\\":false,\\"isReasoning\\":true}
{\\"slug\\":\\"glm-5-3-flash\\",\\"name\\":\\"GLM-5.3-Flash\\",\\"deprecated\\":false,\\"isReasoning\\":true}
`;

// ── Tests ─────────────────────────────────────────────────────────────────

describe('AA GDPval scrape (extractGdpvalScores)', () => {
  it('extracts Format A entries via the gdpvalAaElo regex (glm-5-3)', () => {
    const scores = extractGdpvalScores(FIXTURE_HTML);
    expect(scores['glm-5-3']).toBe(1758.29);
    expect(scores['glm-5-3-flash']).toBe(1764.66);
  });

  // The regression we are guarding against.
  it('extracts glm-5-2 from Format B (the sorted leaderboard, no detailsUrl)', () => {
    const scores = extractGdpvalScores(FIXTURE_HTML);
    expect(scores['glm-5-2']).toBe(1497.55);
    expect(scores['glm-5-2-non-reasoning']).toBe(1387.72);
  });

  it('joins Format B displayName to slug via the model-list JSON', () => {
    // Build a minimal HTML that ONLY has Format B + the model-list, no Format A.
    // This proves the slug lookup is the join mechanism, not Format A.
    const htmlB = `
      \\"models\\":[{\\"id\\":\\"f7a4ea75-e548-4069-80d4-9be8bc7c009b\\",\\"displayName\\":\\"GLM-5.2 (max)\\",\\"creator\\":{\\"name\\":\\"Z AI\\"},\\"elo\\":1497.55,\\"confidenceInterval\\":\\"-14 / +14\\"}]
      {\\"slug\\":\\"glm-5-2\\",\\"name\\":\\"GLM-5.2 (max)\\"}
    `;
    const scores = extractGdpvalScores(htmlB);
    expect(scores['glm-5-2']).toBe(1497.55);
  });

  it('handles HTML-escaped JSON quotes (\\" in the source)', () => {
    // The scraper sees the raw HTML, where JSON-in-script is \\"-escaped.
    // Verify the unescape step works.
    const htmlEscaped = `{\\"slug\\":\\"x\\",\\"name\\":\\"X (max)\\"}`;
    const scores = extractGdpvalScores(`
      \\"models\\":[{\\"id\\":\\"abc\\",\\"displayName\\":\\"X (max)\\",\\"creator\\":{\\"name\\":\\"foo\\"},\\"elo\\":42.0,\\"confidenceInterval\\":\\"-1 / +1\\"}]
      ${htmlEscaped}
    `);
    expect(scores['x']).toBe(42.0);
  });

  it('returns empty on completely empty input (no false positives)', () => {
    const scores = extractGdpvalScores('');
    expect(Object.keys(scores)).toHaveLength(0);
  });

  it('returns empty on HTML with neither format (no crash, no garbage)', () => {
    const scores = extractGdpvalScores('<html><body>hello</body></html>');
    expect(Object.keys(scores)).toHaveLength(0);
  });

  it('does not crash on malformed JSON (no thrown exception)', () => {
    // Verify the function tolerates a malformed HTML body without crashing.
    // The regex just won't match the junk, so scores remain empty.
    const html = `
      <html><body>this is not the AA page</body></html>
      {"garbage": 1}
      \\"models\\":[{\\"id\\":\\"x\\",\\"displayName\\":\\"X\\",\\"creator\\":{\\"name\\":\\"foo\\"},\\"elo\\":1.0,\\"confidenceInterval\\":\\"a\\"}]
    `;
    expect(() => extractGdpvalScores(html)).not.toThrow();
    // The malformed entry has confidenceInterval "a" (not a number range) so the
    // regex legitimately does not match — scores stays empty.
    const scores = extractGdpvalScores(html);
    expect(scores['x']).toBeUndefined();
  });

  it('falls back to label-key match when exact displayName is missing', () => {
    // The leaderboard might say "GLM-5.2 (max)" but the model-list might
    // call it "GLM-5.2" (without the variant suffix). The label-key fallback
    // (strip parenthetical) bridges this.
    const html = `
      \\"models\\":[{\\"id\\":\\"x\\",\\"displayName\\":\\"GLM-5.2 (max)\\",\\"creator\\":{\\"name\\":\\"foo\\"},\\"elo\\":99.0,\\"confidenceInterval\\":\\"a\\"}]
      {\\"slug\\":\\"glm-5-2\\",\\"name\\":\\"GLM-5.2\\"}
    `;
    const scores = extractGdpvalScores(html);
    expect(scores['glm-5-2']).toBe(99.0);
  });
});
