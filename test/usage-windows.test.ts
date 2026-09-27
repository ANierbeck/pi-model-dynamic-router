// test/usage-windows.test.ts
//
// The promised windows-boundary test from the plan (review I3: it was
// missing, and its absence let the structurally-all-zero windows ship —
// I1). Pins the REAL wiring basis: metrics.getUsage/getUsageAll over a
// synthetic usage_log with entries at 1d/7d/30d boundaries, plus the
// ref-space the /router cost windows are keyed by (REAL model refs, never
// the virtual group refs the writer used before the I1 fix).

import { describe, it, expect, beforeEach } from 'vitest';
import { getUsage, getUsageAll, setCache } from '../src/metrics.ts';
import type { Cache } from '../src/types.ts';

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

function entry(ref: string, tokens: number, hoursAgo: number) {
  return { ref, tokens, ts: NOW - hoursAgo * HOUR };
}

describe('usage windows over a synthetic usage_log', () => {
  beforeEach(() => {
    setCache({
      usage_log: [
        entry('mistral/zai-glm-5-3', 100, 3), // < 1d
        entry('mistral/zai-glm-5-3', 200, 2 * 24), // 1d..7d
        entry('mistral/zai-glm-5-3', 400, 10 * 24), // 7d..30d
        entry('mistral/zai-glm-5-3', 800, 40 * 24), // > 30d — must drop
        entry('mistral/mistral-medium-3.5', 50, 5), // < 1d, second ref
        entry('ollama/gemma4:latest', 70, 25 * 24), // only in the 30d window
      ],
    } as Cache);
  });

  it('getUsage sums per ref inside the window and drops older entries', () => {
    // 1d: only the 3h-old entry
    expect(getUsage('mistral/zai-glm-5-3', 1)).toBe(100);
    // 7d: 3h + 48h entries
    expect(getUsage('mistral/zai-glm-5-3', 7)).toBe(300);
    // 30d: + the 10-day entry; the 40-day entry is gone
    expect(getUsage('mistral/zai-glm-5-3', 30)).toBe(700);
    // other refs stay separate
    expect(getUsage('mistral/mistral-medium-3.5', 1)).toBe(50);
    expect(getUsage('ollama/gemma4:latest', 7)).toBe(0);
    expect(getUsage('ollama/gemma4:latest', 30)).toBe(70);
  });

  it('getUsageAll returns per-ref maps per window — the windowsAll basis', () => {
    const d1 = getUsageAll(1);
    expect(d1).toEqual({ 'mistral/zai-glm-5-3': 100, 'mistral/mistral-medium-3.5': 50 });
    const d7 = getUsageAll(7);
    expect(d7['mistral/zai-glm-5-3']).toBe(300);
    expect(d7['ollama/gemma4:latest']).toBeUndefined();
    const d30 = getUsageAll(30);
    expect(d30).toEqual({
      'mistral/zai-glm-5-3': 700,
      'mistral/mistral-medium-3.5': 50,
      'ollama/gemma4:latest': 70,
    });
  });

  it('real model refs are the key space — a virtual group ref never matches', () => {
    // The pre-I1 writer keyed usage_log by ctx.model ('standard/standard');
    // window lookups by real refs were structurally all-zero. Pin the
    // ref-space contract the /router cost windows rely on.
    expect(getUsage('standard/standard', 30)).toBe(0);
    expect(getUsageAll(30)['standard/standard']).toBeUndefined();
  });
});
