// ADR-0027 Phase 2: a group HINT on turn N writes a `route-correction`
// record whose `prevTurn` is the turn being corrected (N-1, see
// DecisionCorrectionRecord). The orchestrator parsed the sequence number of
// the CURRENT turn id, so every record named its own turn as the corrected
// one. Found in the step-5 review of the virtual-models migration: the
// served group now survives a restart (branch state), and with `prevTurn`
// equal to `turn` the first HINT of a new process also wrote a correction
// against a turn of the previous process.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeExtensionContext, startSession } from './helpers/extension-harness.ts';
import { paidCloudModel } from './helpers/stream-fixtures.ts';
import { successStream } from './helpers/drive-stream-env.ts';
import { withRouterEnv } from './helpers/router-env.ts';
import { STATE_ENTRY, VIRTUAL_MODEL_ID, VIRTUAL_PROVIDER } from '../src/virtual-selection.ts';

const CONFIG = {
  free_models: [],
  providers: {},
  classifier: { log: { enabled: true } },
  model_groups: {
    dynamic: { method: 'dynamic' },
    planning: { fallback_groups: [], min_gdpval: 950 },
    standard: { fallback_groups: [], min_gdpval: 0 },
  },
  gdpval_builtin: { 'paid-model': 1000 },
};

const corrections = (): any[] => {
  const file = path.join(os.homedir(), '.pi', 'logs', 'classifier-decisions.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.stage === 'route-correction');
};

async function bootAndRun(
  fn: (h: {
    turn: (group: string, prompt: string) => Promise<void>;
    /** The correction records written since this boot (the file's home is per test FILE). */
    newCorrections: () => any[];
  }) => Promise<void>,
  /** A served group the branch carries from an earlier process. */
  storedGroup?: string
): Promise<void> {
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
      const ctx: any = await startSession(onHandlers, { modelRegistry, cwd: tmpDir });
      if (storedGroup) {
        ctx.sessionManager.appendCustomEntry(STATE_ENTRY, {
          provider: VIRTUAL_PROVIDER,
          modelId: VIRTUAL_MODEL_ID,
          state: { pin: null, group: storedGroup },
        });
      }
      const sessionId = ctx.sessionManager.getSessionId();
      const turn = async (group: string, prompt: string): Promise<void> => {
        await onHandlers['turn_start']?.({}, ctx);
        const stream: AsyncIterable<unknown> = await defaultExport.groupStream(
          { provider: group, id: group },
          { messages: [{ role: 'user', content: prompt, timestamp: Date.now() }] },
          { sessionId }
        );
        for await (const _ev of stream) {
          // drain
        }
      };
      const before = corrections().length;
      await fn({ turn, newCorrections: () => corrections().slice(before) });
    },
    { config: CONFIG, disableNetwork: true }
  );
}

describe('route-correction records name the corrected (previous) turn', () => {
  it('a group HINT on turn 2 corrects turn 1', async () => {
    await bootAndRun(async ({ turn, newCorrections }) => {
      await turn('standard', 'do the thing');
      await turn('dynamic', 'HINT use group planning and redo it');
      const recs = newCorrections();
      expect(recs).toHaveLength(1);
      expect(recs[0].from.group).toBe('standard');
      expect(recs[0].to.group).toBe('planning');
      expect(recs[0].turn).toMatch(/#2$/);
      expect(recs[0].prevTurn).toMatch(/#1$/);
    });
  }, 30_000);

  it('a group HINT on the first turn of a process writes no correction', async () => {
    // The branch may carry a served group from an earlier process; its turn
    // numbers are not this process's, so there is nothing to join against.
    await bootAndRun(async ({ turn, newCorrections }) => {
      await turn('dynamic', 'HINT use group planning and do it');
      expect(newCorrections()).toHaveLength(0);
    }, 'standard');
  }, 30_000);
});
