// Item sets and reference records for the parity gate (plan step 2). Pure functions:
// the owner's data is read and written by the CLIs, never here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goldenItems, sampleCorpus, itemsDigest, toReference } from '../scripts/parity-items.mjs';

const corpus = Array.from({ length: 50 }, (_, i) => ({
  key: `k${i}`,
  prompt: `prompt ${i}`.repeat((i % 3) + 1),
  prev: `prev ${i}`,
  snip: `snip ${i}`,
}));

test('goldenItems maps prev/snip to the classify context and keeps the key', () => {
  const [a] = goldenItems([
    { key: 'g1', prompt: 'hello', prev: 'before', snip: 'answer', truth_v2: 'simple' },
  ]);
  assert.deepEqual(a, {
    key: 'g1',
    prompt: 'hello',
    context: { previousUserMessage: 'before', lastAssistantSnippet: 'answer' },
  });
});

test('sampleCorpus draws the same keys for the same seed and never repeats one', () => {
  const a = sampleCorpus(corpus, 20, 42).map((x) => x.key);
  const b = sampleCorpus(corpus, 20, 42).map((x) => x.key);
  const c = sampleCorpus(corpus, 20, 7).map((x) => x.key);
  assert.equal(a.length, 20);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(new Set(a).size, 20);
});

test('sampleCorpus caps prompts at 2500 characters, as the spike did', () => {
  const long = [{ key: 'x', prompt: 'a'.repeat(9000), prev: '', snip: '' }];
  const [item] = sampleCorpus(long, 1, 1);
  assert.equal(item.prompt.length, 2500);
});

test('itemsDigest changes when any item changes, so a reference cannot be paired with other items', () => {
  const items = goldenItems([{ key: 'g1', prompt: 'a', prev: '', snip: '' }]);
  const changed = goldenItems([{ key: 'g1', prompt: 'b', prev: '', snip: '' }]);
  assert.notEqual(itemsDigest(items), itemsDigest(changed));
  assert.equal(
    itemsDigest(items),
    itemsDigest(goldenItems([{ key: 'g1', prompt: 'a', prev: '', snip: '' }]))
  );
});

test('toReference refuses a response set that does not cover every item', () => {
  const items = goldenItems([
    { key: 'g1', prompt: 'a', prev: '', snip: '' },
    { key: 'g2', prompt: 'b', prev: '', snip: '' },
  ]);
  const meta = {
    server: 'mlx',
    url: 'http://127.0.0.1:8089',
    head_sha256: 'h',
    recorded_at: 'now',
  };
  assert.throws(
    () =>
      toReference(items, { g1: { category: 'simple', confidence: 0.9, probabilities: {} } }, meta),
    /g2/
  );
});
