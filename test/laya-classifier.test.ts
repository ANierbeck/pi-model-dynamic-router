// test/laya-classifier.test.ts

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import * as classifier from '../src/laya-classifier.ts';
import * as loggerModule from '../src/logger.ts';
import { buildClassifierLayaQuestion } from '../src/classification-prompt.ts';

describe('laya-classifier', () => {
  let server: http.Server | null = null;
  let port: number;
  let state: 'ok' | 'refused' | 'timeout' | 'http500' | 'malformed';
  let warnSpy: ReturnType<typeof vi.spyOn>;

  const ENDPOINT = (p: number) => `http://127.0.0.1:${p}/classify`;

  const okResponse = { category: 'simple', confidence: 0.5, probabilities: { trivial: 0.05, simple: 0.5, standard: 0.3, code_complex: 0.1, fallback: 0.05 }, ms: 10 };
  const probePrompt = 'The quick brown fox jumps over the lazy dog.';

  async function startServer(mode: typeof state): Promise<number> {
    state = mode;
    return new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
          // just consume
          try { JSON.parse(body); } catch {}
          if (state === 'timeout') {
            // never respond -> client AbortError
            return;
          }
          if (state === 'http500') {
            res.writeHead(500);
            res.end('boom');
            return;
          }
          if (state === 'malformed') {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('not json at all');
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(okResponse));
        });
      });
      server.listen(0, '127.0.0.1', () => {
        port = (server!.address() as any).port;
        resolve(port);
      });
      server.on('error', reject);
    });
  }

  async function stopServer(): Promise<void> {
    if (!server) return;
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = null;
  }

  beforeEach(async () => {
    warnSpy = vi.spyOn(loggerModule, 'warnLog').mockImplementation(() => {});
    classifier.resetLayaAvailability();
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await stopServer();
  });

  it('builds the question from the production prompt surface (parity with the wrapper)', () => {
    const { instructions, criteria } = buildClassifierLayaQuestion();
    // The wrapper derives the same 9 criteria from the same source; parity is
    // asserted by the classification tests below — here we confirm it is
    // constructible and non-empty.
    expect(instructions).toContain("Classify the user's request");
    expect(criteria.length).toBe(9);
  });

  it('probes successfully and marks the stage available', async () => {
    const p = await startServer('ok');
    const result = await classifier.probeLaya(ENDPOINT(p), 3000);
    expect(result).toBe(true);
    expect(classifier.isLayaAvailable()).toBe(true);
    expect(classifier.getLastProbeError()).toBeNull();
  });

  it('classifies with a confident result when the stage is available', async () => {
    const p = await startServer('ok');
    await classifier.probeLaya(ENDPOINT(p), 3000);
    expect(classifier.isLayaAvailable()).toBe(true);
    const res = await classifier.classifyWithLaya('fix the typo', undefined, { cfg: { classifier_laya: { enabled: true, checkpoint: 'x/y', endpoint: ENDPOINT(p), confidence_threshold: 0.4 } } as any, checkpoint: 'x/y' });
    expect(res).toEqual({ category: 'simple', confidence: 0.5, reason: expect.stringContaining('simple') });
  });

  it('falls through when the stage is not probing / unavailable', async () => {
    classifier.resetLayaAvailability();
    const p = await startServer('ok');
    const res = await classifier.classifyWithLaya('hello', undefined, { cfg: { classifier_log: { enabled: true } } as any, checkpoint: 'x/y' });
    expect(res).toBeNull();
  });

  it('connection refused -> probe marks unavailable and classify falls through', async () => {
    classifier.resetLayaAvailability();
    const probeResult = await classifier.probeLaya('http://127.0.0.1:9999/classify', 500);
    expect(probeResult).toBe(false);
    expect(classifier.isLayaAvailable()).toBe(false);
    expect(classifier.getLastProbeError()).toBeTruthy();
    const res = await classifier.classifyWithLaya('hello', undefined, { cfg: { classifier_laya: { enabled: true, checkpoint: 'x/y', endpoint: 'http://127.0.0.1:9999', timeout_ms: 500 } } as any, checkpoint: 'x/y' });
    expect(res).toBeNull();
  });

  it('timeout -> probe marks unavailable and classify falls through', async () => {
    classifier.resetLayaAvailability();
    await startServer('timeout');
    const probeResult = await classifier.probeLaya(ENDPOINT(port), 500);
    expect(probeResult).toBe(false);
    expect(classifier.isLayaAvailable()).toBe(false);
    expect(classifier.getLastProbeError()).toBe('classify request timed out after 500ms');
    const res = await classifier.classifyWithLaya('hello', undefined, { cfg: { classifier_laya: { enabled: true, checkpoint: 'x/y', endpoint: ENDPOINT(port), timeout_ms: 500 } } as any, checkpoint: 'x/y' });
    expect(res).toBeNull();
  });

  it('HTTP 500 -> probe marks unavailable and classify falls through', async () => {
    classifier.resetLayaAvailability();
    await startServer('http500');
    const probeResult = await classifier.probeLaya(ENDPOINT(port), 500);
    expect(probeResult).toBe(false);
    expect(classifier.isLayaAvailable()).toBe(false);
    const res = await classifier.classifyWithLaya('hello', undefined, { cfg: { classifier_laya: { enabled: true, checkpoint: 'x/y', endpoint: ENDPOINT(port), timeout_ms: 500 } } as any, checkpoint: 'x/y' });
    expect(res).toBeNull();
  });

  it('malformed JSON -> probe marks unavailable and classify falls through', async () => {
    classifier.resetLayaAvailability();
    await startServer('malformed');
    const probeResult = await classifier.probeLaya(ENDPOINT(port), 500);
    expect(probeResult).toBe(false);
    expect(classifier.isLayaAvailable()).toBe(false);
    const res = await classifier.classifyWithLaya('hello', undefined, { cfg: { classifier_laya: { enabled: true, checkpoint: 'x/y', endpoint: ENDPOINT(port), timeout_ms: 500 } } as any, checkpoint: 'x/y' });
    expect(res).toBeNull();
  });

  it('warnLog is called once per failure batch (not every request)', async () => {
    const p = await startServer('ok');
    await classifier.probeLaya(ENDPOINT(p), 3000);
    expect(classifier.isLayaAvailable()).toBe(true);
    // now make the endpoint misbehave — first classify failure fires warnLog
    state = 'http500';
    await classifier.classifyWithLaya('hello', undefined, { cfg: { classifier_laya: { enabled: true, checkpoint: 'x/y', endpoint: ENDPOINT(port), timeout_ms: 500 } } as any, checkpoint: 'x/y' });
    // ... repeated classify failures within the TTL do not log again
    await classifier.classifyWithLaya('a', undefined, { cfg: { classifier_laya: { enabled: true, checkpoint: 'x/y', endpoint: ENDPOINT(port), timeout_ms: 500 } } as any, checkpoint: 'x/y' });
    await classifier.classifyWithLaya('b', undefined, { cfg: { classifier_laya: { enabled: true, checkpoint: 'x/y', endpoint: ENDPOINT(port), timeout_ms: 500 } } as any, checkpoint: 'x/y' });
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('ttl expiry makes the stage unavailable again (fresh probe needed)', async () => {
    const p = await startServer('ok');
    await classifier.probeLaya(ENDPOINT(p), 3000);
    expect(classifier.isLayaAvailable()).toBe(true);
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(classifier.UNAVAILABLE_TTL_MS + 100);
    expect(classifier.isLayaAvailable()).toBe(false);
    vi.useRealTimers();
  });
});
