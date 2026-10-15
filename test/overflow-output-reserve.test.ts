// test/overflow-output-reserve.test.ts
//
// Integration: the requested output budget counts against the window. Live
// 2026-10-13/14: openrouter/inclusionai/ling-3.1-flash (262 144 window) was sent
// prompts whose input alone fit, but the output reservation pushed the request
// over the window; every such attempt was rejected and the model then sat in a
// soft backoff. The router must now cap the output to what the window leaves,
// and skip the candidate only when even the minimum output does not fit.

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeNoOpScanCache,
  removeNoOpScanCache,
  flushBackgroundScan,
} from './helpers/noop-scan-cache.ts';

const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

// 'small' = the ling-like model with the 262 144 window; 'big' = a larger fallback.
const TEST_CFG_BODY = JSON.stringify({
  free_models: [],
  model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
  providers: { p: { free_models: ['p/small', 'p/big'] } },
});

const WINDOW = 262_144;

async function drain(stream: any) {
  const events = [] as any[];
  for await (const ev of stream) events.push(ev);
  return events;
}

async function runGroup(options: Record<string, unknown>, text: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-output-reserve-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), TEST_CFG_BODY);
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  if (fs.existsSync(dynamicConfigPath)) fs.renameSync(dynamicConfigPath, `${dynamicConfigPath}.reserve-bak`);
  writeNoOpScanCache(scanCachePath);
  try {
    vi.resetModules();
    const mod = await import('../index.ts');
    const defaultExport = mod.default as any;
    const onHandlers: Record<string, any> = {};
    const pi: any = {
      registerTool: vi.fn(), registerCommand: vi.fn(), registerProvider: vi.fn(),
      setModel: vi.fn(async () => true),
      on: vi.fn((e: string, h: any) => { onHandlers[e] = h; }),
    };
    defaultExport(pi);

    const smallModel = { provider: 'p', id: 'small', api: 'a', contextWindow: WINDOW };
    const bigModel = { provider: 'p', id: 'big', api: 'a', contextWindow: 1_000_000 };
    const modelsByRef: Record<string, any> = { 'p/small': smallModel, 'p/big': bigModel };
    const streamSimple = vi.fn((model: any) =>
      (async function* () {
        yield { type: 'text_delta', delta: `served by ${model.id}` };
        yield { type: 'done' };
      })()
    );
    const modelRegistry = {
      getAvailable: () => [smallModel, bigModel],
      find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
      getApiKeyForProvider: async () => null,
      runtime: { streamSimple },
    };
    const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
    await onHandlers['session_start']?.({}, ctx);
    await flushBackgroundScan();

    const groupModel = { provider: 'standard', id: 'standard' };
    const context: any = { messages: [{ role: 'user', content: text }], tools: [] };
    const events = await drain(defaultExport.groupStream(groupModel, context, options));
    const answer = events.filter((e: any) => e.type === 'text_delta').map((e: any) => e.delta ?? '').join('');
    return { streamSimple, answer };
  } finally {
    cwdSpy.mockRestore();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    removeNoOpScanCache(scanCachePath);
    if (fs.existsSync(`${dynamicConfigPath}.reserve-bak`)) fs.renameSync(`${dynamicConfigPath}.reserve-bak`, dynamicConfigPath);
  }
}

describe('driveStream: requested output counts against the window', () => {
  it('caps the output of a long-context request instead of sending the full reservation', async () => {
    // ~185 000 tokens of message text (chars / 4): fits the window on input alone,
    // but not together with a 165 880-token output reservation.
    const { streamSimple, answer } = await runGroup(
      { maxTokens: 165_880 },
      'x'.repeat(185_000 * 4),
    );
    const smallCalls = streamSimple.mock.calls.filter((c: any[]) => c[0]?.id === 'small');
    expect(smallCalls.length).toBe(1);
    const sentMax = smallCalls[0][2]?.maxTokens;
    expect(sentMax).toBeLessThan(165_880);
    expect(sentMax).toBeGreaterThanOrEqual(4096);
    // Input estimate + capped output + margin must fit the window.
    expect(185_000 + sentMax).toBeLessThan(WINDOW);
    expect(answer).toContain('served by small');
  });

  it('skips a candidate whose input leaves no room for even the minimum output', async () => {
    // ~260 000 tokens of input: below the window on its own, but no room for output.
    const { streamSimple, answer } = await runGroup(
      { maxTokens: 165_880 },
      'x'.repeat(260_000 * 4),
    );
    const smallCalls = streamSimple.mock.calls.filter((c: any[]) => c[0]?.id === 'small');
    expect(smallCalls.length).toBe(0);
    expect(answer).toContain('served by big');
  });
});
