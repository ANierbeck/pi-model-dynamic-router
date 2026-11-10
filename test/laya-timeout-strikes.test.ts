// test/laya-timeout-strikes.test.ts
//
// A classify TIMEOUT after a healthy probe is a per-prompt event, not a
// verdict on the sidecar. Live evidence (2026-11-08): 56 "classify request
// timed out after 1500ms; stage disabled" warnings in router.log, each one
// handing every following prompt of that process to the cloud chain for
// UNAVAILABLE_TTL_MS (5 min) — against owner decision 1 of
// docs/plans/2026-10-25-laya-sole-classifier.md ("Laya decides every
// prompt"; the chain decides only on failure). The same sidecar answered the
// same work in 22 ms to 2.6 s depending on GPU contention, so one slow call
// says nothing about whether the next one will be slow.
//
// Contract pinned here:
//   - one timeout: THIS prompt falls through (null), the stage stays available;
//   - TIMEOUT_STRIKES_BEFORE_DOWN timeouts in a row: the sidecar is treated as
//     hung and the stage goes down for the TTL (a hung sidecar must not tax
//     every prompt with the full timeout);
//   - any answer in between resets the count;
//   - connection errors, HTTP errors and malformed answers still disable the
//     stage at once (they are not latency).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import * as classifier from '../src/laya-classifier.ts';
import * as loggerModule from '../src/logger.ts';

type Mode = 'ok' | 'hang' | 'http500';

let server: http.Server;
let endpoint = '';
let mode: Mode = 'ok';
const hung: http.ServerResponse[] = [];

const OK_ANSWER = {
  category: 'design',
  confidence: 0.6,
  probabilities: { design: 0.6, planning: 0.4 },
  ms: 10,
};

const cfg = {
  integrations: {
    laya: { enabled: true, checkpoint: 'x/y', timeout_ms: 150, confidence_threshold: 0 },
  },
} as never;

const classify = (prompt: string) =>
  classifier.classifyWithLaya(prompt, undefined, {
    cfg: { integrations: { laya: { ...(cfg as any).integrations.laya, endpoint } } } as never,
    checkpoint: 'x/y',
  });

beforeEach(async () => {
  vi.spyOn(loggerModule, 'warnLog').mockImplementation(() => {});
  classifier.resetLayaAvailability();
  mode = 'ok';
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (mode === 'hang') {
        hung.push(res); // never answered: the client aborts at timeout_ms
        return;
      }
      if (mode === 'http500') {
        res.writeHead(500);
        res.end('boom');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(OK_ANSWER));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // A healthy probe first: this file is about the classify call AFTER it.
  expect(await classifier.probeLaya(endpoint, 1000)).toBe(true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const res of hung.splice(0)) res.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('classify timeout after a healthy probe', () => {
  it('one timeout falls through for this prompt only — the stage stays available', async () => {
    mode = 'hang';
    expect(await classify('slow prompt')).toBeNull();
    expect(classifier.layaAvailabilityState()).toBe('ok');

    mode = 'ok';
    expect(await classify('next prompt')).toMatchObject({ category: 'design' });
  });

  it('a timeout is still logged (the operator sees it), once per event', async () => {
    const warn = vi.spyOn(loggerModule, 'warnLog').mockImplementation(() => {});
    mode = 'hang';
    await classify('slow prompt');
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain('timed out after 150ms');
  });

  it('TIMEOUT_STRIKES_BEFORE_DOWN timeouts in a row take the stage down for the TTL', async () => {
    mode = 'hang';
    for (let i = 1; i < classifier.TIMEOUT_STRIKES_BEFORE_DOWN; i++) {
      expect(await classify(`slow ${i}`)).toBeNull();
      expect(classifier.layaAvailabilityState()).toBe('ok');
    }
    expect(await classify('the last strike')).toBeNull();
    expect(classifier.layaAvailabilityState()).toBe('down');
    expect(classifier.getLastProbeError()).toContain('timed out after 150ms');

    // Down means down: the sidecar is not even asked.
    mode = 'ok';
    expect(await classify('while down')).toBeNull();
  });

  it('an answer in between resets the count', async () => {
    const strikes = classifier.TIMEOUT_STRIKES_BEFORE_DOWN;
    for (let round = 0; round < 2; round++) {
      mode = 'hang';
      for (let i = 1; i < strikes; i++) await classify(`slow ${round}.${i}`);
      mode = 'ok';
      expect(await classify(`fast ${round}`)).toMatchObject({ category: 'design' });
    }
    expect(classifier.layaAvailabilityState()).toBe('ok');
  });

  it('an HTTP error still disables the stage at once — it is not latency', async () => {
    mode = 'http500';
    expect(await classify('broken')).toBeNull();
    expect(classifier.layaAvailabilityState()).toBe('down');
  });
});
