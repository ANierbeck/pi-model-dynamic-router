// test/turn-driver-survives-load.test.ts
// load() replaces the Router on every session_start (and from tools such as
// resolve_model_group); pi-subagents children start in-process while the
// parent's turn is still running. The turn's driving model must survive the
// rebuild: index.ts hands every new Router the same per-session turn-state
// store. Observable: the expensive-model read block, which judges the turn's
// driver, not the cheap session ref.
//
// Replaces the end-to-end case in test/delegation.test.ts (removed in the
// virtual-models step 2 review round): its "cheap" session model was itself
// a live member of an expensive group, so it passed without any pin and
// without the shared store (re-review 2026-11-21).

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { makeExtensionContext, startSession } from './helpers/extension-harness.ts';
import { doneEvent, paidCloudModel } from './helpers/stream-fixtures.ts';
import { withRouterEnv } from './helpers/router-env.ts';

const CONFIG = {
  free_models: [],
  providers: {},
  delegation: { enabled: true, expensive_groups: ['code_complex'], expensive_providers: [] },
  model_groups: {
    dynamic: { method: 'dynamic' },
    // Only paid-model (1000) clears the floor: other-model (900) is no member.
    code_complex: { fallback_groups: [], min_gdpval: 950 },
  },
  gdpval_builtin: { 'paid-model': 1000, 'other-model': 900 },
};

const SID = 'parent';
const session = (extra: Record<string, unknown> = {}): any => ({
  sessionManager: { getSessionId: () => SID, getBranch: () => [] },
  ...extra,
});

describe('the turn driver survives the Router rebuild of load()', () => {
  it('a mid-turn session_start keeps the expensive driver for the read block', async () => {
    await withRouterEnv(
      async (defaultExport, tmpDir) => {
        const { ctx: pi, onHandlers } = makeExtensionContext();
        defaultExport(pi);
        const paid = paidCloudModel();
        const other = paidCloudModel({ id: 'other-model' });
        const modelRegistry = {
          getAvailable: () => [paid, other],
          find: (_p: string, id: string) => (id === 'other-model' ? other : paid),
          getApiKeyForProvider: async () => null,
          runtime: {
            streamSimple: vi.fn(() =>
              (async function* () {
                yield { type: 'text_delta', delta: 'ok' };
                yield doneEvent();
              })()
            ),
          },
        };
        await startSession(onHandlers, { modelRegistry, cwd: tmpDir });
        const small = path.join(tmpDir, 'small.ts');
        fs.writeFileSync(small, 'export const x = 1;\n');
        const read = (): any =>
          onHandlers['tool_call']?.({ toolName: 'read', input: { path: small } }, session());

        // The session ref is cheap: without a driver, a small file passes.
        await onHandlers['turn_start']?.({}, session({ model: other }));
        expect(read()).toBeUndefined();

        // The turn is driven by the expensive group.
        for await (const ev of defaultExport.groupStream(
          { provider: 'code_complex', id: 'code_complex' },
          { messages: [{ role: 'user', content: 'refactor it' }] },
          { sessionId: SID }
        ))
          void ev;
        expect(read()?.expensive).toBe(true);

        // A child's session_start runs load(): a new Router.
        await onHandlers['session_start']?.(
          {},
          { ...session(), modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } }
        );
        expect(read()?.expensive).toBe(true);
      },
      { config: CONFIG, disableNetwork: true }
    );
  }, 30000);
});
