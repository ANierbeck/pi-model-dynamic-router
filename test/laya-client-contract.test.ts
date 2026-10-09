// test/laya-client-contract.test.ts
//
// Contract between the router's Laya client and the HTTP wrapper
// (spikes/laya-http/server.py, later contrib/laya-sidecar/):
//
//   POST <endpoint>/classify  {prompt, context?: {previousUserMessage?, lastAssistantSnippet?}}
//
// The stub below mirrors the wrapper's strictness: every path except
// /classify is a 404, and only the nested `context` object is read. Earlier
// client tests used a permissive stub that accepted any path and any body
// shape, so they could not notice that the default endpoint (a base URL)
// 404'd against the real wrapper and that the context was sent in a shape
// the wrapper ignores.

import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { classifyWithLayaRaw, truncatePromptForLaya, layaPromptBudgetChars } from '../src/laya-classifier.ts';

interface Captured {
  path: string | undefined;
  body: any;
}

let server: http.Server | null = null;
let captured: Captured[] = [];

async function startWrapperStub(): Promise<string> {
  captured = [];
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/classify') {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const body = JSON.parse(raw);
      captured.push({ path: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ category: 'simple', confidence: 0.9, probabilities: { simple: 0.9 }, ms: 3 }));
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});

describe('laya client ↔ wrapper contract', () => {
  it('appends /classify to the base-URL endpoint (the shipped default is a base URL)', async () => {
    const base = await startWrapperStub();
    const res = await classifyWithLayaRaw('hello world', undefined, base, 1000);
    expect(res.category).toBe('simple');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.path).toBe('/classify');
  });

  it('tolerates a trailing slash on the endpoint', async () => {
    const base = await startWrapperStub();
    await classifyWithLayaRaw('hello world', undefined, `${base}/`, 1000);
    expect(captured[0]!.path).toBe('/classify');
  });

  it('sends the context as a nested object and keeps the prompt free of the context block', async () => {
    const base = await startWrapperStub();
    await classifyWithLayaRaw(
      'fix the failing test',
      { previousUserMessage: 'run the suite', lastAssistantSnippet: '3 failures' },
      base,
      1000,
    );
    const body = captured[0]!.body;
    expect(body.context).toEqual({ previousUserMessage: 'run the suite', lastAssistantSnippet: '3 failures' });
    // The wrapper builds the context block itself — a block already embedded in
    // the prompt would appear twice in the model input.
    expect(body.prompt).toBe('fix the failing test');
    expect(body).not.toHaveProperty('previousUserMessage');
    expect(body).not.toHaveProperty('lastAssistantSnippet');
  });

  it('omits `context` entirely when there is none', async () => {
    const base = await startWrapperStub();
    await classifyWithLayaRaw('hello world', undefined, base, 1000);
    expect(captured[0]!.body).not.toHaveProperty('context');
  });
});

describe('laya prompt truncation (emergency brake, wrapper is exact)', () => {
  const budget = () => layaPromptBudgetChars();

  it('derives the budget from the question head — the head eats part of the window', () => {
    // 1,024 tokens * 3 chars minus the instructions + 9 criteria that are part of every input.
    expect(budget()).toBeGreaterThan(500);
    expect(budget()).toBeLessThan(1024 * 3);
  });

  it('returns a prompt that fits untouched', () => {
    const prompt = 'x'.repeat(budget() - 10);
    expect(truncatePromptForLaya(prompt, undefined)).toBe(prompt);
  });

  it('uses the whole budget when it has to cut — not a fixed 2×256', () => {
    const prompt = 'H'.repeat(5000) + 'T'.repeat(5000);
    const out = truncatePromptForLaya(prompt, undefined);
    expect(out.length).toBeLessThanOrEqual(budget());
    expect(out.length).toBeGreaterThan(budget() - 8); // within a few chars of the budget
    expect(out.startsWith('HHH')).toBe(true);
    expect(out.endsWith('TTT')).toBe(true);
    expect(out).toContain('[... TRUNCATED ...]');
  });

  it('leaves room for the context block the wrapper adds', () => {
    const ctx = { previousUserMessage: 'p'.repeat(500), lastAssistantSnippet: 'a'.repeat(500) };
    const out = truncatePromptForLaya('z'.repeat(20000), ctx);
    // buildContextBlock caps at 120 + 150 chars plus its fixed labels.
    expect(out.length).toBeLessThan(budget() - 270);
    expect(out.length).toBeGreaterThan(budget() - 600);
  });

  it('never returns more than it was given on a degenerate budget', () => {
    expect(truncatePromptForLaya('abcdefghij', undefined, 0)).toBe('');
    expect(truncatePromptForLaya('abcdefghij', undefined, 1).length).toBeLessThanOrEqual(10);
  });
});
