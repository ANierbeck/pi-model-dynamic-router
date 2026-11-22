// test/serve-persists-group.test.ts
// Step 5 of docs/plans/2026-11-21-virtual-models-migration.md: a served
// request is the production writer of the branch state's `group` field, so
// the per-group compaction budget survives a restart. Red-first per AGENTS §4.
import { describe, expect, it } from 'vitest';
import {
  BASE_CONFIG,
  cloudModel,
  drainStream,
  emptyStream,
  streamText,
  successStream,
  withIsolatedRouter,
} from './helpers/drive-stream-env.ts';
import { branchState, STATE_ENTRY } from '../src/virtual-selection.ts';

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

  // The group of the cascade's walk, not the primary's: after every
  // `standard` candidate failed, `simple` served (and owns the budget).
  it('a cascade into the fallback group records the fallback group', async () => {
    await withIsolatedRouter(
      {
        ...BASE_CONFIG,
        model_groups: {
          standard: { fallback_groups: ['simple'], min_gdpval: 900, max_cost: 1000 },
          simple: { fallback_groups: [], min_gdpval: 0, max_gdpval: 899, max_cost: 1000 },
        },
        gdpval_builtin: { 'hi-1': 1000, 'lo-1': 800 },
      },
      [cloudModel('hi-provider', 'hi-1'), cloudModel('lo-provider', 'lo-1')],
      async ({ groupStream, streamSimple, sessionManager }) => {
        streamSimple.mockImplementation((model: any) =>
          model.id === 'lo-1' ? successStream('fallback served') : emptyStream()
        );
        const events = await drainStream(
          await groupStream(
            { provider: 'standard', id: 'standard' } as any,
            { messages: [{ role: 'user', content: 'do the thing', timestamp: 1 }] } as any,
            {}
          )
        );
        expect(streamText(events as any)).toContain('fallback served');
        expect(branchState(sessionManager.getBranch() as any)?.group).toBe('simple');
      }
    );
  }, 30_000);

  // Live-phase follow-up: a request's writes fold into one entry, committed
  // when a stream opens (crash safety: the state is on the branch while the
  // model answers). A cascade opens a stream per walk group, so it commits
  // once per group that opened one: the primary when hi-1 opened (its
  // answer then came back empty), the fallback when lo-1 opened. Failed
  // candidates of the same group add nothing.
  it('a cascade commits once per walk group that opened a stream', async () => {
    await withIsolatedRouter(
      {
        ...BASE_CONFIG,
        model_groups: {
          standard: { fallback_groups: ['simple'], min_gdpval: 900, max_cost: 1000 },
          simple: { fallback_groups: [], min_gdpval: 0, max_gdpval: 899, max_cost: 1000 },
        },
        gdpval_builtin: { 'hi-1': 1000, 'lo-1': 800 },
      },
      [cloudModel('hi-provider', 'hi-1'), cloudModel('lo-provider', 'lo-1')],
      async ({ groupStream, streamSimple, sessionManager }) => {
        streamSimple.mockImplementation((model: any) =>
          model.id === 'lo-1' ? successStream('fallback served') : emptyStream()
        );
        await drainStream(
          await groupStream(
            { provider: 'standard', id: 'standard' } as any,
            { messages: [{ role: 'user', content: 'do the thing', timestamp: 1 }] } as any,
            {}
          )
        );
        const stateEntries = sessionManager
          .getBranch()
          .filter((e: any) => e.type === 'custom' && e.customType === STATE_ENTRY);
        expect(stateEntries.map((e: any) => e.data.state.group)).toEqual(['standard', 'simple']);
        expect(branchState(sessionManager.getBranch() as any)?.group).toBe('simple');
      }
    );
  }, 30_000);
});
