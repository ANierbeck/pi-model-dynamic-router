// test/dynamic-config-permanent-block-filter.test.ts
// Plan docs/plans/2026-11-16-permanent-blocklist-no-ttl.md
//
// The generated snapshot (router-config.dynamic.json) is what the router
// persists for the next start. It deliberately did NOT consult the learned
// blocklist, because a temporary block baked into a persisted file would
// outlive its 7-day TTL (see the comment in src/routing.ts). That rationale
// covers temporary blocks only: a retirement block (decommissioned /
// free-variant-retired) states a property of the model, so freezing it into
// the snapshot is exactly right — otherwise a retired model is re-admitted
// with every regeneration.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { startRouterWithScanCache, waitFor } from './helpers/dynamic-config-harness.ts';

const NOW = Date.now();

function allSnapshotRefs(dynamicPath: string): string[] {
  const snap = JSON.parse(fs.readFileSync(dynamicPath, 'utf-8'));
  const refs = new Set<string>();
  for (const group of Object.values(snap.model_groups ?? {}) as Array<{ models?: string[] }>) {
    for (const ref of group.models ?? []) refs.add(ref);
  }
  return [...refs];
}

describe('permanently blocked models never reach the generated snapshot', () => {
  it('drops a permanently blocked ref and keeps a temporary one', async () => {
    const { dynamicPath, cleanup } = await startRouterWithScanCache({
      models: [
        { provider: 'healthy-provider', id: 'model-a' },
        { provider: 'healthy-provider', id: 'model-retired' },
        { provider: 'healthy-provider', id: 'model-flaky' },
      ],
      cache: {
        // lastScanTimestamp 0 = expired cache, so generateDynamicConfig() runs.
        lastScanTimestamp: 0,
        gdpval_scores: { 'model-a': 1200, 'model-retired': 1100, 'model-flaky': 1000 },
        model_blocklist: {
          'healthy-provider/model-retired': {
            reason: 'decommissioned',
            code: 404,
            signature: '404:decommissioned',
            first_seen: NOW - 90 * 86_400_000,
            last_seen: NOW - 90 * 86_400_000, // far older than the 7-day TTL
            occurrences: 1,
          },
          'healthy-provider/model-flaky': {
            reason: 'unknown-signature',
            code: 422,
            signature: '422:something exploded',
            first_seen: NOW - 3_600_000,
            last_seen: NOW - 60_000, // still inside the TTL
            occurrences: 5,
          },
        },
      },
    });
    try {
      expect(await waitFor(() => fs.existsSync(dynamicPath))).toBe(true);
      const refs = allSnapshotRefs(dynamicPath);
      expect(refs).toContain('healthy-provider/model-a');
      expect(refs).not.toContain('healthy-provider/model-retired');
      // Deliberate: a temporary block is not frozen into the persisted file.
      expect(refs).toContain('healthy-provider/model-flaky');
    } finally {
      cleanup();
    }
  });
});
