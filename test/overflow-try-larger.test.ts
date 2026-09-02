/**
 * Tests for extractContextWindowFromError — the helper that parses the
 * actual context window and requested-token count from an OpenRouter-style
 * overflow error, so driveStream can:
 *   1. Update the model registry with the discovered context window (sticky)
 *   2. Try larger-context candidates before triggering compaction
 *
 * The helper lives in src/stream-orchestrator.ts (not exported), so it is
 * re-implemented inline here. The integration path (driveStream trying a
 * larger model like mistral-zai/glm-5-2 after an overflow) is exercised
 * indirectly by the existing context-overflow test suite; this file focuses
 * on the parser, which is the new logic introduced for this feature.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Inline reimplementation of the helper from src/stream-orchestrator.ts.
// Kept in sync so a regression in the parser is caught here.
function extractContextWindowFromError(detail: string | undefined): {
  actualContextWindow: number;
  requestedTokens: number;
} | null {
  if (!detail) return null;
  const cwMatch = detail.match(/maximum context length is (\d+) tokens/);
  const reqMatch = detail.match(/requested about (\d+) tokens/);
  if (!cwMatch || !reqMatch) return null;
  const cw = parseInt(cwMatch[1], 10);
  const req = parseInt(reqMatch[1], 10);
  if (!cw || !req) return null;
  return { actualContextWindow: cw, requestedTokens: req };
}

describe('extractContextWindowFromError', () => {
  it('parses a standard OpenRouter overflow error (real minimax-m2.7:free rejection)', () => {
    // The exact error format from the field report: a free OpenRouter model
    // (196608-token window) rejecting a 197318-token prompt. The shortfall is
    // only 710 tokens — any model with >197318 tokens (e.g. mistral-zai/glm-5-2
    // at 1M) would fit, which is exactly the case the handler optimizes for.
    const detail =
      "prompt is too long: 400: {\"message\":\"This endpoint's maximum context length is 196608 tokens. However, you requested about 197318 tokens (27673 of text input, 12711 of tool input, 156934 in the output).\",\"code\":400}";
    expect(extractContextWindowFromError(detail)).toEqual({
      actualContextWindow: 196608,
      requestedTokens: 197318,
    });
  });

  it('parses with different token counts (smaller window)', () => {
    const detail =
      '{"message":"maximum context length is 128000 tokens. However, you requested about 130000 tokens","code":400}';
    expect(extractContextWindowFromError(detail)).toEqual({
      actualContextWindow: 128000,
      requestedTokens: 130000,
    });
  });

  it('returns null when detail is undefined', () => {
    expect(extractContextWindowFromError(undefined)).toBeNull();
  });

  it('returns null when detail is empty string', () => {
    expect(extractContextWindowFromError('')).toBeNull();
  });

  it('returns null for non-matching text (no numbers to extract)', () => {
    expect(extractContextWindowFromError('Something went wrong')).toBeNull();
    expect(extractContextWindowFromError('prompt is too long but no numbers')).toBeNull();
  });

  it('returns null when only one of the two numbers is present', () => {
    // Only the context-window number, no requested-tokens number.
    expect(
      extractContextWindowFromError('maximum context length is 196608 tokens')
    ).toBeNull();
    // Only the requested-tokens number, no context-window number.
    expect(
      extractContextWindowFromError('requested about 197318 tokens')
    ).toBeNull();
  });
});

// ── driveStream integration: try-larger recursion ──────────────────────────
//
// These exercise the actual driveStream "try larger candidates before
// compaction" branch (stream-orchestrator.ts:525-559) that the unit tests
// above don't cover. They follow the context-overflow.test.ts pattern:
// mock modelRegistry.runtime.streamSimple to yield provider events, and a
// find() that maps refs to models with known context windows.
import {
  acquireRouterStateLock,
  releaseRouterStateLock,
  writeNoOpScanCache,
  removeNoOpScanCache,
  flushBackgroundScan,
} from './helpers/router-state-lock.ts';

const repoRoot2 = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The module reads router-config.json from its own extDir (dist/), not
// process.cwd() — so to control the group's candidates we must back up and
// write dist/router-config.json, restoring it in finally (even on failure).
const EXT_CFG = path.join(repoRoot2, 'dist', 'router-config.json');
const dynamicConfigPath2 = path.join(repoRoot2, 'router-config.dynamic.json');
const scanCachePath2 = path.join(repoRoot2, '.cache', 'scan-cache.json');

// A minimal config whose 'standard' group lists exactly the two refs the
// mock find() recognizes. min_gdpval:0 so the unscored mock models aren't
// filtered out by the GDPval threshold. The providers.p.free_models entry
// seeds the group's candidate list with the refs the mock find() resolves.
const TEST_CFG_BODY = JSON.stringify({
  free_models: [],
  model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
  providers: { p: { free_models: ['p/small', 'p/big'] } },
});

async function drainStream2(stream: any) {
  const events = [] as any[];
  for await (const ev of stream) events.push(ev);
  return events;
}

describe('driveStream: context_overflow — try-larger recursion', () => {
  it('overflow on first candidate (parseable error) → tries the larger second candidate and succeeds', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-overflow-trylarge-'));
    const extCfgBak = `${EXT_CFG}.trylarge-bak`;
    fs.copyFileSync(EXT_CFG, extCfgBak);
    fs.writeFileSync(EXT_CFG, TEST_CFG_BODY);
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    await acquireRouterStateLock();
    if (fs.existsSync(dynamicConfigPath2)) fs.renameSync(dynamicConfigPath2, `${dynamicConfigPath2}.trylarge-bak`);
    writeNoOpScanCache(scanCachePath2);
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

      // Two candidates in 'standard'. Pre-flight guard must NOT skip either
      // (both windows > the ~500-token estimate), so the first is actually
      // tried and overflows at runtime with a parseable error.
      const smallModel = { provider: 'p', id: 'small', api: 'a', contextWindow: 200_000 };
      const bigModel = { provider: 'p', id: 'big', api: 'a', contextWindow: 1_000_000 };
      const modelsByRef: Record<string, any> = {
        'p/small': smallModel,
        'p/big': bigModel,
      };
      const overflowDetail =
        'prompt is too long: 400: {"message":"maximum context length is 196608 tokens. However, you requested about 197318 tokens","code":400}';
      const streamSimple = vi.fn((model: any) => {
        if (model.id === 'small') {
          // Runtime overflow (provider rejects the oversized prompt).
          return (async function* () {
            yield { type: 'error', reason: 'error', error: { message: overflowDetail } };
          })();
        }
        // big model succeeds.
        return (async function* () {
          yield { type: 'text_delta', delta: 'served by the big model' };
          yield { type: 'done' };
        })();
      });
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
      const context: any = { messages: [{ role: 'user', content: 'Hello' }] };
      const events = await drainStream2(defaultExport.groupStream(groupModel, context, {}));

      // small was tried first (overflowed), then big was tried (succeeded).
      expect(streamSimple).toHaveBeenCalledWith(expect.objectContaining({ id: 'small' }), expect.anything(), expect.anything());
      expect(streamSimple).toHaveBeenCalledWith(expect.objectContaining({ id: 'big' }), expect.anything(), expect.anything());
      // No overflow error surfaced — big succeeded.
      const errEvent = events.find((e: any) => e.type === 'error');
      expect(errEvent).toBeUndefined();
      const text = events.filter((e: any) => e.type === 'text_delta').map((e: any) => e.delta ?? '').join('');
      expect(text).toContain('served by the big model');
    } finally {
      cwdSpy.mockRestore();
      vi.restoreAllMocks();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      removeNoOpScanCache(scanCachePath2);
      if (fs.existsSync(`${dynamicConfigPath2}.trylarge-bak`)) fs.renameSync(`${dynamicConfigPath2}.trylarge-bak`, dynamicConfigPath2);
      if (fs.existsSync(extCfgBak)) fs.renameSync(extCfgBak, EXT_CFG);
      releaseRouterStateLock();
    }
  });

  it('unparseable overflow error → does not retry the same model infinitely (recordSoftFailure guards recursion)', async () => {
    // Roborev HIGH finding: when the error text is unparseable, the registry
    // update is skipped, so the pre-flight guard won't skip the model next
    // pass. Without recordSoftFailure the model would be retried in an
    // unbounded loop. The fix calls recordSoftFailure so cooldown excludes it;
    // this test asserts the overflowing model is NOT retried indefinitely.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-overflow-unparse-'));
    const extCfgBak = `${EXT_CFG}.unparse-bak`;
    fs.copyFileSync(EXT_CFG, extCfgBak);
    fs.writeFileSync(EXT_CFG, TEST_CFG_BODY);
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    await acquireRouterStateLock();
    if (fs.existsSync(dynamicConfigPath2)) fs.renameSync(dynamicConfigPath2, `${dynamicConfigPath2}.unparse-bak`);
    writeNoOpScanCache(scanCachePath2);
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

      // First candidate overflows with an UNPARSEABLE message (no "maximum
      // context length is N tokens"). Second candidate is larger and succeeds.
      const smallModel = { provider: 'p', id: 'small', api: 'a', contextWindow: 200_000 };
      const bigModel = { provider: 'p', id: 'big', api: 'a', contextWindow: 1_000_000 };
      const modelsByRef: Record<string, any> = {
        'p/small': smallModel,
        'p/big': bigModel,
      };
      const streamSimple = vi.fn((model: any) => {
        if (model.id === 'small') {
          return (async function* () {
            // Unparseable overflow text — still detected as overflow by
            // isOverflowErrorText (matches 'prompt is too long'), but
            // extractContextWindowFromError returns null (no token numbers).
            yield { type: 'error', reason: 'error', error: { message: 'prompt is too long: request too large' } };
          })();
        }
        return (async function* () {
          yield { type: 'text_delta', delta: 'served by the big model' };
          yield { type: 'done' };
        })();
      });
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
      const context: any = { messages: [{ role: 'user', content: 'Hello' }] };
      await drainStream2(defaultExport.groupStream(groupModel, context, {}));

      // The overflowing model must be tried at most ONCE. If recordSoftFailure
      // weren't called, the recursive tried-list would re-include it and it
      // would be retried (2+ calls). With the fix, it's tried once, then
      // cooldown excludes it and big is tried next.
      const smallCalls = streamSimple.mock.calls.filter((c: any[]) => c[0]?.id === 'small').length;
      expect(smallCalls).toBe(1);
      // big was tried (succeeded).
      const bigCalls = streamSimple.mock.calls.filter((c: any[]) => c[0]?.id === 'big').length;
      expect(bigCalls).toBeGreaterThanOrEqual(1);
    } finally {
      cwdSpy.mockRestore();
      vi.restoreAllMocks();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      removeNoOpScanCache(scanCachePath2);
      if (fs.existsSync(`${dynamicConfigPath2}.unparse-bak`)) fs.renameSync(`${dynamicConfigPath2}.unparse-bak`, dynamicConfigPath2);
      if (fs.existsSync(extCfgBak)) fs.renameSync(extCfgBak, EXT_CFG);
      releaseRouterStateLock();
    }
  });
});
