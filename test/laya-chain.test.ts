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
import { resetLayaAvailability, TIMEOUT_STRIKES_BEFORE_DOWN } from '../src/laya-classifier.ts';
import { headSha256 } from '../src/laya-model-manifest.ts';
import { LAYA_HEAD_V2_INSTRUCTIONS, VALID_CATEGORIES } from '../src/classification-prompt.ts';
import * as loggerModule from '../src/logger.ts';
import type { Config } from '../src/types.ts';

vi.mock('../src/ollama-utils.ts', async (importOriginal) =>
  (await import('./helpers/ollama-mock.ts')).ollamaMockPatched(await importOriginal())
);

const CKPT = 'test/ckpt';
const logFile = () => join(homedir(), '.pi', 'logs', 'classifier-decisions.jsonl');
const records = (): any[] =>
  existsSync(logFile())
    ? readFileSync(logFile(), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

let server: http.Server;
let port = 0;
let stubStatus = 200;
/** When set, classification requests (not the probe) are held until the client gives up. */
let stubHang = false;
let stubAnswer: Record<string, unknown> = {};
/** Replaces the response for requests it returns a value for (probe included when it says so). */
/** GET /health answer; null = the pre-artifact wrapper, which has no /health (404). */
let stubHealth: Record<string, unknown> | null = null;
let stubOverride: ((isProbe: boolean) => { status: number; body: string } | null) | null = null;
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
  vi
    .mocked(callOllama)
    .mockResolvedValue(JSON.stringify({ category, reason: 'from ollama', confidence: 0.9 }));

const run = (prompt: string, config: Config, extra: Record<string, unknown> = {}) =>
  classifyPrompt(prompt, { cfg: config, model: 'gemma-primary', timeoutMs: 1000, ...extra } as any);

beforeEach(async () => {
  rmSync(join(homedir(), '.pi'), { recursive: true, force: true });
  vi.clearAllMocks();
  resetLayaAvailability();
  stubStatus = 200;
  stubHang = false;
  stubOverride = null;
  stubHealth = null;
  bodies = [];
  stubAnswer = {
    category: 'design',
    confidence: 0.95,
    probabilities: { design: 0.95, planning: 0.03 },
    ms: 4,
  };
  vi.mocked(isOllamaAvailable).mockResolvedValue(true);
  ollamaSays('simple');
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/health' && stubHealth) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(stubHealth));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/classify') {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = JSON.parse(raw);
      if (!String(body.prompt).includes(FOX)) bodies.push(body);
      if (stubHang && !String(body.prompt).includes(FOX)) return; // the client aborts at timeout_ms
      const over = stubOverride?.(String(body.prompt).includes(FOX));
      if (over) {
        res.writeHead(over.status, { 'content-type': 'application/json' });
        res.end(over.body);
        return;
      }
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
    expect(bodies[0].context).toEqual({
      previousUserMessage: 'we use postgres',
      lastAssistantSnippet: 'noted',
    });
    expect(bodies[0].prompt).toBe('Draft the module boundaries for the billing service beta');
  });

  it('low confidence falls through to the next stage — not to `fallback`', async () => {
    stubAnswer = {
      category: 'design',
      confidence: 0.41,
      probabilities: { design: 0.41, planning: 0.3 },
      ms: 4,
    };
    const r = await run('Draft the module boundaries for the billing service gamma', cfg());
    expect(bodies).toHaveLength(1); // Laya was asked …
    expect(callOllama).toHaveBeenCalled(); // … and the chain went on
    expect(r).toMatchObject({ category: 'simple' });
  });

  it('a confident `fallback` answer falls through as well', async () => {
    stubAnswer = {
      category: 'fallback',
      confidence: 0.99,
      probabilities: { fallback: 0.99 },
      ms: 4,
    };
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

describe('a sidecar that exceeds timeout_ms (plan 2026-10-25-laya-sole-classifier, step 4)', () => {
  it('is transparent: the chain decides this prompt, nothing is logged for Laya, no comparator', async () => {
    stubHang = true;
    const r = await run(
      'Draft the module boundaries for the billing service hang-one',
      cfg({ timeout_ms: 150, compare_in_background: true })
    );
    expect(callOllama).toHaveBeenCalled();
    expect(r).toMatchObject({ category: 'simple' });
    await new Promise((res) => setTimeout(res, 100)); // a detached comparator would land here
    const stages = records().map((rec) => rec.stage);
    expect(stages).not.toContain('laya');
    expect(stages).not.toContain('comparator');
  });

  it('is not an outage: the very next prompt is decided by Laya again', async () => {
    stubHang = true;
    await run(
      'Draft the module boundaries for the billing service hang-two',
      cfg({ timeout_ms: 150 })
    );
    stubHang = false;
    const next = await run(
      'Draft the module boundaries for the billing service hang-three',
      cfg({ timeout_ms: 150 })
    );
    expect(next).toMatchObject({ category: 'design' });
    expect(getLastClassificationSource()?.source).toBe(`laya:${CKPT}`);
  });
});

// plan 2026-11-08-laya-model-artifact.md, Solution 5: the label names what the
// sidecar SERVES, not what the user typed — the owner's own config named the
// base HF checkpoint while the sidecar served the fine-tuned r2 (Problem 2).
describe('identity: the label comes from /health, the configured string is the fallback', () => {
  const routerHead = headSha256({
    instructions: LAYA_HEAD_V2_INSTRUCTIONS,
    categories: [...VALID_CATEGORIES],
  });
  const reports = (extra: Record<string, unknown> = {}) =>
    (stubHealth = {
      status: 'ok',
      model: 'r9',
      version: '1.0.0',
      backend: 'onnx',
      head_sha256: routerHead,
      ...extra,
    });

  it('a reporting sidecar names the model in the source, the chain and the decision log', async () => {
    reports();
    await run('Draft the module boundaries for the billing service id-1', cfg());
    expect(getLastClassificationSource()?.source).toBe('laya:r9@1.0.0');
    const [rec] = records();
    expect(rec.laya).toMatchObject({ ref: 'laya:r9@1.0.0', identity: 'reported' });
    expect(rec.chain[0]).toMatchObject({ ref: 'laya:r9@1.0.0', outcome: 'ok' });
  });

  it('shadow mode logs the reported identity too', async () => {
    reports();
    await run('Draft the module boundaries for the billing service id-2', cfg({ mode: 'shadow' }));
    expect(records()[0].laya).toMatchObject({ ref: 'laya:r9@1.0.0', identity: 'reported' });
  });

  it('without /health the configured checkpoint is the label, and the record says so', async () => {
    await run('Draft the module boundaries for the billing service id-3', cfg());
    expect(getLastClassificationSource()?.source).toBe(`laya:${CKPT}`);
    expect(records()[0].laya).toMatchObject({ ref: `laya:${CKPT}`, identity: 'configured' });
  });

  it('a /health without a usable model@version falls back to the configured label', async () => {
    reports({ model: '../escape' });
    await run('Draft the module boundaries for the billing service id-4', cfg());
    expect(records()[0].laya).toMatchObject({ ref: `laya:${CKPT}`, identity: 'configured' });
  });

  it('a head mismatch is warned once per probe, not per prompt — and the stage still decides', async () => {
    const warn = vi.spyOn(loggerModule, 'warnLog');
    try {
      reports({ head_sha256: 'e'.repeat(64) });
      await run('Draft the module boundaries for the billing service id-5', cfg());
      await run('Draft the module boundaries for the billing service id-6', cfg());
      const headWarnings = warn.mock.calls.filter(([m]) => String(m).includes('head'));
      expect(headWarnings).toHaveLength(1);
      expect(String(headWarnings[0]![0])).toContain('r9@1.0.0');
      expect(getLastClassificationSource()?.source).toBe('laya:r9@1.0.0');
    } finally {
      warn.mockRestore();
    }
  });

  it('a matching head is not warned about', async () => {
    const warn = vi.spyOn(loggerModule, 'warnLog');
    try {
      reports();
      await run('Draft the module boundaries for the billing service id-7', cfg());
      expect(warn.mock.calls.filter(([m]) => String(m).includes('head'))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('a re-probe re-reads the identity: a sidecar restarted without /health loses the label', async () => {
    reports();
    await run('Draft the module boundaries for the billing service id-8', cfg());
    expect(getLastClassificationSource()?.source).toBe('laya:r9@1.0.0');
    stubHealth = null;
    resetLayaAvailability(); // what the TTL expiry does
    await run('Draft the module boundaries for the billing service id-9', cfg());
    expect(getLastClassificationSource()?.source).toBe(`laya:${CKPT}`);
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
  it.each([['shadow'], [undefined]])(
    'mode %s: the chain decides, Laya is only logged',
    async (mode) => {
      const r = await run(
        `Draft the module boundaries for the billing service theta ${mode}`,
        cfg({ mode })
      );
      expect(bodies).toHaveLength(1); // Laya ran …
      expect(callOllama).toHaveBeenCalled(); // … the real chain decided
      expect(r).toMatchObject({ category: 'simple' });
      const [rec] = records();
      expect(rec.stage).toBe('llm-local');
      expect(rec.laya).toMatchObject({
        ref: `laya:${CKPT}`,
        category: 'design',
        confidence: 0.95,
        acted: false,
      });
      expect(typeof rec.laya.ms).toBe('number');
    }
  );

  it('records the answer even when it would have fallen through', async () => {
    stubAnswer = {
      category: 'planning',
      confidence: 0.31,
      probabilities: { planning: 0.31, design: 0.3 },
      ms: 4,
    };
    await run('Draft the module boundaries for the billing service iota', cfg({ mode: 'shadow' }));
    expect(records()[0].laya).toMatchObject({
      category: 'planning',
      confidence: 0.31,
      acted: false,
    });
  });
});

// Live A/B snapshot (owner decision 2026-10-25): Laya at the wheel in active
// mode, and — when `compare_in_background` is set — the cloud/ollama chain it
// replaced still runs detached, writing its own `comparator` decision-log
// record for the same input. Same live traffic, both answers, zero added
// latency on the hot path (the record is best-effort: if the process exits
// first, the log simply lacks that record).
describe('active mode + background comparator (compare_in_background)', () => {
  const waitFor = async (cond: () => boolean, ms = 2000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error('timeout waiting for the comparator record');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it('Laya decides; the chain answer arrives as a separate `comparator` record', async () => {
    const r = await run(
      'Draft the module boundaries for the billing service xi',
      cfg({ compare_in_background: true })
    );
    expect(r).toMatchObject({ category: 'design' });
    await waitFor(() => records().some((rec) => rec.stage === 'comparator'));
    const recs = records();
    expect(recs).toHaveLength(2);
    const main = recs.find((rec) => rec.stage === 'laya');
    const cmp = recs.find((rec) => rec.stage === 'comparator');
    expect(main.final.category).toBe('design'); // Laya at the wheel
    expect(main.answered_by).toBe(`laya:${CKPT}`);
    // The chain it replaced said `simple` — logged, never routed.
    expect(cmp.final.category).toBe('simple');
    expect(cmp.answered_by).toBe('ollama:gemma-primary');
    expect(typeof cmp.ms).toBe('number');
    expect(cmp.chain.map((a: any) => a.outcome)).toContain('ok');
    // Same input on both records — that is the pairing key for evaluation.
    expect(cmp.input.sha).toBe(main.input.sha);
    // The detached run must not flip the process-global classification source.
    expect(getLastClassificationSource()?.source).toBe(`laya:${CKPT}`);
  });

  it('the comparator never overwrites the classification cache', async () => {
    const p = 'Draft the module boundaries for the billing service rho';
    await run(p, cfg({ compare_in_background: true }));
    await waitFor(() => records().some((rec) => rec.stage === 'comparator'));
    const r2 = await run(p, cfg({ compare_in_background: true }));
    // Re-run must hit Laya's cached answer, NOT the comparator's cloud/ollama result.
    expect(r2).toMatchObject({ category: 'design' });
    const recs = records().filter((rec) => rec.input.sha === records()[0].input.sha);
    const cacheRec = recs.find((rec) => rec.stage === 'cache');
    expect(cacheRec?.cache_origin).toBe(`laya:${CKPT}`);
    expect(cacheRec?.final.category).toBe('design');
  });

  it('no comparator unless compare_in_background is set', async () => {
    await run('Draft the module boundaries for the billing service sigma', cfg());
    expect(callOllama).not.toHaveBeenCalled();
    expect(records()).toHaveLength(1);
    expect(records()[0].stage).toBe('laya');
  });
});

// Momentum observation (owner go 2026-10-29, plan 2026-10-25-laya-sole-classifier
// step 5): short prompts keep inheriting the previous category — that routing
// is untouched — but with `observe_momentum` Laya and the chain are asked about
// them too, DETACHED, and the answers are logged as non-routing records so the
// owner can see on data whether "ok, do it" after planning should move on.
describe('momentum observation (observe_momentum)', () => {
  const waitFor = async (cond: () => boolean, ms = 2000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error('timeout waiting for the observation records');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const ctx = { context: { lastCategory: 'planning' } };

  it('routing is unchanged: the short prompt still inherits the previous category', async () => {
    const r = await run('ok do it now', cfg({ observe_momentum: true }), ctx);
    expect(r).toMatchObject({
      category: 'planning',
      reason: expect.stringContaining('Short prompt'),
    });
    // Let the detached observation finish before the stub server goes away.
    await waitFor(() => records().some((x) => x.stage === 'observation'));
  });

  it('logs Laya and the chain as observations next to the momentum record, same input.sha', async () => {
    // A usable distribution covers the whole production taxonomy (validLayaDistribution).
    stubAnswer = {
      category: 'design',
      confidence: 0.95,
      probabilities: {
        simple: 0.01,
        code_simple: 0.01,
        standard: 0.01,
        code_complex: 0.01,
        design: 0.95,
        planning: 0.005,
        continue: 0.005,
      },
      ms: 4,
    };
    await run('ok do it please', cfg({ observe_momentum: true, compare_in_background: true }), ctx);
    await waitFor(() => records().some((x) => x.stage === 'observation-comparator'));
    const recs = records();
    const main = recs.find((x) => x.stage === 'momentum');
    const obs = recs.find((x) => x.stage === 'observation');
    const cmp = recs.find((x) => x.stage === 'observation-comparator');
    expect(main.final.category).toBe('planning'); // what was routed
    // What Laya would have said, with the distribution; never acted on.
    expect(obs.laya).toMatchObject({ category: 'design', confidence: 0.95, acted: false });
    expect(obs.laya.probabilities).toBeTruthy();
    expect(obs.final.category).toBe('design');
    expect(obs.prev.category).toBe('planning'); // the context the question was asked in
    expect(cmp.final.category).toBe('simple'); // the chain's answer (ollama stub)
    expect(obs.input.sha).toBe(main.input.sha);
    expect(cmp.input.sha).toBe(main.input.sha);
    // The plain comparator stage stays reserved for acted Laya decisions.
    expect(recs.some((x) => x.stage === 'comparator')).toBe(false);
  });

  it('the detached run never touches the process-global source or the classification cache', async () => {
    await run('ok do it again', cfg({ observe_momentum: true, compare_in_background: true }), ctx);
    await waitFor(() => records().some((x) => x.stage === 'observation-comparator'));
    expect(getLastClassificationSource()?.source).toBe('momentum');
    // No cache entry: the same short prompt without lastCategory goes to Laya fresh, not to a cached observation.
    bodies.length = 0;
    const r = await run('ok do it again', cfg(), {});
    expect(bodies).toHaveLength(1);
    expect(r).toMatchObject({ category: 'design' });
  });

  it('does nothing unless observe_momentum is set', async () => {
    await run('ok do it later', cfg({ compare_in_background: true }), ctx);
    await new Promise((r) => setTimeout(r, 150));
    expect(bodies).toHaveLength(0);
    expect(callOllama).not.toHaveBeenCalled();
    expect(records().map((x) => x.stage)).toEqual(['momentum']);
  });

  it('does not observe prompts that are not momentum prompts', async () => {
    await run(
      'Draft the module boundaries for the billing service upsilon',
      cfg({ observe_momentum: true }),
      ctx
    );
    expect(records().some((x) => x.stage === 'observation')).toBe(false);
  });

  it('does not observe without a previous category (nothing is inherited, the normal chain runs)', async () => {
    await run('ok do it first', cfg({ observe_momentum: true }), {});
    expect(records().some((x) => String(x.stage).startsWith('observation'))).toBe(false);
  });

  it('a broken sidecar neither breaks nor delays the routed answer', async () => {
    stubStatus = 500;
    const r = await run('ok do it broken', cfg({ observe_momentum: true }), ctx);
    expect(r).toMatchObject({ category: 'planning' });
    await new Promise((x) => setTimeout(x, 150));
    expect(records().some((x) => x.stage === 'momentum')).toBe(true);
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

  // Calibration needs the whole distribution, not only the winning label's
  // confidence: temperature / bias fits on owner labels are impossible without it.
  it('logs the full Laya probability distribution alongside the answer', async () => {
    const dist = {
      simple: 0.02,
      code_simple: 0.01,
      standard: 0.05,
      code_complex: 0.06,
      design: 0.6,
      planning: 0.2,
      continue: 0.06,
    };
    stubAnswer = { category: 'design', confidence: 0.6, probabilities: dist, ms: 4 };
    await run('Draft the module boundaries for the billing service mu', cfg({ mode: 'shadow' }));
    const [rec] = records();
    expect(rec.laya.probabilities).toEqual(dist);
  });

  // The distribution feeds calibration fits: a malformed one must not reach the
  // log, while the answer itself is still recorded.
  it('drops a malformed distribution (incomplete labels, value out of range) but keeps the answer', async () => {
    stubAnswer = {
      category: 'design',
      confidence: 0.6,
      probabilities: { design: 1.7, planning: 0.3 },
      ms: 4,
    };
    await run('Draft the module boundaries for the billing service nu', cfg({ mode: 'shadow' }));
    const [rec] = records();
    expect(rec.laya).toMatchObject({ category: 'design', confidence: 0.6 });
    expect(rec.laya.probabilities).toBeUndefined();
  });

  it('records without a Laya stage carry no `laya` field', async () => {
    await run('Draft the module boundaries for the billing service lambda', cfg(null));
    expect(records()[0]).not.toHaveProperty('laya');
  });
});

// Core-only invariant (plan 2026-11-08-optional-integrations-config.md, Solution
// 5; owner decision 2026-11-08: "if it is not there, the default chain
// applies"): a Laya that is disabled, unreachable, failing or too slow must
// leave routing EXACTLY as if the integration did not exist — same results,
// same classification sources, same chain calls, same decision-log trail.
//
// Method: one fixed scenario list runs once with Laya absent (the baseline) and
// once per degraded state; everything is compared against the baseline, so the
// test says "identical to core-only" instead of re-asserting a hand-written
// expectation per state. The states are a table: the next integration adds rows.
//
// Not compared: timestamps, durations and input hashes (they differ per run by
// design); a sidecar that ANSWERS with an unusable category (a vetoed answer,
// not an outage — its record carries the stage's trace on purpose, see
// 'decision log'); `observe_momentum`, whose detached observations may spend a
// chain call by design and so has its own routing-only block.
describe('core-only invariant: a degraded integration is invisible to routing', () => {
  /** A port nothing listens on: bound once, then released. */
  let closedPort = 0;
  beforeEach(async () => {
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    closedPort = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
  });

  /** The classification cache is keyed by prompt text: every run needs prompts no earlier run saw. */
  let runCounter = 0;
  /** Plain prompts reach the stage; more than the strike limit, so a slow sidecar crosses "taken out of service". */
  const PLAIN_PROMPTS = TIMEOUT_STRIKES_BEFORE_DOWN + 2;

  /** Healthy probe, then real requests fail: the realistic "fine at start, broken under load" outage. */
  const afterProbe = (status: number, body: string) => () => {
    stubOverride = (isProbe) => (isProbe ? null : { status, body });
  };

  interface DegradedState {
    name: string;
    layaOverrides: (flags: Record<string, unknown>) => Record<string, unknown>;
    sidecar: () => void;
  }
  const states: DegradedState[] = [
    { name: 'disabled', layaOverrides: (f) => ({ ...f, enabled: false }), sidecar: () => {} },
    {
      name: 'connection refused',
      layaOverrides: (f) => ({ ...f, endpoint: `http://127.0.0.1:${closedPort}` }),
      sidecar: () => {},
    },
    { name: 'HTTP 500', layaOverrides: (f) => f, sidecar: () => (stubStatus = 500) },
    {
      name: 'HTTP 500 after a healthy probe',
      layaOverrides: (f) => f,
      sidecar: afterProbe(500, 'boom'),
    },
    {
      name: 'timeout',
      layaOverrides: (f) => ({ ...f, timeout_ms: 150 }),
      sidecar: () => (stubHang = true),
    },
    {
      name: 'unparseable answer',
      layaOverrides: (f) => f,
      sidecar: () => (stubOverride = () => ({ status: 200, body: '<html>not json</html>' })),
    },
    {
      name: 'unparseable answer after a healthy probe',
      layaOverrides: (f) => f,
      sidecar: afterProbe(200, '<html>not json</html>'),
    },
  ];
  const flagSets: [string, Record<string, unknown>][] = [
    ['no flags', {}],
    ['compare_in_background', { compare_in_background: true }],
    ['shadow mode', { mode: 'shadow' }],
  ];

  /** Runs the fixed scenario list and returns everything routing could depend on. */
  async function playScenario(config: Config, sidecar: () => void) {
    const tag = `run${runCounter++}`;
    rmSync(join(homedir(), '.pi'), { recursive: true, force: true });
    vi.clearAllMocks();
    vi.mocked(isOllamaAvailable).mockResolvedValue(true);
    ollamaSays('simple');
    resetLayaAvailability();
    stubStatus = 200;
    stubHang = false;
    stubOverride = null;
    sidecar();

    const play = async (prompt: string, extra: Record<string, unknown> = {}) => ({
      result: await run(prompt, config, extra),
      source: getLastClassificationSource()?.source,
    });
    const outcomes = [];
    for (let i = 0; i < PLAIN_PROMPTS; i++) {
      outcomes.push(await play(`Draft the module boundaries for the billing service ${tag} ${i}`));
    }
    outcomes.push(await play(`HINT: use group tactical\nfix the typo ${tag}`));
    outcomes.push(await play('ok do it', { context: { lastCategory: 'code_complex' } }));
    outcomes.push(
      await play(`Sketch the retry policy for the export worker ${tag}`, {
        context: { previousUserMessage: 'we were talking about the export worker' },
      })
    );
    // A detached comparator or observation would land here; nothing may.
    await new Promise((r) => setTimeout(r, 120));

    return {
      outcomes,
      ollamaCalls: vi.mocked(callOllama).mock.calls.length,
      trail: records().map((rec) => ({
        stage: rec.stage,
        answered_by: rec.answered_by,
        category: rec.final?.category,
        hasLayaTrace: 'laya' in rec,
        chain: (rec.chain ?? []).map((a: any) => ({ ref: a.ref, outcome: a.outcome })),
      })),
    };
  }

  for (const [flagName, flags] of flagSets) {
    for (const state of states) {
      it(`${state.name} (${flagName}) routes exactly like an absent integration`, async () => {
        const baseline = await playScenario(cfg(null), () => {});
        const degraded = await playScenario(cfg(state.layaOverrides(flags)), state.sidecar);
        expect(degraded.outcomes).toEqual(baseline.outcomes);
        expect(degraded.ollamaCalls).toBe(baseline.ollamaCalls);
        expect(degraded.trail).toEqual(baseline.trail);
      });
    }
  }

  // Guards against vacuity: if the baseline were empty or answered by something
  // else, "identical to the baseline" would prove nothing.
  it('the baseline itself is the chain: every plain prompt is answered by ollama', async () => {
    const baseline = await playScenario(cfg(null), () => {});
    expect(baseline.outcomes.slice(0, PLAIN_PROMPTS).map((o) => o.source)).toEqual(
      Array(PLAIN_PROMPTS).fill('ollama:gemma-primary')
    );
    expect(baseline.ollamaCalls).toBeGreaterThanOrEqual(PLAIN_PROMPTS);
    expect(baseline.trail.length).toBeGreaterThanOrEqual(PLAIN_PROMPTS);
  });

  // The mirror image: with a working sidecar the scenarios must differ, or the
  // invariant above could never fail.
  it('a healthy integration is NOT invisible — the comparison can tell the difference', async () => {
    const baseline = await playScenario(cfg(null), () => {});
    const healthy = await playScenario(cfg(), () => {});
    expect(healthy.outcomes).not.toEqual(baseline.outcomes);
    expect(healthy.outcomes[0]?.source).toBe(`laya:${CKPT}`);
  });

  it.each([
    ['connection refused', () => ({ endpoint: `http://127.0.0.1:${closedPort}` }), () => {}],
    ['HTTP 500', () => ({}), () => (stubStatus = 500)],
    ['timeout', () => ({ timeout_ms: 150 }), () => (stubHang = true)],
  ] as const)(
    'observe_momentum, %s: the momentum route is unchanged (the observation is logging only)',
    async (_name, overrides, sidecar) => {
      const baseline = await playScenario(cfg(null), () => {});
      const degraded = await playScenario(cfg({ observe_momentum: true, ...overrides() }), sidecar);
      expect(degraded.outcomes).toEqual(baseline.outcomes);
    }
  );
});
