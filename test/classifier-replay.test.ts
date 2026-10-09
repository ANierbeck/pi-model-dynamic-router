// Replay harness (docs/plans/2026-10-08-classifier-decision-log.md, Phase 3):
// build a corpus of real prompts (decision-log records with stored text +
// backfilled session files) and compare a candidate classifier (e.g. a local
// Laya service) against the KNOWN classifier's recorded decisions — the
// offline, fair comparison the shadow mode will later produce live.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  extractSessionPrompts,
  readDecisionRecords,
  buildCorpus,
  replayAgainstEndpoint,
} from '../scripts/classifier-replay.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'replay-'));

const sessionLine = (obj: unknown) => JSON.stringify(obj);
const userMsg = (ts: string, text: string, extra: Record<string, unknown> = {}) =>
  sessionLine({ type: 'message', timestamp: ts, message: { role: 'user', content: [{ type: 'text', text }] }, ...extra });

describe('session backfill reader', () => {
  it('extracts user messages in order, skipping everything else', () => {
    const d = dir();
    const f = join(d, '2026-10-08T10-00-00-000Z_test.jsonl');
    writeFileSync(
      f,
      [
        sessionLine({ type: 'session', version: 1, id: 's1', timestamp: '2026-10-08T10:00:00Z', cwd: '/x' }),
        sessionLine({ type: 'model_change', timestamp: '2026-10-08T10:00:01Z' }),
        userMsg('2026-10-08T10:00:02Z', 'Fix the flaky test in provider-breaker'),
        sessionLine({ type: 'message', timestamp: '2026-10-08T10:00:03Z', message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }] } }),
        userMsg('2026-10-08T10:01:00Z', 'Und jetzt bitte die Doku dazu'),
      ].join('\n') + '\n',
    );
    const prompts = extractSessionPrompts([f]);
    expect(prompts.map((p) => p.text)).toEqual([
      'Fix the flaky test in provider-breaker',
      'Und jetzt bitte die Doku dazu',
    ]);
    expect(prompts[0].ts).toBe('2026-10-08T10:00:02Z');
    expect(prompts[0].source).toContain('2026-10-08T10-00-00-000Z_test.jsonl');
    rmSync(d, { recursive: true, force: true });
  });

  it('joins multiple text blocks and flags attachment-like content', () => {
    const d = dir();
    const f = join(d, 'a.jsonl');
    writeFileSync(
      f,
      userMsg('2026-10-08T10:00:00Z', 'first part ', {}) &&
        [
          sessionLine({
            type: 'message',
            timestamp: '2026-10-08T10:00:00Z',
            message: { role: 'user', content: [
              { type: 'text', text: 'part one ' },
              { type: 'text', text: 'part two' },
            ] },
          }),
          sessionLine({
            type: 'message',
            timestamp: '2026-10-08T10:00:01Z',
            message: { role: 'user', content: [
              { type: 'file', path: '/tmp/review-prompt.md' },
              { type: 'text', text: 'You are a code reviewer' },
            ] },
          }),
        ].join('\n') + '\n',
    );
    const prompts = extractSessionPrompts([f]);
    expect(prompts[0].text).toBe('part one part two');
    expect(prompts[0].hasAttachment).toBe(false);
    expect(prompts[1].hasAttachment).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });

  it('skips malformed lines without failing the whole file', () => {
    const d = dir();
    const f = join(d, 'b.jsonl');
    writeFileSync(f, ['not json at all', userMsg('2026-10-08T10:00:00Z', 'survives'), ''].join('\n') + '\n');
    expect(extractSessionPrompts([f]).map((p) => p.text)).toEqual(['survives']);
    rmSync(d, { recursive: true, force: true });
  });
});

describe('decision-log corpus', () => {
  it('reads records, skips malformed lines, keeps full-text records only for the corpus', () => {
    const d = dir();
    const f = join(d, 'decisions.jsonl');
    const rec = (over: Record<string, unknown>) =>
      JSON.stringify({
        v: 1, ts: '2026-10-08T10:00:00Z', proc: 'p/1', stage: 'llm-cloud',
        answered_by: 'cloud:a/b', chain: [], cache_origin: null,
        raw: { category: 'code_complex', confidence: 0.8, reason: null },
        final: { category: 'code_complex', group: 'tactical', hint: null, reason: null },
        steps: [], ms: 500,
        input: { chars: 30, words: 5, sha: 'abc123def456', text: { prompt: 'please refactor the retry loop now' }, context: { hasContextBlock: false, lastCategory: null, isCompaction: false, hasHistory: false } },
        ...over,
      });
    writeFileSync(
      f,
      [
        rec({}),
        'garbage {',
        rec({ input: { chars: 1, words: 1, sha: '000', text: null, context: {} } }),
        rec({ final: { category: 'design', group: 'planning', hint: null, reason: null }, input: { chars: 20, words: 3, sha: 'bbb', text: { prompt: 'design the new api surface' }, context: { hasContextBlock: false, lastCategory: null, isCompaction: false, hasHistory: false } } }),
      ].join('\n') + '\n',
    );
    const records = readDecisionRecords([f]);
    expect(records).toHaveLength(3);
    const corpus = buildCorpus({ records });
    expect(corpus).toHaveLength(2);
    expect(corpus[0]).toMatchObject({ prompt: 'please refactor the retry loop now', knownCategory: 'code_complex', knownGroup: 'tactical' });
    rmSync(d, { recursive: true, force: true });
  });

  it('carries the stored context texts into the corpus item (replay input parity)', () => {
    const d = dir();
    const f = join(d, 'decisions.jsonl');
    writeFileSync(
      f,
      JSON.stringify({
        v: 1, ts: '2026-10-08T10:00:00Z', proc: 'p/1', stage: 'llm-cloud', answered_by: null, chain: [], cache_origin: null,
        raw: null, final: { category: 'planning', group: 'planning', hint: null, reason: null }, steps: [], ms: 1,
        input: { chars: 9, words: 2, sha: 'x', text: { prompt: 'and then?', previousUserMessage: 'plan the rollout', lastAssistantSnippet: 'Here is the plan' }, context: {} },
      }) + '\n',
    );
    const [item] = buildCorpus({ records: readDecisionRecords([f]) });
    expect(item.context).toEqual({ previousUserMessage: 'plan the rollout', lastAssistantSnippet: 'Here is the plan' });
    rmSync(d, { recursive: true, force: true });
  });

  it('dedupes repeated prompts (subagent fan-out) keeping the first record', () => {
    const d = dir();
    const f = join(d, 'decisions.jsonl');
    const rec = (cat: string, prompt: string) =>
      JSON.stringify({
        v: 1, ts: '2026-10-08T10:00:00Z', proc: 'p/1', stage: 'llm-cloud', answered_by: null, chain: [], cache_origin: null,
        raw: null, final: { category: cat, group: 'tactical', hint: null, reason: null }, steps: [], ms: 1,
        input: { chars: prompt.length, words: 1, sha: 'x', text: { prompt }, context: {} },
      });
    writeFileSync(f, [rec('code_complex', 'dupe prompt'), rec('simple', 'dupe prompt')].join('\n') + '\n');
    const corpus = buildCorpus({ records: readDecisionRecords([f]) });
    expect(corpus).toHaveLength(1);
    expect(corpus[0].knownCategory).toBe('code_complex');
    expect(corpus[0].duplicates).toBe(1);
    rmSync(d, { recursive: true, force: true });
  });
});

describe('replay against a candidate endpoint', () => {
  let server: Server;
  let url = '';
  const corpus = [
    { prompt: 'refactor the retry loop', knownCategory: 'code_complex', knownGroup: 'tactical', source: 'dec', ts: '2026-10-08T10:00:00Z', hasAttachment: false, duplicates: 0 },
    { prompt: 'hallo', knownCategory: 'simple', knownGroup: 'operational', source: 'dec', ts: '2026-10-08T10:00:01Z', hasAttachment: false, duplicates: 0 },
    { prompt: 'banana phone', knownCategory: 'design', knownGroup: 'planning', source: 'dec', ts: '2026-10-08T10:00:02Z', hasAttachment: false, duplicates: 0 },
  ];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { prompt } = JSON.parse(body);
        const reply = (o: unknown, code = 200) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(o));
        };
        if (prompt === 'refactor the retry loop') reply({ category: 'code_complex', confidence: 0.9 });
        else if (prompt === 'hallo') reply({ category: 'simple', confidence: 0.7 });
        else if (prompt === 'banana phone') reply({ category: 'banana', confidence: 0.9 }); // invalid category
        else if (prompt === 'boom') reply({ category: 'error' }, 500);
        else reply({});
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(r));
  });

  it('classifies every item, counts agreement, records every disagreement detail', async () => {
    const result = await replayAgainstEndpoint(corpus, { endpoint: url });
    expect(result.classified).toBe(3);
    expect(result.agree).toBe(2);
    expect(result.disagreements).toHaveLength(1);
    expect(result.disagreements[0]).toMatchObject({
      prompt: 'banana phone',
      knownCategory: 'design',
      candidateCategory: 'banana',
      invalidCategory: true,
    });
  });

  it('an endpoint error on one item is counted, not fatal', async () => {
    const result = await replayAgainstEndpoint(
      [{ prompt: 'boom', knownCategory: 'simple', knownGroup: 'operational', source: 'dec', ts: 't', hasAttachment: false, duplicates: 0 }],
      { endpoint: url },
    );
    expect(result.errors).toBe(1);
    expect(result.disagreements).toHaveLength(0);
  });

  it('sends the expected contract body (prompt only at minimum)', async () => {
    let seen: any;
    const probe = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen = { method: req.method, url: req.url, body: JSON.parse(body) };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ category: 'simple' }));
      });
    });
    await new Promise<void>((r) => probe.listen(0, r));
    const u = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;
    await replayAgainstEndpoint(
      [{ prompt: 'contract probe', knownCategory: 'simple', knownGroup: 'operational', source: 'dec', ts: 't', hasAttachment: false, duplicates: 0 }],
      { endpoint: u },
    );
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/classify');
    expect(seen.body).toEqual({ prompt: 'contract probe' });
    await new Promise<void>((r) => probe.close(r));
  });

  it('sends context only when the corpus item has one', async () => {
    const seen: any[] = [];
    const probe = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ category: 'simple' }));
      });
    });
    await new Promise<void>((r) => probe.listen(0, r));
    const u = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;
    const base = { knownCategory: 'simple', knownGroup: 'operational', source: 'dec', ts: 't', hasAttachment: false, duplicates: 0 };
    await replayAgainstEndpoint(
      [
        { ...base, prompt: 'with ctx', context: { previousUserMessage: 'prev', lastAssistantSnippet: 'snip' } },
        { ...base, prompt: 'without ctx' },
      ],
      { endpoint: u, concurrency: 1 },
    );
    expect(seen).toEqual([
      { prompt: 'with ctx', context: { previousUserMessage: 'prev', lastAssistantSnippet: 'snip' } },
      { prompt: 'without ctx' },
    ]);
    await new Promise<void>((r) => probe.close(r));
  });
});
