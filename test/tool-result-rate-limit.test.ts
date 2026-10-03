// The tool_result rate-limit branch existed since the initial release as a
// naive heuristic (`txt.includes('429')` → recordLimit(curModel)). No
// documented production case ever surfaced a provider limit of the CURRENT
// model as tool output: genuine provider limits arrive as error EVENTS
// ONLY (isRateLimitText in consumeWithDetection — including
// pi-claude-bridge's "Claude rate limit" error events), text_delta is
// deliberately not scanned (d0a6186), and tool results are command output — a curl'd 429 from an
// unrelated host, a vitest run printing "rate_limit_exceeded", a subagent
// child hitting ITS five_hour limit. Attributing a hard cooldown + key
// rotation to the current model on that evidence is wrong no matter how
// narrow the pattern table gets (roborev review of 628af68/6611dbb, job 703
// finding 1, option a). The branch was removed entirely; these tests pin
// the removal: NO tool-result text — however rate-limit-shaped — may put
// the current model into cooldown or rotate its provider key.
//
// History: I2 (4fac114) narrowed the naive scan and routed it through
// recordStreamFailure (ring buffer + /router errors); job 676 (628af68)
// narrowed the pattern table further. Both kept the attribution flaw.

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  writeNoOpScanCache,
  removeNoOpScanCache,
  flushBackgroundScan,
} from './helpers/noop-scan-cache.ts';

const scanCachePath = path.join(
  process.env.PI_ROUTER_STATE_DIR!,
  '.cache',
  'scan-cache.json'
);

async function drainStream(stream: AsyncIterable<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

/** Boots the real extension with the standard tool-result test harness. */
async function bootToolResultHarness() {
  const tmpDir = fs.mkdtempSync('/tmp/toolresult-rl-');
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, '.pi', 'router-config.json'),
    JSON.stringify({
      free_models: [],
      providers: { openrouter: { free_models: [] } },
      rate_limit_wait_max_ms: 0,
      model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
      gdpval_builtin: { 'paid-model': 1000 },
    })
  );
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  writeNoOpScanCache(scanCachePath);

  vi.resetModules();
  const mod = await import('../index.ts');
  const defaultExport = mod.default as any;

  const onHandlers: Record<string, Array<(ev: any, ctx: any) => any>> = {};
  const pi: any = {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerProvider: vi.fn(),
    setModel: vi.fn(async () => true),
    on: vi.fn((event: string, handler: any) => {
      (onHandlers[event] ??= []).push(handler);
    }),
  };
  defaultExport(pi);

  const paidModel = {
    provider: 'paid-cloud-provider',
    id: 'paid-model',
    api: 'openai-completions',
    contextWindow: 1_000_000,
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
  };
  const streamSimple = vi.fn(() =>
    (async function* () {
      yield { type: 'text_delta', delta: 'working on it' };
      yield { type: 'done' };
    })()
  );
  const modelRegistry = {
    getAvailable: () => [paidModel],
    find: (_p: string, modelId: string) => (modelId === 'paid-model' ? paidModel : null),
    getApiKeyForProvider: async () => null,
    runtime: { streamSimple },
  };
  const notify = vi.fn();
  const ctx: any = {
    modelRegistry,
    cwd: tmpDir,
    ui: { setFooter: vi.fn(), notify },
  };
  for (const h of onHandlers['session_start'] ?? []) await h({}, ctx);
  await flushBackgroundScan();
  // The tool_result handler attributes to the module-level curModel, which
  // pi sets on turn_start — fire it with the routed model.
  for (const h of onHandlers['turn_start'] ?? []) {
    await h({}, { ...ctx, model: paidModel });
  }
  await drainStream(
    defaultExport.groupStream(
      { provider: 'standard', id: 'standard' },
      { messages: [{ role: 'user', content: 'do the thing' }] } as any,
      {}
    )
  );
  expect(streamSimple).toHaveBeenCalled();

  return { tmpDir, cwdSpy, onHandlers, ctx, notify, defaultExport };
}

/** Fires a tool_result event with the given text. */
async function fireToolResult(
  harness: Awaited<ReturnType<typeof bootToolResultHarness>>,
  text: string
) {
  for (const h of harness.onHandlers['tool_result'] ?? []) {
    await h({ isError: true, content: [{ type: 'text', text }] }, harness.ctx);
  }
}

/**
 * Fires shutdown and returns the persisted cache. NOTE: shutdown must come
 * LAST — the session_shutdown handler nulls sessionCtx, so any stream
 * started afterwards fails on the missing session context (a failure that
 * itself records a cooldown), which would mask what the test pins.
 */
async function shutDownAndRead(harness: Awaited<ReturnType<typeof bootToolResultHarness>>) {
  for (const h of harness.onHandlers['session_shutdown'] ?? []) await h({ reason: 'quit' });
  return JSON.parse(fs.readFileSync(scanCachePath, 'utf-8'));
}

/** Drains a follow-up stream and asserts it stays free of cooldown narration. */
async function assertStreamStaysClean(harness: Awaited<ReturnType<typeof bootToolResultHarness>>) {
  const events = await drainStream(
    harness.defaultExport.groupStream(
      { provider: 'standard', id: 'standard' },
      { messages: [{ role: 'user', content: 'do the thing again' }] } as any,
      {}
    )
  );
  expect(JSON.stringify(events)).not.toContain('cooldown');
}

/** True if the paid model got a rate_limit_exceeded record of any shape. */
function findRateLimitEntry(persisted: any) {
  return (persisted.session_errors ?? []).find(
    (e: any) =>
      e.ref === 'paid-cloud-provider/paid-model' && e.reason === 'rate_limit_exceeded'
  );
}

async function cleanup(harness: Awaited<ReturnType<typeof bootToolResultHarness>>) {
  harness.cwdSpy.mockRestore();
  fs.rmSync(harness.tmpDir, { recursive: true, force: true });
  removeNoOpScanCache(scanCachePath);
}

describe('tool_result output NEVER rate-limits the current model (day-1 heuristic removed)', () => {
  it('a genuine-looking provider 429 in tool output records NOTHING', async () => {
    // The case the old branch treated as its one true positive — a
    // well-formed provider rate-limit error inside a tool result — must
    // NOT put the current model into cooldown or rotate its key. The
    // stream continues clean; the ring buffer stays empty for it.
    const harness = await bootToolResultHarness();
    try {
      await fireToolResult(harness, 'HTTP 429 Too Many Requests (rate limit exceeded)');

      // The model must still stream cleanly (no cooldown narration).
      await assertStreamStaysClean(harness);

      const persisted = await shutDownAndRead(harness);
      expect(findRateLimitEntry(persisted)).toBeUndefined();
      expect(harness.notify).not.toHaveBeenCalledWith(
        expect.stringContaining('rotated'),
        expect.anything()
      );
    } finally {
      await cleanup(harness);
    }
  });

  it('a subagent-style five_hour limit hit in tool output does NOT cool down the parent model', async () => {
    // Roborev job 703 finding 1, missing-consideration case: a delegated
    // child (or a claude CLI run as a tool) hits ITS limit; the parent's
    // model must not pay for it.
    const harness = await bootToolResultHarness();
    try {
      await fireToolResult(
        harness,
        'Subagent failed: Claude five_hour rate limit hit, try again later'
      );
      await assertStreamStaysClean(harness);
      const persisted = await shutDownAndRead(harness);
      expect(findRateLimitEntry(persisted)).toBeUndefined();
      expect(harness.notify).not.toHaveBeenCalledWith(
        expect.stringContaining('rotated'),
        expect.anything()
      );
    } finally {
      await cleanup(harness);
    }
  });

  it('test/framework output containing "rate_limit_exceeded" does NOT cool down the model', async () => {
    // A failing `vitest run` in this very repo prints fixture strings like
    // 'rate_limit_exceeded'; the pattern table matched it verbatim.
    const harness = await bootToolResultHarness();
    try {
      await fireToolResult(
        harness,
        'FAIL test/tool-result-rate-limit.test.ts > records a rate_limit_exceeded entry'
      );
      await assertStreamStaysClean(harness);
      const persisted = await shutDownAndRead(harness);
      expect(findRateLimitEntry(persisted)).toBeUndefined();
    } finally {
      await cleanup(harness);
    }
  });

  it('does NOT treat a bare "1429" in tool output as a rate limit', async () => {
    const harness = await bootToolResultHarness();
    try {
      await fireToolResult(harness, 'grep finished: 1429 lines matched');
      await assertStreamStaysClean(harness);
      const persisted = await shutDownAndRead(harness);
      expect(findRateLimitEntry(persisted)).toBeUndefined();
    } finally {
      await cleanup(harness);
    }
  });

  it('does NOT treat ordinary tool errors like "out of memory" / "quota exceeded" as rate limits', async () => {
    const harness = await bootToolResultHarness();
    try {
      const ordinaryToolErrors = [
        'Error: out of memory',
        'cp: cannot create file: disk quota exceeded',
        'ValueError: index 5 is out of range for axis 0 with size 3',
        'server overloaded: retry later (local shard, exit 1)',
        'curl: (22) The requested URL returned error: 429',
        'SyntaxError at line 429 of build.js',
        'cgroup: memory limit hit, process killed',
      ];
      for (const txt of ordinaryToolErrors) {
        await fireToolResult(harness, txt);
      }

      // Non-vacuous pin: the model must still stream cleanly (no
      // cooldown-collapse narration) and leave no ring-buffer entry.
      await assertStreamStaysClean(harness);
      const persisted = await shutDownAndRead(harness);
      expect(findRateLimitEntry(persisted)).toBeUndefined();
    } finally {
      await cleanup(harness);
    }
  });
});
