// Step 5 of docs/plans/2026-11-21-virtual-models-migration.md: the Router kept
// its own copy of the session's group (RouterTurnState.activeGroup), mirrored
// from the branch state on every serve, and Router.detectGroup returned it
// ahead of the GDPval tiers. Since a served stream writes the branch group
// (owner decision 2026-11-21), the copy went stale on a switch to a concrete
// model: model_select clears the branch group, not the Router's copy, so the
// footer of the concrete model named the group that served before the switch.
import { describe, it, expect, vi } from 'vitest';
import { makeExtensionContext, fakeSessionManager } from './helpers/extension-harness.ts';
import { paidCloudModel } from './helpers/stream-fixtures.ts';
import { successStream } from './helpers/drive-stream-env.ts';
import { withRouterEnv } from './helpers/router-env.ts';
import { flushBackgroundScan } from './helpers/noop-scan-cache.ts';

const CONFIG = {
  free_models: [],
  providers: {},
  model_groups: {
    dynamic: { method: 'dynamic' },
    // paid-model (1000) is a member of both; its GDPval tier is `planning`.
    planning: { fallback_groups: [], min_gdpval: 950 },
    standard: { fallback_groups: [], min_gdpval: 0 },
  },
  gdpval_builtin: { 'paid-model': 1000 },
};

const theme = { fg: (_color: string, text: string): string => text };

describe('the footer of a concrete model after a served group', () => {
  it('names the model’s GDPval tier, not the group that served before the switch', async () => {
    await withRouterEnv(
      async (defaultExport, tmpDir) => {
        const { ctx: pi, onHandlers } = makeExtensionContext();
        defaultExport(pi);
        const paid = paidCloudModel();
        const modelRegistry = {
          getAvailable: () => [paid],
          find: () => paid,
          getApiKeyForProvider: async () => null,
          runtime: {
            streamSimple: vi.fn(() => successStream('ok')),
          },
        };
        let render: (() => string) | undefined;
        const ctx: any = {
          cwd: tmpDir,
          model: paid,
          modelRegistry,
          sessionManager: fakeSessionManager(),
          getContextUsage: () => null,
          ui: {
            setFooter: (factory: any) => {
              const footer = factory({ requestRender: () => {} }, theme, {
                onBranchChange: () => () => {},
                getGitBranch: () => '',
                getExtensionStatuses: () => new Map(),
              });
              render = () => footer.render(400).join('');
            },
          },
        };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();
        expect(render, 'session_start installs the footer').toBeDefined();

        // Two served streams on the `standard` group model. In the red phase
        // the second one mirrored the branch group into the Router's copy,
        // which outlived the switch below.
        const serve = async (): Promise<void> => {
          const stream: AsyncIterable<unknown> = await defaultExport.groupStream(
            { provider: 'standard', id: 'standard' },
            { messages: [{ role: 'user', content: 'do the thing', timestamp: 1 }] },
            // Pi hands the session id to every stream; the router scopes the
            // per-session state (incl. the Router's group copy) by it.
            { sessionId: ctx.sessionManager.getSessionId() }
          );
          for await (const _ev of stream) {
            // drain
          }
        };
        await serve();
        await serve();

        // The user switches to the concrete model.
        await onHandlers['model_select']?.({ model: paid, source: 'set' }, ctx);

        const text = render!();
        expect(text).toContain('planning');
        expect(text).not.toContain('standard');
      },
      { config: CONFIG, disableNetwork: true }
    );
  }, 30_000);
});
