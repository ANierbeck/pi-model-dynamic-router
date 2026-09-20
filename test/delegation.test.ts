/**
 * Unit tests for enforced delegation (ADR-0007, revised 2026-09-20):
 * oversized `read` results get summarized by a cheap model via a router
 * group BEFORE the main model sees them.
 *
 * The mechanism was verified live (spike, 2026-09-20): replacement reaches
 * the calling model, nested usage is attached, targeted reads pass through.
 * These tests pin the MODULE logic:
 *   - config defaults and gating (threshold, tool, error, content shape)
 *   - router-narration stripping (spike finding: "> [router]" cascade lines
 *     leak into machine-facing sub-call output)
 *   - stream draining + nested-usage extraction
 *   - strict fail-open: every failure path returns undefined so the
 *     original result passes through untouched
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireRouterStateLock,
  releaseRouterStateLock,
  writeNoOpScanCache,
  removeNoOpScanCache,
  flushBackgroundScan,
} from './helpers/router-state-lock.ts';
import {
  delegationSettings,
  extractTextContent,
  stripRouterNarration,
  buildSummaryPrompt,
  handleReadDelegation,
} from '../src/delegation';
import type { Config } from '../src/types';

// ── delegationSettings ──────────────────────────────────────────────────

describe('delegationSettings', () => {
  it('defaults to disabled with sane thresholds covering read AND bash', () => {
    const s = delegationSettings({ model_groups: {} } as Config);
    expect(s.enabled).toBe(false);
    expect(s.min_chars).toBe(20000);
    expect(s.group).toBe('bulk_reader');
    expect(s.max_raw_chars).toBe(60000);
    // Real-world finding (2026-09-20): file inspection in agent sessions runs
    // predominantly through `bash` (sed/grep/cat), so a read-only default
    // never fires. Both file-inspection tools are covered out of the box.
    expect(s.tools).toEqual(['read', 'bash']);
  });

  it('treats a missing config as disabled (fail-open)', () => {
    expect(delegationSettings(undefined).enabled).toBe(false);
  });

  it('respects full user overrides', () => {
    const cfg = {
      model_groups: {},
      delegation: { enabled: true, min_chars: 5000, group: 'trivial', max_raw_chars: 1000, tools: ['read'] },
    } as Config;
    const s = delegationSettings(cfg);
    expect(s).toEqual({
      enabled: true,
      min_chars: 5000,
      group: 'trivial',
      max_raw_chars: 1000,
      tools: ['read'],
    });
  });

  it('falls back to the default tool list for invalid tools values', () => {
    // Not an array
    const notArray = {
      model_groups: {},
      delegation: { enabled: true, tools: 'read' },
    } as unknown as Config;
    expect(delegationSettings(notArray).tools).toEqual(['read', 'bash']);
    // Non-string entries poison the whole list — never partially trust it
    const mixed = {
      model_groups: {},
      delegation: { enabled: true, tools: ['read', 42] },
    } as unknown as Config;
    expect(delegationSettings(mixed).tools).toEqual(['read', 'bash']);
    // Empty strings are not tools either
    const withEmpty = {
      model_groups: {},
      delegation: { enabled: true, tools: ['read', ''] },
    } as unknown as Config;
    expect(delegationSettings(withEmpty).tools).toEqual(['read', 'bash']);
  });
});

// ── extractTextContent ───────────────────────────────────────────────────

describe('extractTextContent', () => {
  it('joins text blocks with newlines', () => {
    const out = extractTextContent([
      { type: 'text', text: 'alpha' },
      { type: 'text', text: 'beta' },
    ]);
    expect(out).toBe('alpha\nbeta');
  });

  it('returns null when any non-text block is present (images etc. pass through)', () => {
    expect(
      extractTextContent([
        { type: 'text', text: 'alpha' },
        { type: 'image', data: '...' },
      ])
    ).toBeNull();
  });

  it('returns null for missing or empty content', () => {
    expect(extractTextContent(undefined)).toBeNull();
    expect(extractTextContent([])).toBeNull();
  });
});

// ── stripRouterNarration ──────────────────────────────────────────────────

describe('stripRouterNarration', () => {
  it('removes "> [router]" cascade lines but keeps the real summary', () => {
    const noisy =
      '> [router] mistral/zai-glm-latest — provider error: 422 (likely rate limit), trying next\n\n' +
      '> [router] MHINT: zai-glm-5.3\n\n' +
      'SUMMARY: the file contains numbered fox-pangram lines.';
    const out = stripRouterNarration(noisy);
    expect(out).not.toContain('[router]');
    expect(out).toContain('SUMMARY: the file contains numbered fox-pangram lines.');
  });

  it('collapses blank-line runs left by removed narration', () => {
    const out = stripRouterNarration('> [router] a\n\n\n\n> [router] b\n\ncontent');
    expect(out).toBe('content');
  });

  it('leaves narration-free text untouched', () => {
    const clean = 'line one\nline two';
    expect(stripRouterNarration(clean)).toBe('line one\nline two');
  });
});

// ── buildSummaryPrompt ───────────────────────────────────────────────────

describe('buildSummaryPrompt', () => {
  it('instructs preservation of symbols/paths/values and includes the raw text', () => {
    const raw = 'function foo() { return 42; }';
    const prompt = buildSummaryPrompt(raw);
    expect(prompt).toContain(raw);
    // The summarizer must keep what a coding orchestrator needs for follow-ups.
    expect(prompt.toLowerCase()).toContain('symbol');
    expect(prompt.toLowerCase()).toContain('path');
  });
});

// ── handleReadDelegation ────────────────────────────────────────────────

/**
 * Mock Pi ExtensionContext: modelRegistry with find() for the delegation
 * group and runtime.streamSimple yielding the given events (same event
 * shapes the live spike observed: text_delta { delta }, usage carried on
 * stream events).
 */
function makeCtx(events: any[] = [], opts: { groupModel?: unknown | null } = {}) {
  const model =
    opts.groupModel === null
      ? null
      : (opts.groupModel ?? { provider: 'bulk_reader', id: 'bulk_reader' });
  const streamSimple = vi.fn(async function* () {
    for (const e of events) yield e;
  });
  return {
    ctx: {
      modelRegistry: {
        find: vi.fn(() => model),
        runtime: { streamSimple },
      },
      signal: undefined,
    },
    streamSimple,
  };
}

const BIG = 'x'.repeat(21000); // > default min_chars 20000
const bigReadEvent = {
  toolName: 'read',
  content: [{ type: 'text', text: BIG }],
  isError: false,
};

const summaryEvents = (text: string) => [
  { type: 'text_start', contentIndex: 0 },
  { type: 'text_delta', delta: text },
  { type: 'text_end', content: text },
  {
    type: 'message_end',
    usage: { input: 11973, output: 108, totalTokens: 12081, cost: { total: 0.00048 } },
  },
];

describe('handleReadDelegation: gating (fail-open, stream never called)', () => {
  const enabledCfg = { model_groups: {}, delegation: { enabled: true } } as Config;

  it('disabled → undefined, no sub-call', async () => {
    const { ctx, streamSimple } = makeCtx(summaryEvents('SUMMARY: x'));
    const out = await handleReadDelegation(bigReadEvent, ctx, undefined);
    expect(out).toBeUndefined();
    expect(streamSimple).not.toHaveBeenCalled();
  });

  it('enabled but tool not in the covered list (edit) → undefined', async () => {
    const { ctx, streamSimple } = makeCtx();
    const out = await handleReadDelegation(
      { toolName: 'edit', content: [{ type: 'text', text: BIG }] },
      ctx,
      enabledCfg
    );
    expect(out).toBeUndefined();
    expect(streamSimple).not.toHaveBeenCalled();
  });

  it('oversized bash result IS delegated (real-world dominant inspection path)', async () => {
    // 2026-09-20 log evidence: zero real-session fires — every file read in
    // the sessions ran through bash (sed/grep/cat), which the read-only hook
    // never saw. The default tool list must cover it.
    const { ctx, streamSimple } = makeCtx(
      summaryEvents('The command printed a long numbered listing of scanned model entries.')
    );
    const out = await handleReadDelegation(
      { toolName: 'bash', content: [{ type: 'text', text: BIG }], isError: false },
      ctx,
      enabledCfg
    );
    expect(out).toBeDefined();
    expect(streamSimple).toHaveBeenCalledTimes(1);
    const text = out!.content[0].text as string;
    // Marker names the actual tool so the model knows what was summarized.
    expect(text).toMatch(/delegated summary of a 21000-char bash result/);
    expect(text).not.toContain('[router]');
  });

  it('a tools override can restrict coverage back to read-only', async () => {
    const { ctx, streamSimple } = makeCtx(summaryEvents('unused'));
    const out = await handleReadDelegation(
      { toolName: 'bash', content: [{ type: 'text', text: BIG }], isError: false },
      ctx,
      { model_groups: {}, delegation: { enabled: true, tools: ['read'] } } as Config
    );
    expect(out).toBeUndefined();
    expect(streamSimple).not.toHaveBeenCalled();
  });

  it('error results pass through untouched', async () => {
    const { ctx, streamSimple } = makeCtx();
    const out = await handleReadDelegation({ ...bigReadEvent, isError: true }, ctx, enabledCfg);
    expect(out).toBeUndefined();
    expect(streamSimple).not.toHaveBeenCalled();
  });

  it('under-threshold results pass through', async () => {
    const { ctx, streamSimple } = makeCtx();
    const out = await handleReadDelegation(
      { toolName: 'read', content: [{ type: 'text', text: 'small' }] },
      ctx,
      enabledCfg
    );
    expect(out).toBeUndefined();
    expect(streamSimple).not.toHaveBeenCalled();
  });

  it('mixed-block content (images) passes through', async () => {
    const { ctx, streamSimple } = makeCtx();
    const out = await handleReadDelegation(
      { toolName: 'read', content: [{ type: 'text', text: BIG }, { type: 'image' }] },
      ctx,
      enabledCfg
    );
    expect(out).toBeUndefined();
    expect(streamSimple).not.toHaveBeenCalled();
  });
});

describe('handleReadDelegation: happy path', () => {
  it('returns the replacement with marker, stripped summary, and nested usage', async () => {
    const summary =
      '> [router] trying next\n\n' +
      'The file contains 1500 numbered fox-pangram lines for the delegation test.';
    const { ctx, streamSimple } = makeCtx(summaryEvents(summary));
    const out = await handleReadDelegation(bigReadEvent, ctx, {
      model_groups: {},
      delegation: { enabled: true },
    } as Config);

    expect(out).toBeDefined();
    expect(streamSimple).toHaveBeenCalledTimes(1);
    const text = out!.content[0].text as string;
    // Marker tells the orchestrating model a targeted re-read is available.
    expect(text).toMatch(/delegated summary of a 21000-char read result/);
    expect(text).toMatch(/offset\/limit/);
    // Narration stripped (spike finding).
    expect(text).not.toContain('[router]');
    expect(text).toContain('The file contains 1500 numbered fox-pangram lines for the delegation test.');
    // Nested usage attached for accounting (spike-verified shape).
    expect(out!.usage).toMatchObject({ input: 11973, totalTokens: 12081 });
  });

  it('respects a custom group and threshold from config', async () => {
    const { ctx, streamSimple } = makeCtx(
      summaryEvents('The file is a short numbered fixture used to exercise the custom group.')
    );
    const smallEvent = { toolName: 'read', content: [{ type: 'text', text: 'y'.repeat(120) }] };
    const out = await handleReadDelegation(smallEvent, ctx, {
      model_groups: {},
      delegation: { enabled: true, min_chars: 100, group: 'trivial' },
    } as Config);

    expect(out).toBeDefined();
    const find = ctx.modelRegistry.find as ReturnType<typeof vi.fn>;
    expect(find).toHaveBeenCalledWith('trivial', 'trivial');
  });
});

describe('handleReadDelegation: fail-open on sub-call failure', () => {
  const enabledCfg = { model_groups: {}, delegation: { enabled: true } } as Config;

  it('group model not registered → undefined (original passes through)', async () => {
    const { ctx, streamSimple } = makeCtx([], { groupModel: null });
    const out = await handleReadDelegation(bigReadEvent, ctx, enabledCfg);
    expect(out).toBeUndefined();
    expect(streamSimple).not.toHaveBeenCalled();
  });

  it('stream throws → undefined', async () => {
    const model = { provider: 'bulk_reader', id: 'bulk_reader' };
    const streamSimple = vi.fn(async function* () {
      yield { type: 'text_delta', delta: 'partial' };
      throw new Error('connection reset');
    });
    const ctx = { modelRegistry: { find: vi.fn(() => model), runtime: { streamSimple } }, signal: undefined };
    const out = await handleReadDelegation(bigReadEvent, ctx, enabledCfg);
    expect(out).toBeUndefined();
  });

  it('stream error event → undefined', async () => {
    const model = { provider: 'bulk_reader', id: 'bulk_reader' };
    const streamSimple = vi.fn(async function* () {
      yield { type: 'error', error: 'provider exploded' };
    });
    const ctx = { modelRegistry: { find: vi.fn(() => model), runtime: { streamSimple } }, signal: undefined };
    const out = await handleReadDelegation(bigReadEvent, ctx, enabledCfg);
    expect(out).toBeUndefined();
  });

  it('narration-only sub-output (no real summary) → undefined', async () => {
    const { ctx } = makeCtx(summaryEvents('> [router] a — provider error, trying b\n\n'));
    const out = await handleReadDelegation(bigReadEvent, ctx, enabledCfg);
    expect(out).toBeUndefined();
  });

  it('empty sub-output → undefined', async () => {
    const { ctx } = makeCtx([]);
    const out = await handleReadDelegation(bigReadEvent, ctx, enabledCfg);
    expect(out).toBeUndefined();
  });
});

// ── Integration: default-export wiring ─────────────────────────────────
//
// Boots the real extension (mock Pi), runs session_start so cfg is
// initialized from the layered config (delegation enabled via the CWD
// layer — user intent), then invokes the tool_result handler with an
// oversized read and asserts the replacement comes back. This pins the
// wiring (config → handler → module), not the module logic (covered above).

describe('default export wiring: tool_result returns the delegation replacement', () => {
  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dynamicConfigPath = path.join(repoRoot, 'router-config.dynamic.json');
  const scanCachePath = path.join(repoRoot, '.cache', 'scan-cache.json');

  // Production-realistic registry model (cost is mandatory on real models).
  const KNOWN_MODEL = {
    provider: 'mistral',
    id: 'mistral-medium-3.5',
    api: 'openai-completions',
    contextWindow: 128_000,
    cost: { input: 0.4, output: 1.2, cacheRead: 0.04, cacheWrite: 0 },
  };

  it('end-to-end: enabled config → oversized read → replacement with nested usage', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-delegation-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.pi', 'router-config.json'),
      JSON.stringify({
        free_models: [],
        providers: {},
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        delegation: { enabled: true },
      })
    );
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    const dynBak = `${dynamicConfigPath}.delegation-bak`;
    await acquireRouterStateLock();
    const hadDyn = fs.existsSync(dynamicConfigPath);
    if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
    writeNoOpScanCache(scanCachePath);

    try {
      vi.resetModules();
      const mod = await import('../index.ts');

      const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
      const pi: any = {
        registerTool: vi.fn(),
        registerCommand: vi.fn(),
        registerProvider: vi.fn(),
        setModel: vi.fn(async () => true),
        on: vi.fn((event: string, handler: any) => {
          onHandlers[event] = handler;
        }),
      };
      (mod.default as any)(pi);

      const sessionCtx = {
        modelRegistry: {
          getAvailable: () => [KNOWN_MODEL],
          getRegisteredProviderIds: () => [] as string[],
          find: (provider: string, modelId: string) =>
            provider === 'mistral' && modelId === KNOWN_MODEL.id ? KNOWN_MODEL : null,
          getApiKeyForProvider: async () => 'test-key',
          runtime: { streamSimple: vi.fn() },
        },
        cwd: tmpDir,
        ui: { setFooter: vi.fn() },
      };
      await onHandlers['session_start']?.({}, sessionCtx);
      await flushBackgroundScan();

      // The ctx the tool_result handler receives: delegation group resolves
      // and the sub-call streams a (narration-polluted, spike-style) summary.
      const model = { provider: 'bulk_reader', id: 'bulk_reader' };
      async function* summaryStream() {
        yield { type: 'text_delta', delta: '> [router] some candidate failed, trying next\n\n' };
        yield { type: 'text_delta', delta: 'The fixture contains one long run of delegated filler characters.' };
        yield {
          type: 'message_end',
          usage: { input: 100, output: 20, totalTokens: 120, cost: { total: 0.001 } },
        };
      }
      const resultCtx = {
        modelRegistry: {
          find: vi.fn(() => model),
          runtime: { streamSimple: vi.fn(() => summaryStream()) },
        },
        signal: undefined,
        ui: { setFooter: vi.fn() },
      };

      const out = await onHandlers['tool_result'](
        { toolName: 'read', content: [{ type: 'text', text: 'x'.repeat(21000) }], isError: false },
        resultCtx
      );

      expect(out).toBeDefined();
      const text = out.content[0].text as string;
      expect(text).toMatch(/delegated summary of a 21000-char read result/);
      expect(text).toContain('The fixture contains one long run of delegated filler characters.');
      // Spike finding: narration must not survive into the replacement.
      expect(text).not.toContain('[router]');
      expect(out.usage).toMatchObject({ totalTokens: 120 });
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
      removeNoOpScanCache(scanCachePath);
      releaseRouterStateLock();
    }
  });
});
