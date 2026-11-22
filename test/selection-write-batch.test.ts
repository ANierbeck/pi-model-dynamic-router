// Live-phase follow-up of the step-5 migration (plan
// docs/plans/2026-11-21-virtual-models-migration.md): the writes of one walk
// (run group at open, category after classification, group at serve) fold
// into ONE branch entry per stream, not one entry per write. Red-first per
// AGENTS.md §4: each case was observed failing against the unbatched source.
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setLogLevel, setProjectLogDir } from '../src/logger.ts';

import { createSelectionStateSource, STATE_ENTRY } from '../src/virtual-selection.ts';

/** A fake pi SessionManager with the real append/leaf semantics. */
function fakeManager() {
  let entries: any[] = [];
  let nextId = 1;
  return {
    getBranch: vi.fn(() => [...entries]),
    getLeafId: vi.fn(() => entries[entries.length - 1]?.id ?? undefined),
    appendCustomEntry: vi.fn((customType: string, data: unknown) => {
      const id = `e${nextId++}`;
      entries = [...entries, { id, type: 'custom', customType, data }];
      return id;
    }),
    stateEntries: () => entries.filter((e) => e.customType === STATE_ENTRY),
  };
}

function makeSource(mgr: ReturnType<typeof fakeManager>) {
  return createSelectionStateSource({
    branch: () => mgr.getBranch(),
    leafId: () => mgr.getLeafId(),
    appendState: (state) => {
      mgr.appendCustomEntry(STATE_ENTRY, { provider: 'router', modelId: 'dynamic', state });
    },
  });
}

describe('selection-state write batching (one entry per stream)', () => {
  it('the writes of one batch land as a single branch entry with the folded state', () => {
    const mgr = fakeManager();
    const src = makeSource(mgr);
    src.beginBatch();
    src.write({ runGroup: 'standard' });
    src.write({ lastCategory: 'planning' });
    src.write({ group: 'planning' });
    expect(
      mgr.appendCustomEntry,
      'nothing is appended while the batch is open'
    ).not.toHaveBeenCalled();
    src.endBatch();
    expect(mgr.appendCustomEntry).toHaveBeenCalledTimes(1);
    const [entry] = mgr.stateEntries();
    expect(entry.data.state).toMatchObject({
      runGroup: 'standard',
      lastCategory: 'planning',
      group: 'planning',
    });
  });

  it('a read inside the batch sees the folded value before the flush', () => {
    const mgr = fakeManager();
    const src = makeSource(mgr);
    src.beginBatch();
    src.write({ group: 'code_complex' });
    expect(src.read()?.group).toBe('code_complex');
    expect(mgr.stateEntries()).toHaveLength(0);
    src.endBatch();
    expect(src.read()?.group).toBe('code_complex');
  });

  it('nested batches flush only when the outermost end is reached', () => {
    const mgr = fakeManager();
    const src = makeSource(mgr);
    src.beginBatch();
    src.beginBatch();
    src.write({ group: 'standard' });
    src.endBatch();
    expect(mgr.appendCustomEntry, 'the inner end does not flush').not.toHaveBeenCalled();
    src.write({ lastCategory: 'planning' });
    src.endBatch();
    expect(mgr.appendCustomEntry).toHaveBeenCalledTimes(1);
  });

  it('a walk started inside an open batch joins it: its begin does not flush the outer writes', () => {
    const mgr = fakeManager();
    const src = makeSource(mgr);
    src.beginBatch(); // the outer stream
    src.write({ runGroup: 'standard' });
    src.beginBatch(); // a fallback walk inside it
    expect(
      mgr.appendCustomEntry,
      'the nested begin must not split the batch'
    ).not.toHaveBeenCalled();
    src.write({ group: 'simple' });
    src.endBatch();
    src.endBatch();
    expect(mgr.appendCustomEntry).toHaveBeenCalledTimes(1);
    expect(mgr.stateEntries()[0].data.state).toMatchObject({
      runGroup: 'standard',
      group: 'simple',
    });
  });

  it('a write that changes nothing inside a batch appends nothing', () => {
    const mgr = fakeManager();
    const src = makeSource(mgr);
    src.write({ group: 'standard' });
    expect(mgr.appendCustomEntry).toHaveBeenCalledTimes(1);
    src.beginBatch();
    src.write({ group: 'standard' });
    src.endBatch();
    expect(mgr.appendCustomEntry).toHaveBeenCalledTimes(1);
  });

  it('writes outside any batch still append immediately', () => {
    const mgr = fakeManager();
    const src = makeSource(mgr);
    src.write({ runGroup: 'standard' });
    src.write({ lastCategory: 'planning' });
    expect(mgr.appendCustomEntry).toHaveBeenCalledTimes(2);
  });

  it('an unmatched endBatch is a no-op', () => {
    const mgr = fakeManager();
    const src = makeSource(mgr);
    expect(() => src.endBatch()).not.toThrow();
    expect(mgr.appendCustomEntry).not.toHaveBeenCalled();
  });
});

describe("a failing flush (the batch end runs in the stream path's finally)", () => {
  afterEach(() => {
    setProjectLogDir(undefined);
    setLogLevel('info');
  });

  it('is logged, and endBatch does not throw into the stream path', () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-batch-'));
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
      src.beginBatch();
      src.write({ group: 'standard' });
      expect(() => src.endBatch()).not.toThrow();
      const content = fs.readFileSync(path.join(logDir, '.pi', 'logs', 'router.log'), 'utf-8');
      expect(content).toContain('[selection] branch state not persisted');
      expect(content).toContain('disk full');
    } finally {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });
});
