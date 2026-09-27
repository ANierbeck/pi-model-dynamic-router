// test/serialized.test.ts
// generateDynamicConfig awaits an LLM call; a scan and the settled scan-sanity
// re-check could overlap and both write router-config.dynamic.json, the slower
// one last (review 2026-09-27). serialized() queues the runs.

import { describe, it, expect } from 'vitest';
import { serialized } from '../src/utils.ts';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('serialized', () => {
  it('never overlaps runs and keeps call order', async () => {
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    const run = serialized(async (name: string, ms: number) => {
      active++;
      maxActive = Math.max(maxActive, active);
      events.push(`start ${name}`);
      await tick(ms);
      events.push(`end ${name}`);
      active--;
    });
    await Promise.all([run('slow', 30), run('fast', 1)]);
    expect(maxActive).toBe(1);
    expect(events).toEqual(['start slow', 'end slow', 'start fast', 'end fast']);
  });

  it('a failed run rejects its own caller only and does not block the next', async () => {
    const run = serialized(async (fail: boolean) => {
      if (fail) throw new Error('boom');
    });
    const first = run(true);
    const second = run(false);
    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBeUndefined();
  });
});
