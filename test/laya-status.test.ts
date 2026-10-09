// /router status for the Laya stage. The status must be honest about three
// distinct facts: whether the stage is configured, whether it is the one that
// DECIDES (active) or only observes (shadow), and whether the sidecar is
// reachable - including "not probed yet", which is neither up nor down: the
// stage probes lazily on first use, so before the first classification
// reporting "unavailable" would be a false alarm (cf. the 2026-10-02 finding
// that the status once claimed a classifier that was not in use).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import { createCommands, formatClassifierStatus } from '../src/commands.ts';
import { classifyWithLaya, layaAvailabilityState, resetLayaAvailability } from '../src/laya-classifier.ts';
import * as loggerModule from '../src/logger.ts';
import type { Group } from '../src/types.ts';

const group = { name: 'dynamic', method: 'dynamic', models: [] } as unknown as Group;

const status = (laya?: Parameters<typeof formatClassifierStatus>[0]['laya']) =>
  formatClassifierStatus({
    group,
    last: null,
    probedCount: 0,
    ollamaUp: true,
    ...(laya ? { laya } : {}),
  });

const layaLine = (lines: string[]) => lines.find((l) => l.startsWith('│ Laya (')) ?? '';
const chainLine = (lines: string[]) => lines.find((l) => l.startsWith('│ Chain:')) ?? '';

const base = { checkpoint: 'test/ckpt', endpoint: 'http://127.0.0.1:8089', confidence_threshold: 0.8 };

describe('formatClassifierStatus — Laya line', () => {
  it('is absent when the stage is not configured', () => {
    expect(status().some((l) => l.includes('Laya'))).toBe(false);
  });

  it('says "not probed yet" before first use instead of crying unavailable', () => {
    const line = layaLine(status({ ...base, mode: 'shadow', state: 'unknown' }));
    expect(line).toContain('not probed yet');
    expect(line).not.toContain('unreachable');
    expect(line).not.toContain('unavailable');
  });

  it('shows reachable with endpoint, checkpoint, threshold and mode', () => {
    const line = layaLine(status({ ...base, mode: 'shadow', state: 'ok' }));
    expect(line).toContain('shadow');
    expect(line).toContain('laya:test/ckpt');
    expect(line).toContain('http://127.0.0.1:8089');
    expect(line).toContain('reachable');
    expect(line).not.toContain('unreachable');
    expect(line).toContain('0.8');
  });

  it('shows unreachable with the reason', () => {
    const line = layaLine(status({ ...base, mode: 'active', state: 'down', probeError: 'HTTP 500: boom' }));
    expect(line).toContain('unreachable');
    expect(line).toContain('HTTP 500: boom');
  });

  it('names Laya in the Chain line only when it actually decides (active)', () => {
    expect(chainLine(status({ ...base, mode: 'active', state: 'ok' }))).toMatch(/^│ Chain: Laya/);
    // shadow observes only - claiming it in the chain would misstate the routing
    expect(chainLine(status({ ...base, mode: 'shadow', state: 'ok' }))).not.toContain('Laya');
  });
});

describe('layaAvailabilityState', () => {
  let server: http.Server;
  let port = 0;
  let code = 200;

  beforeEach(async () => {
    vi.spyOn(loggerModule, 'warnLog').mockImplementation(() => {});
    resetLayaAvailability();
    code = 200;
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(code === 200 ? JSON.stringify({ category: 'simple', confidence: 0.9, probabilities: { simple: 0.9 }, ms: 1 }) : 'boom');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const cfg = () =>
    ({ classifier_laya: { enabled: true, checkpoint: 'c', endpoint: `http://127.0.0.1:${port}`, timeout_ms: 800, confidence_threshold: 0.8, mode: 'active' } }) as any;

  it('walks unknown → ok after first use', async () => {
    expect(layaAvailabilityState()).toBe('unknown');
    await classifyWithLaya('first', undefined, { cfg: cfg(), checkpoint: 'c' });
    expect(layaAvailabilityState()).toBe('ok');
  });

  it('is down after a failed probe', async () => {
    code = 500;
    await classifyWithLaya('first', undefined, { cfg: cfg(), checkpoint: 'c' });
    expect(layaAvailabilityState()).toBe('down');
  });
});

describe('/router overview (real handler)', () => {
  async function overview(classifier_laya: unknown): Promise<string> {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const pi = { registerCommand: (name: string, def: any) => { if (name === 'router') handler = def.handler; } };
    const rt: any = {
      pi,
      cache: {},
      cfg: { model_groups: { dynamic: group }, ...(classifier_laya ? { classifier_laya } : {}) },
      load: () => {},
      rateLimitManager: { getLimits: () => new Map() },
      isLimited: () => false,
      allDiscoveredRefs: () => [],
      getTopModels: () => ({ models: [], total: 0 }),
      curModel: '',
      sessionCtx: undefined,
      router: { setSessionCtx: () => {} },
    };
    createCommands(rt);
    const notes: string[] = [];
    await handler!('', { ui: { notify: (m: string) => notes.push(m) } });
    return notes.join('\n');
  }

  beforeEach(() => resetLayaAvailability());

  it('shows the Laya line (defaults applied) before the first classification', async () => {
    const out = await overview({ enabled: true, checkpoint: 'test/ckpt', endpoint: 'http://127.0.0.1:8089', confidence_threshold: 0.8, mode: 'shadow' });
    const line = out.split('\n').find((l) => l.startsWith('│ Laya (')) ?? '';
    expect(line).toContain('shadow');
    expect(line).toContain('not probed yet');
    expect(line).toContain('laya:test/ckpt');
  });

  it('an unset mode is shown as shadow and kept out of the Chain line (same reading as the chain)', async () => {
    const out = await overview({ enabled: true, checkpoint: 'test/ckpt' }); // no validator ran: mode/endpoint/threshold unset
    const lines = out.split('\n');
    const line = lines.find((l) => l.startsWith('│ Laya (')) ?? '';
    expect(line).toContain('Laya (shadow)');
    expect(line).toContain('http://127.0.0.1:8089'); // default endpoint applied
    expect(line).toContain('threshold 0.8');
    expect(lines.find((l) => l.startsWith('│ Chain:'))).not.toContain('Laya');
  });

  it('shows no Laya line when the stage is disabled or absent', async () => {
    expect(await overview({ enabled: false })).not.toContain('Laya');
    expect(await overview(undefined)).not.toContain('Laya');
  });
});
