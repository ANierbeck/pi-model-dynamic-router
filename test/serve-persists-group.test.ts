// test/serve-persists-group.test.ts
// Step 5 of docs/plans/2026-11-21-virtual-models-migration.md: a served
// request is the production writer of the branch state's `group` field, so
// the per-group compaction budget survives a restart. Red-first per AGENTS §4.
import { describe, expect, it } from 'vitest';
import {
  BASE_CONFIG,
  cloudModel,
  drainStream,
  streamText,
  successStream,
  withIsolatedRouter,
} from './helpers/drive-stream-env.ts';
import { branchState } from '../src/virtual-selection.ts';

describe('a served request persists the served group (step 5)', () => {
  it('the branch state records the group that served', async () => {
    await withIsolatedRouter(
      { ...BASE_CONFIG, model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } } },
      [cloudModel('serve-provider', 'm1')],
      async ({ groupStream, streamSimple, sessionManager }) => {
        streamSimple.mockImplementation(() => successStream('served'));

        const events = await drainStream(
          await groupStream(
            { provider: 'router', id: 'standard' } as any,
            { messages: [{ role: 'user', content: 'do the thing', timestamp: 1 }] } as any,
            {}
          )
        );
        expect(streamText(events as any)).toContain('served');

        const state = branchState(sessionManager.getBranch() as any);
        expect(state?.group).toBe('standard');
      }
    );
  }, 30_000);
});
