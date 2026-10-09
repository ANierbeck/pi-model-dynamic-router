// test/laya-lifecycle.test.ts
//
// Availability lifecycle and answer vetting of the Laya stage, exercised
// against a real (counting) HTTP stub — no module mocks. The earlier chain
// tests mocked isLayaAvailable() to true and thereby hid that nothing ever
// probed the sidecar, so in production the stage could not fire.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import * as loggerModule from '../src/logger.ts';
import {
  UNAVAILABLE_TTL_MS,
  classifyWithLaya,
  classifyWithLayaDetailed,
  isLayaAvailable,
  probeLaya,
  resetLayaAvailability,
} from '../src/laya-classifier.ts';
import type { Config } from '../src/types.ts';

const PROBE_PROMPT_MARK = 'quick brown fox';

type Mode = 'ok' | 'http500';
let server: http.Server;
let mode: Mode = 'ok';
let answer: Record<string, unknown> = {};
let requests: string[] = []; // prompts, in arrival order

const isProbe = (p: string) => p.includes(PROBE_PROMPT_MARK);
const probeCount = () => requests.filter(isProbe).length;
const classifyCount = () => requests.filter((p) => !isProbe(p)).length;

function cfgFor(port: number, extra: Record<string, unknown> = {}): Config {
  return {
    classifier_laya: {
      enabled: true,
      checkpoint: 'test/ckpt',
      endpoint: `http://127.0.0.1:${port}`,
      timeout_ms: 800,
      confidence_threshold: 0.8,
      mode: 'active',
      ...extra,
    },
  } as unknown as Config;
}

let port = 0;
const run = (prompt: string, extra: Record<string, unknown> = {}) =>
  classifyWithLaya(prompt, undefined, { cfg: cfgFor(port, extra), checkpoint: 'test/ckpt' });

beforeEach(async () => {
  vi.spyOn(loggerModule, 'warnLog').mockImplementation(() => {});
  resetLayaAvailability();
  mode = 'ok';
  requests = [];
  answer = { category: 'standard', confidence: 0.95, probabilities: { standard: 0.95, simple: 0.03 }, ms: 4 };
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/classify') {
        res.writeHead(404);
        res.end();
        return;
      }
      requests.push(String(JSON.parse(raw).prompt));
      if (mode === 'http500') {
        res.writeHead(500);
        res.end('boom');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('availability lifecycle', () => {
  it('probes lazily on first use — no manual probe call needed', async () => {
    expect(isLayaAvailable()).toBe(false); // nothing probed yet
    const res = await run('first request of the session');
    expect(res).not.toBeNull();
    expect(res!.category).toBe('standard');
    expect(probeCount()).toBe(1);
    expect(classifyCount()).toBe(1);
    expect(isLayaAvailable()).toBe(true);
  });

  it('does not probe again while the healthy state is fresh', async () => {
    await run('one');
    await run('two');
    await run('three');
    expect(probeCount()).toBe(1);
    expect(classifyCount()).toBe(3);
  });

  it('re-probes after the TTL instead of staying disabled forever', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await run('before expiry');
    expect(probeCount()).toBe(1);
    vi.setSystemTime(Date.now() + UNAVAILABLE_TTL_MS + 1000);
    const res = await run('after expiry');
    expect(res).not.toBeNull();
    expect(probeCount()).toBe(2);
  });

  it('single-flights concurrent first requests into one probe', async () => {
    const results = await Promise.all([run('a'), run('b'), run('c'), run('d'), run('e')]);
    expect(results.every((r) => r !== null)).toBe(true);
    expect(probeCount()).toBe(1);
  });

  it('a down sidecar costs one probe, then nothing until the TTL passes — and recovers after', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    mode = 'http500';
    expect(await run('down 1')).toBeNull();
    expect(await run('down 2')).toBeNull();
    expect(await run('down 3')).toBeNull();
    expect(requests).toHaveLength(1); // the probe only — no hammering
    expect(classifyCount()).toBe(0);

    mode = 'ok';
    vi.setSystemTime(Date.now() + UNAVAILABLE_TTL_MS + 1000);
    const res = await run('recovered');
    expect(res).not.toBeNull();
    expect(isLayaAvailable()).toBe(true);
  });
});

describe('failure after a healthy probe', () => {
  it('is swallowed, switches the stage off for the TTL, and is not retried per request', async () => {
    expect(await probeLaya(`http://127.0.0.1:${port}`, 800)).toBe(true);
    mode = 'http500';
    await expect(run('sidecar dies mid-session')).resolves.toBeNull(); // must not throw into the chain
    expect(isLayaAvailable()).toBe(false);
    const seen = requests.length;
    await expect(run('and again')).resolves.toBeNull();
    expect(requests.length).toBe(seen); // no hammering while the TTL holds
  });
});

describe('answer vetting', () => {
  it('never lets a confident `fallback` shadow the better stages behind it', async () => {
    // Spike: `fallback` was the most frequent confident answer (51 of 85) —
    // it means "could not tell", which is exactly when the chain must go on.
    expect(await probeLaya(`http://127.0.0.1:${port}`, 800)).toBe(true); // stage verifiably available
    answer = { category: 'fallback', confidence: 0.97, probabilities: { fallback: 0.97 }, ms: 4 };
    expect(await run('ambiguous continuation')).toBeNull();
    expect(classifyCount()).toBe(1); // the answer WAS requested and then vetoed — not skipped
  });

  it('rejects a category outside the production taxonomy', async () => {
    expect(await probeLaya(`http://127.0.0.1:${port}`, 800)).toBe(true);
    answer = { category: 'banana', confidence: 0.99, probabilities: { banana: 0.99 }, ms: 4 };
    expect(await run('whatever')).toBeNull();
    expect(classifyCount()).toBe(1);
  });

  it('detailed variant exposes the raw answer even when the stage falls through (shadow data)', async () => {
    answer = { category: 'design', confidence: 0.41, probabilities: { design: 0.41, planning: 0.3 }, ms: 4 };
    const out = await classifyWithLayaDetailed('low confidence ask', undefined, {
      cfg: cfgFor(port),
      checkpoint: 'test/ckpt',
    });
    expect(out).not.toBeNull();
    expect(out!.result).toBeNull(); // below threshold → chain falls through
    expect(out!.answer).toMatchObject({ category: 'design', confidence: 0.41 });
  });

  it('detailed variant returns null when the stage is disabled or the sidecar is down', async () => {
    expect(
      await classifyWithLayaDetailed('x', undefined, { cfg: cfgFor(port, { enabled: false }), checkpoint: 'c' }),
    ).toBeNull();
    mode = 'http500';
    expect(await classifyWithLayaDetailed('y', undefined, { cfg: cfgFor(port), checkpoint: 'c' })).toBeNull();
  });
});
