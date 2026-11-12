// Item sets and reference records for the parity gate. Pure: no file or network I/O.
import { createHash } from 'node:crypto';

export const CORPUS_PROMPT_CAP = 2500;

/** Golden items: owner-rated rows of golden.jsonl, context from prev/snip (as build_state in server.py). */
export function goldenItems(rows) {
  return rows.map((r) => ({
    key: r.key,
    prompt: r.prompt,
    context: { previousUserMessage: r.prev, lastAssistantSnippet: r.snip },
  }));
}

// mulberry32: small seeded PRNG so the sample is the same on every run.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Corpus sample: n distinct rows drawn with a fixed seed; prompts capped as in the spike. */
export function sampleCorpus(rows, n, seed) {
  const idx = rows.map((_, i) => i);
  const rnd = prng(seed);
  for (let i = idx.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, n).map((i) => {
    const r = rows[i];
    return {
      key: r.key,
      prompt: r.prompt.slice(0, CORPUS_PROMPT_CAP),
      context: { previousUserMessage: r.prev, lastAssistantSnippet: r.snip },
    };
  });
}

/** sha256 over the ordered item set; a reference is only valid for the items it was recorded on. */
export function itemsDigest(items) {
  return createHash('sha256').update(JSON.stringify(items), 'utf8').digest('hex');
}

/**
 * Build the reference record from the server's answers. Refuses a partial answer set: a missing
 * item would silently shrink the gate's denominator.
 */
export function toReference(items, answers, meta) {
  const missing = items.filter((it) => !answers[it.key]).map((it) => it.key);
  if (missing.length > 0) {
    throw new Error(
      `no answer for ${missing.length} item(s), first: ${missing.slice(0, 5).join(', ')}`
    );
  }
  const out = {};
  for (const it of items) out[it.key] = answers[it.key];
  return { meta: { ...meta, items_sha256: itemsDigest(items), count: items.length }, items: out };
}
