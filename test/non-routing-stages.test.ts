// Decision-log stages that never routed a prompt. Every reader that counts
// "decisions" (turn join, failover walk, pool replay, shadow stats) must skip
// them; a stage added without joining this list silently inflates those
// numbers, which is how the observation records could have corrupted the
// measurements built on the log.

import { describe, it, expect } from 'vitest';
import { NON_ROUTING_STAGES } from '../src/classifier-decision-log.ts';

describe('NON_ROUTING_STAGES', () => {
  it.each([
    'pool',
    'comparator',
    'observation',
    'observation-comparator',
    // Phase 2/4 records (ADR-0027): a turn outcome and a route correction
    // describe a decision, they never made one.
    'outcome',
    'route-correction',
  ])('contains %s', (stage) => {
    expect(NON_ROUTING_STAGES.has(stage)).toBe(true);
  });

  it.each([
    'laya',
    'momentum',
    'hint',
    'compaction',
    'cache',
    'llm-local',
    'llm-cloud',
    'fallback',
  ])('does not contain the routing stage %s', (stage) => {
    expect(NON_ROUTING_STAGES.has(stage)).toBe(false);
  });
});
