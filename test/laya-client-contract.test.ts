// test/laya-client-contract.test.ts
//
// Contract between the router's Laya client and the HTTP wrapper
// (spikes/laya-http/server.py, later contrib/laya-sidecar/):
//
//   POST <endpoint>/classify  {prompt, context?: {previousUserMessage?, lastAssistantSnippet?}}
//   GET  <endpoint>/health    {status, model?, version?, backend?, artifact_sha256?, head_sha256?}
//
// /health is optional for the sidecar (plan 2026-11-08-laya-model-artifact.md,
// Solution 5): it reports WHICH artifact is loaded, so the decision log can
// name the model by what the sidecar serves instead of what the user typed.
// A sidecar without it (the pre-artifact wrapper) keeps working unchanged.
//
// The stub below mirrors the wrapper's strictness: every path except
// /classify is a 404, and only the nested `context` object is read. Earlier
// client tests used a permissive stub that accepted any path and any body
// shape, so they could not notice that the default endpoint (a base URL)
// 404'd against the real wrapper and that the context was sent in a shape
// the wrapper ignores.

import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import {
  classifyWithLayaRaw,
  fetchLayaHealth,
  layaReportedIdentity,
  probeLaya,
  resetLayaAvailability,
  truncatePromptForLaya,
  layaPromptBudgetChars,
} from '../src/laya-classifier.ts';

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
      res.end(
        JSON.stringify({
          category: 'simple',
          confidence: 0.9,
          probabilities: { simple: 0.9 },
          ms: 3,
        })
      );
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
      1000
    );
    const body = captured[0]!.body;
    expect(body.context).toEqual({
      previousUserMessage: 'run the suite',
      lastAssistantSnippet: '3 failures',
    });
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
    // 1,024 tokens * 3 chars minus the instructions + 7 criteria that are part of every input.
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

describe('GET /health — the identity the sidecar reports', () => {
  const HEX = (c: string) => c.repeat(64);
  let health: { status: number; body: string; delayMs?: number };
  let classifyDelayMs = 0;
  let hits: { method: string | undefined; url: string | undefined }[];

  async function startHealthStub(): Promise<string> {
    hits = [];
    server = http.createServer((req, res) => {
      hits.push({ method: req.method, url: req.url });
      if (req.method === 'POST' && req.url === '/classify') {
        req.resume();
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              category: 'simple',
              confidence: 0.9,
              probabilities: { simple: 0.9 },
              ms: 1,
            })
          );
        }, classifyDelayMs);
        return;
      }
      if (req.method !== 'GET' || req.url !== '/health') {
        res.writeHead(404);
        res.end();
        return;
      }
      setTimeout(() => {
        res.writeHead(health.status, { 'content-type': 'application/json' });
        res.end(health.body);
      }, health.delayMs ?? 0);
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }

  const full = {
    status: 'ok',
    model: 'r2',
    version: '1.0.0',
    backend: 'onnx',
    artifact_sha256: HEX('a'),
    head_sha256: HEX('b'),
  };

  it('GETs <endpoint>/health and returns every identity field', async () => {
    health = { status: 200, body: JSON.stringify(full) };
    const base = await startHealthStub();
    const res = await fetchLayaHealth(`${base}/`, 1000);
    expect(hits).toEqual([{ method: 'GET', url: '/health' }]);
    expect(res).toEqual({
      ok: true,
      identity: {
        model: 'r2',
        version: '1.0.0',
        backend: 'onnx',
        artifact_sha256: HEX('a'),
        head_sha256: HEX('b'),
      },
    });
  });

  // 501 is what the pre-artifact wrapper (BaseHTTPRequestHandler without do_GET) answers.
  it.each([[404], [501]])(
    'a sidecar without /health (HTTP %i) is not an error, just no identity',
    async (code) => {
      health = { status: code, body: '' };
      const base = await startHealthStub();
      expect(await fetchLayaHealth(base, 1000)).toEqual({ ok: false, why: `HTTP ${code}` });
    }
  );

  it.each([
    ['unparseable JSON', '<html>', 'malformed'],
    ['a status other than ok', JSON.stringify({ ...full, status: 'loading' }), 'status'],
    ['no JSON object', '[1,2]', 'malformed'],
  ])('%s yields no identity', async (_name, body, why) => {
    health = { status: 200, body };
    const base = await startHealthStub();
    const res = await fetchLayaHealth(base, 1000);
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.why).toContain(why);
  });

  it('drops fields it cannot trust, keeps the rest (a label is built from safe names only)', async () => {
    health = {
      status: 200,
      body: JSON.stringify({
        ...full,
        model: '../r2',
        version: 'x'.repeat(200),
        head_sha256: 'ABC',
        artifact_sha256: 42,
      }),
    };
    const base = await startHealthStub();
    expect(await fetchLayaHealth(base, 1000)).toEqual({ ok: true, identity: { backend: 'onnx' } });
  });

  it('gives up at timeoutMs', async () => {
    health = { status: 200, body: JSON.stringify(full), delayMs: 500 };
    const base = await startHealthStub();
    const t0 = Date.now();
    const res = await fetchLayaHealth(base, 80);
    expect(res.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(400);
  });

  // The probe runs inline on the prompt that finds the TTL expired: a slow
  // /health must not add its latency on top of the probe classification.
  it('the probe reads /health in parallel with the probe classification', async () => {
    resetLayaAvailability();
    health = { status: 200, body: JSON.stringify(full), delayMs: 300 };
    classifyDelayMs = 300;
    try {
      const base = await startHealthStub();
      const t0 = Date.now();
      expect(await probeLaya(base, 1000)).toBe(true);
      expect(Date.now() - t0).toBeLessThan(550); // sequential would be >= 600
      expect(layaReportedIdentity()).toMatchObject({ model: 'r2', version: '1.0.0' });
    } finally {
      classifyDelayMs = 0;
      resetLayaAvailability();
    }
  });

  it('never throws on a refused connection', async () => {
    const res = await fetchLayaHealth('http://127.0.0.1:9', 300);
    expect(res.ok).toBe(false);
  });
});
