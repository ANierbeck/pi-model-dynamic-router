// Decision-log stages that never routed a prompt. Every reader that counts
// "decisions" (turn join, failover walk, pool replay, shadow stats) must skip
// them; a stage added without joining this list silently inflates those
// numbers, which is how the observation records could have corrupted the
// measurements built on the log.

import { describe, it, expect } from 'vitest';
import { NON_ROUTING_STAGES } from '../src/classifier-decision-log.ts';

describe('NON_ROUTING_STAGES', () => {
  it.each(['pool', 'comparator', 'observation', 'observation-comparator'])('contains %s', (stage) => {
    expect(NON_ROUTING_STAGES.has(stage)).toBe(true);
  });

  it.each(['laya', 'momentum', 'hint', 'compaction', 'cache', 'llm-local', 'llm-cloud', 'static', 'fallback'])(
    'does not contain the routing stage %s',
    (stage) => {
      expect(NON_ROUTING_STAGES.has(stage)).toBe(false);
    },
  );
});
