// test/laya-chain.test.ts
//
// The Laya stage inside classifyPrompt, end to end: real classifyPrompt, real
// laya-classifier, a real HTTP stub that is as strict as the wrapper
// (POST /classify only). Only the Ollama HTTP client is mocked — it stands for
// "the rest of the chain".
//
// Chain order under test: HINT / compaction / momentum / cache (deterministic)
// → Laya (active) → cloud/ollama → static. In `shadow` mode Laya runs and is
// logged but never decides.
//
// An earlier version of this file mocked isLayaAvailable() and
// classifyWithLaya() and therefore verified only the mock: it could not see
// that the stage never probed the sidecar, ignored `mode`, and used the wrong
// URL. Every test uses a UNIQUE prompt (module-level classification cache).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { classifyPrompt, getLastClassificationSource } from '../src/content-classifier.ts';
import { callOllama, isOllamaAvailable } from '../src/ollama-utils.ts';
import { resetLayaAvailability } from '../src/laya-classifier.ts';
import type { Config } from '../src/types.ts';

vi.mock('../src/ollama-utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ollama-utils.ts')>();
  return { ...actual, callOllama: vi.fn(), isOllamaAvailable: vi.fn() };
});

const CKPT = 'test/ckpt';
const logFile = () => join(homedir(), '.pi', 'logs', 'classifier-decisions.jsonl');
const records = (): any[] =>
  existsSync(logFile())
    ? readFileSync(logFile(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];

let server: http.Server;
let port = 0;
let stubStatus = 200;
let stubAnswer: Record<string, unknown> = {};
/** Bodies of every classification request (probe excluded), in order. */
let bodies: any[] = [];

const FOX = 'quick brown fox';

function cfg(layaOverrides: Record<string, unknown> | null = {}): Config {
  return {
    providers: {},
    model_groups: {},
    model_metrics: {},
    classifier_log: { enabled: true, store_text: 'none' },
    ...(layaOverrides === null
      ? {}
      : {
          classifier_laya: {
            enabled: true,
            checkpoint: CKPT,
            endpoint: `http://127.0.0.1:${port}`,
            timeout_ms: 800,
            confidence_threshold: 0.8,
            mode: 'active',
            ...layaOverrides,
          },
        }),
  } as unknown as Config;
}

const ollamaSays = (category: string) =>
  vi.mocked(callOllama).mockResolvedValue(JSON.stringify({ category, reason: 'from ollama', confidence: 0.9 }));

const run = (prompt: string, config: Config, extra: Record<string, unknown> = {}) =>
  classifyPrompt(prompt, { cfg: config, model: 'gemma-primary', timeoutMs: 1000, ...extra } as any);

beforeEach(async () => {
  rmSync(join(homedir(), '.pi'), { recursive: true, force: true });
  vi.clearAllMocks();
  resetLayaAvailability();
  stubStatus = 200;
  bodies = [];
  stubAnswer = { category: 'design', confidence: 0.95, probabilities: { design: 0.95, planning: 0.03 }, ms: 4 };
  vi.mocked(isOllamaAvailable).mockResolvedValue(true);
  ollamaSays('simple');
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/classify') {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = JSON.parse(raw);
      if (!String(body.prompt).includes(FOX)) bodies.push(body);
      res.writeHead(stubStatus, { 'content-type': 'application/json' });
      res.end(stubStatus === 200 ? JSON.stringify(stubAnswer) : 'boom');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('active mode', () => {
  it('a confident Laya answer decides, before the cloud/ollama legs are touched', async () => {
    const r = await run('Draft the module boundaries for the billing service alpha', cfg());
    expect(r).toMatchObject({ category: 'design', confidence: 0.95 });
    expect((r as any).reason).toContain('design (95%)');
    expect(callOllama).not.toHaveBeenCalled();
    expect(bodies).toHaveLength(1);
    expect(getLastClassificationSource()?.source).toBe(`laya:${CKPT}`);
  });

  it('forwards the conversation context nested, never embedded in the prompt', async () => {
    await run('Draft the module boundaries for the billing service beta', cfg(), {
      context: { previousUserMessage: 'we use postgres', lastAssistantSnippet: 'noted' },
    });
    expect(bodies[0].context).toEqual({ previousUserMessage: 'we use postgres', lastAssistantSnippet: 'noted' });
    expect(bodies[0].prompt).toBe('Draft the module boundaries for the billing service beta');
  });

  it('low confidence falls through to the next stage — not to `fallback`', async () => {
    stubAnswer = { category: 'design', confidence: 0.41, probabilities: { design: 0.41, planning: 0.3 }, ms: 4 };
    const r = await run('Draft the module boundaries for the billing service gamma', cfg());
    expect(bodies).toHaveLength(1); // Laya was asked …
    expect(callOllama).toHaveBeenCalled(); // … and the chain went on
    expect(r).toMatchObject({ category: 'simple' });
  });

  it('a confident `fallback` answer falls through as well', async () => {
    stubAnswer = { category: 'fallback', confidence: 0.99, probabilities: { fallback: 0.99 }, ms: 4 };
    const r = await run('Draft the module boundaries for the billing service delta', cfg());
    expect(callOllama).toHaveBeenCalled();
    expect(r).toMatchObject({ category: 'simple' });
  });

  it('a down sidecar is transparent: the chain answers as without Laya', async () => {
    stubStatus = 500;
    const r = await run('Draft the module boundaries for the billing service epsilon', cfg());
    expect(callOllama).toHaveBeenCalled();
    expect(r).toMatchObject({ category: 'simple' });
  });
});

describe('what Laya never sees', () => {
  it('HINT prompts are resolved deterministically first', async () => {
    const r = await run('HINT: use group tactical\nfix the zeta typo', cfg());
    expect(bodies).toHaveLength(0);
    expect(r).toHaveProperty('hintType', 'group');
  });

  it('short continuations inherit the previous category (momentum) without Laya', async () => {
    const r = await run('ok do it', cfg(), { context: { lastCategory: 'code_complex' } });
    expect(bodies).toHaveLength(0);
    expect(r).toMatchObject({ category: 'code_complex' });
  });

  it('with the stage disabled or absent the chain is untouched', async () => {
    for (const [i, c] of [cfg({ enabled: false }), cfg(null)].entries()) {
      const r = await run(`Draft the module boundaries for the billing service eta ${i}`, c);
      expect(r).toMatchObject({ category: 'simple' });
    }
    expect(bodies).toHaveLength(0);
  });
});

describe('shadow mode — observe, never decide', () => {
  it.each([['shadow'], [undefined]])('mode %s: the chain decides, Laya is only logged', async (mode) => {
    const r = await run(`Draft the module boundaries for the billing service theta ${mode}`, cfg({ mode }));
    expect(bodies).toHaveLength(1); // Laya ran …
    expect(callOllama).toHaveBeenCalled(); // … the real chain decided
    expect(r).toMatchObject({ category: 'simple' });
    const [rec] = records();
    expect(rec.stage).toBe('llm-local');
    expect(rec.laya).toMatchObject({ ref: `laya:${CKPT}`, category: 'design', confidence: 0.95, acted: false });
    expect(typeof rec.laya.ms).toBe('number');
  });

  it('records the answer even when it would have fallen through', async () => {
    stubAnswer = { category: 'planning', confidence: 0.31, probabilities: { planning: 0.31, design: 0.3 }, ms: 4 };
    await run('Draft the module boundaries for the billing service iota', cfg({ mode: 'shadow' }));
    expect(records()[0].laya).toMatchObject({ category: 'planning', confidence: 0.31, acted: false });
  });
});

describe('decision log', () => {
  it('an active answer is stage `laya` with the checkpoint as answered_by', async () => {
    await run('Draft the module boundaries for the billing service kappa', cfg());
    const [rec] = records();
    expect(rec).toMatchObject({ stage: 'laya', answered_by: `laya:${CKPT}` });
    expect(rec.raw).toMatchObject({ category: 'design', confidence: 0.95 });
    expect(rec.chain.map((a: any) => [a.ref, a.outcome])).toEqual([[`laya:${CKPT}`, 'ok']]);
    expect(rec.laya).toMatchObject({ category: 'design', acted: true });
  });

  it('records without a Laya stage carry no `laya` field', async () => {
    await run('Draft the module boundaries for the billing service lambda', cfg(null));
    expect(records()[0]).not.toHaveProperty('laya');
  });
});
