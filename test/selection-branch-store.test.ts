// Plan docs/plans/2026-11-21-virtual-models-migration.md, step 3: the run
// group, the session's group and the inherited category move into the branch
// state (pi.virtual-model-state), so a fork and a /tree jump see their own
// branch's values and a restart keeps them. Red-first per AGENTS.md §4.
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setLogLevel, setProjectLogDir } from '../src/logger.ts';

import {
  createSelectionStateSource,
  STATE_ENTRY,
  VIRTUAL_MODEL_ID,
  VIRTUAL_PROVIDER,
} from '../src/virtual-selection.ts';
import type { SelectionState } from '../src/virtual-selection.ts';

/** A fake pi SessionManager: enough of the real entry semantics. */
function fakeManager(initial: unknown[] = []) {
  let entries: any[] = [...initial];
  let nextId = 1;
  const mgr = {
    getBranch: vi.fn(() => [...entries]),
    getLeafId: vi.fn(() => entries[entries.length - 1]?.id ?? undefined),
    appendCustomEntry: vi.fn((customType: string, data: unknown) => {
      const id = `e${nextId++}`;
      entries = [...entries, { id, type: 'custom', customType, data }];
      return id;
    }),
    setBranch(next: unknown[]): void {
      entries = [...next];
    },
  };
  return mgr;
}

function makeSource(mgr: any | null) {
  return createSelectionStateSource({
    branch: () => mgr?.getBranch?.() ?? [],
    leafId: () => mgr?.getLeafId?.(),
    appendState: (state: SelectionState) => {
      mgr?.appendCustomEntry(STATE_ENTRY, {
        provider: VIRTUAL_PROVIDER,
        modelId: VIRTUAL_MODEL_ID,
        state,
      });
    },
  });
}

const stateData = (state: SelectionState): any => ({
  type: 'custom',
  customType: STATE_ENTRY,
  data: { provider: VIRTUAL_PROVIDER, modelId: VIRTUAL_MODEL_ID, state },
});

describe('selection state source (step 3)', () => {
  it('a write merges with the stored state — the pin survives a category write', () => {
    const mgr = fakeManager([stateData({ pin: 'planning', group: 'planning' } as SelectionState)]);
    const src = makeSource(mgr);
    src.write({ lastCategory: 'code_complex' });
    expect(mgr.appendCustomEntry).toHaveBeenCalledTimes(1);
    const [customType, data] = mgr.appendCustomEntry.mock.calls[0];
    expect(customType).toBe(STATE_ENTRY);
    expect(data.state).toEqual({
      pin: 'planning',
      group: 'planning',
      runGroup: undefined,
      lastCategory: 'code_complex',
    });
  });

  it('read sees the write immediately (the leaf-id memo invalidates on append)', () => {
    const mgr = fakeManager();
    const src = makeSource(mgr);
    expect(src.read()).toBeUndefined();
    src.write({ runGroup: 'code_complex' });
    expect(src.read()).toEqual({ pin: null, runGroup: 'code_complex' });
  });

  it('a restart keeps the values: a NEW source over the same manager reads them', () => {
    const mgr = fakeManager();
    makeSource(mgr).write({ group: 'code_complex', lastCategory: 'design' });
    const afterRestart = makeSource(mgr);
    expect(afterRestart.read()).toEqual({
      pin: null,
      group: 'code_complex',
      runGroup: undefined,
      lastCategory: 'design',
    });
  });

  it('a /tree jump reads the jumped-to branch, not the old one (memo keyed by leaf)', () => {
    const mgr = fakeManager();
    const src = makeSource(mgr);
    src.write({ lastCategory: 'planning' });

    const otherBranch = [
      stateData({
        pin: null,
        group: 'simple',
        runGroup: null,
        lastCategory: 'simple',
      } as SelectionState),
    ];
    mgr.setBranch(otherBranch);
    expect(src.read()).toEqual({
      pin: null,
      group: 'simple',
      runGroup: null,
      lastCategory: 'simple',
    });

    // ... and back: an EMPTY branch stores no state — the caller applies the
    // defaults (undefined means "no state", not a folded default object).
    mgr.setBranch([]);
    expect(src.read()).toBeUndefined();
  });

  it('without a session manager: read is undefined and write is a silent no-op', () => {
    const src = makeSource(null);
    expect(src.read()).toBeUndefined();
    expect(() => src.write({ runGroup: 'planning' })).not.toThrow();
  });

  it('an unknown stored lastCategory reads back undefined (untrusted JSON)', () => {
    // A hand-edited session file or a future router version may write a value
    // outside the taxonomy; the read seam filters it like the other garbage.
    const mgr = fakeManager([stateData({ pin: null, lastCategory: 'garbage' } as SelectionState)]);
    expect(makeSource(mgr).read()?.lastCategory).toBeUndefined();
  });

  it('a valid stored lastCategory reads back as-is', () => {
    const mgr = fakeManager([stateData({ pin: null, lastCategory: 'planning' } as SelectionState)]);
    expect(makeSource(mgr).read()?.lastCategory).toBe('planning');
  });
});

describe('persistence failures (review step-3 round 1, Important 2)', () => {
  afterEach(() => {
    setProjectLogDir(undefined);
    setLogLevel('info');
  });

  it('a throwing appendState is logged, not silently dropped — write still does not throw', () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-persist-'));
    fs.rmSync(path.join(os.homedir(), '.pi', 'logs'), { recursive: true, force: true });
    try {
      setLogLevel('debug');
      setProjectLogDir(logDir);
      const src = createSelectionStateSource({
        branch: () => [],
        leafId: () => undefined,
        appendState: () => {
          throw new Error('disk full');
        },
      });
      expect(() => src.write({ lastCategory: 'planning' })).not.toThrow();
      const log = path.join(logDir, '.pi', 'logs', 'router.log');
      const content = fs.readFileSync(log, 'utf-8');
      expect(content).toContain('[selection] branch state not persisted');
      expect(content).toContain('disk full');
    } finally {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });

  it('the deliberate skip (io handles no-manager itself) is not reported as a failure', () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-quiet-'));
    fs.rmSync(path.join(os.homedir(), '.pi', 'logs'), { recursive: true, force: true });
    try {
      setLogLevel('debug');
      setProjectLogDir(logDir);
      const src = createSelectionStateSource({
        branch: () => [],
        leafId: () => undefined,
        appendState: () => {
          /* io resolved no manager: a quiet no-op by contract */
        },
      });
      src.write({ lastCategory: 'planning' });
      expect(fs.existsSync(path.join(logDir, '.pi', 'logs', 'router.log'))).toBe(false);
    } finally {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });
});
