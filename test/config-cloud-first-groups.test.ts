// test/config-cloud-first-groups.test.ts
// Guards the 2026-09-27 cloud-first routing change: five model groups must
// rank cloud models ahead of the local Ollama daemon, which had repeatedly
// pinned the GPU at 100% when hit as a default path (MLX wedge incidents).
// A silent revert to strict_local/local_first would reintroduce that load.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
