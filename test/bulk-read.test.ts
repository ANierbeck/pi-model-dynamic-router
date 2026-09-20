/**
 * Unit tests for the bulk_read tool + read pre-call block (shunt Layer 1+2,
 * ADR-0007 revision 2026-09-20): the multi-file question-answering route
 * that keeps file contents out of the expensive model's context entirely.
 *
 * Spotify/shunt semantics under test:
 *   - bulk_read(question, paths[]): the tool ITSELF reads the files from
 *     disk, sends them to the delegation group (bulk_reader), and returns
 *     the concise answer — the orchestrator never ingests the raw content.
 *   - checkReadBlock: a full-file read (no offset/limit) of a file above
 *     the line threshold is BLOCKED with a reason that redirects to
 *     bulk_read or a targeted (offset/limit) read. Targeted reads pass.
 *
 * Everything else — small files, targeted reads, disabled config, stat
 * failures — must pass through untouched (fail-open, like the shrinker).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  countLines,
  checkReadBlock,
  executeBulkRead,
  buildBulkReadPrompt,
} from '../src/bulk-read';
import { delegationSettings, isTargetedReadInput } from '../src/delegation';
import type { Config } from '../src/types';

// ── settings ──────────────────────────────────────────────────────────────

describe('delegationSettings: block_lines (shunt SHUNT_MIN_LINES equivalent)', () => {
  it('defaults to 350 lines, disabled only when explicitly zeroed', () => {
    const s = delegationSettings({ model_groups: {}, delegation: { enabled: true } } as Config);
    expect(s.block_lines).toBe(350);
  });

  it('block_lines 0 disables pre-call blocking (shrinker keeps working)', () => {
    const s = delegationSettings({
      model_groups: {},
      delegation: { enabled: true, block_lines: 0 },
    } as Config);
    expect(s.block_lines).toBe(0);
  });

  it('invalid block_lines values fall back to the default', () => {
    const bad = delegationSettings({
      model_groups: {},
      delegation: { enabled: true, block_lines: -5 },
    } as unknown as Config);
    expect(bad.block_lines).toBe(350);
    const notNumber = delegationSettings({
      model_groups: {},
      delegation: { enabled: true, block_lines: 'many' },
    } as unknown as Config);
    expect(notNumber.block_lines).toBe(350);
  });
});

// ── targeted-read detection (shared with the shrinker's exemption) ─────────

describe('isTargetedReadInput', () => {
  it('offset or limit marks a targeted read', () => {
    expect(isTargetedReadInput({ path: 'a.ts', offset: 10 })).toBe(true);
    expect(isTargetedReadInput({ path: 'a.ts', limit: 50 })).toBe(true);
    expect(isTargetedReadInput({ path: 'a.ts', offset: 1, limit: 5 })).toBe(true);
  });

  it('a bare path is a full-file (bulk) read', () => {
    expect(isTargetedReadInput({ path: 'a.ts' })).toBe(false);
    expect(isTargetedReadInput(undefined)).toBe(false);
    expect(isTargetedReadInput({})).toBe(false);
  });
});

// ── line counting ──────────────────────────────────────────────────────────

describe('countLines', () => {
  it('counts newline-terminated and unterminated final lines', () => {
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('')).toBe(0);
    expect(countLines('only')).toBe(1);
  });
});

// ── checkReadBlock (shunt Layer 1: check-file-size) ───────────────────────

describe('checkReadBlock', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-read-block-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const cfg = { model_groups: {}, delegation: { enabled: true } } as Config;

  const bigFile = (lines: number) => {
    const p = path.join(dir, `big-${lines}.txt`);
    fs.writeFileSync(p, 'line\n'.repeat(lines));
    return p;
  };

  it('blocks a full-file read of a file above the line threshold', () => {
    const p = bigFile(400); // > default 350
    const out = checkReadBlock({ toolName: 'read', input: { path: p } }, cfg);
    expect(out).toBeDefined();
    expect(out!.block).toBe(true);
    // The reason is the redirect: it must teach BOTH alternative routes.
    expect(out!.reason).toMatch(/bulk_read/);
    expect(out!.reason).toMatch(/offset/);
    expect(out!.reason).toContain(String(400));
  });

  it('targeted reads (offset/limit) pass even on huge files', () => {
    const p = bigFile(5000);
    expect(checkReadBlock({ toolName: 'read', input: { path: p, offset: 100 } }, cfg)).toBeUndefined();
    expect(checkReadBlock({ toolName: 'read', input: { path: p, limit: 20 } }, cfg)).toBeUndefined();
  });

  it('small files pass (below threshold the delegation overhead exceeds savings)', () => {
    const p = bigFile(100);
    expect(checkReadBlock({ toolName: 'read', input: { path: p } }, cfg)).toBeUndefined();
  });

  it('block_lines 0 disables blocking entirely', () => {
    const p = bigFile(400);
    const off = { model_groups: {}, delegation: { enabled: true, block_lines: 0 } } as Config;
    expect(checkReadBlock({ toolName: 'read', input: { path: p } }, off)).toBeUndefined();
  });

  it('disabled delegation disables blocking (feature is one switch)', () => {
    const p = bigFile(400);
    const disabled = { model_groups: {}, delegation: { enabled: false } } as Config;
    expect(checkReadBlock({ toolName: 'read', input: { path: p } }, disabled)).toBeUndefined();
  });

  it('non-read tools pass (bash is guarded by the shrinker, not the block)', () => {
    const p = bigFile(400);
    expect(checkReadBlock({ toolName: 'bash', input: { command: `cat ${p}` } }, cfg)).toBeUndefined();
    expect(checkReadBlock({ toolName: 'edit', input: {} }, cfg)).toBeUndefined();
  });

  it('missing files / stat failures fail open (the read tool reports the error itself)', () => {
    const p = path.join(dir, 'does-not-exist.txt');
    expect(checkReadBlock({ toolName: 'read', input: { path: p } }, cfg)).toBeUndefined();
  });
});

// ── executeBulkRead (shunt Layer 2: bulk-read script) ──────────────────────

describe('executeBulkRead', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-read-tool-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const cfg = { model_groups: {}, delegation: { enabled: true } } as Config;

  const makeCtx = (events: any[]) => {
    const model = { provider: 'bulk_reader', id: 'bulk_reader' };
    const streamSimple = vi.fn(async function* () {
      for (const e of events) yield e;
    });
    return {
      ctx: { modelRegistry: { find: vi.fn(() => model), runtime: { streamSimple } }, signal: undefined },
      streamSimple,
    };
  };

  const summaryEvents = (text: string) => [
    { type: 'text_start', contentIndex: 0 },
    { type: 'text_delta', delta: text },
    { type: 'text_end', content: text },
    { type: 'message_end', usage: { input: 4200, output: 90, totalTokens: 4290, cost: { total: 0.0002 } } },
  ];

  const writeFile = (name: string, text: string) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, text);
    return p;
  };

  it('reads files from disk, asks the group, returns the answer — raw content never in output', async () => {
    const a = writeFile('a.ts', 'export function alpha() { return 1; }');
    const b = writeFile('b.ts', 'export function beta() { return 2; }');
    const { ctx, streamSimple } = makeCtx(summaryEvents('• a.ts: alpha() returns 1\n• b.ts: beta() returns 2'));
    const out = await executeBulkRead(
      { question: 'What do these files export?', paths: [a, b] },
      ctx,
      cfg,
      () => {}
    );
    expect(streamSimple).toHaveBeenCalledTimes(1);
    const text = out.content[0].text as string;
    expect(text).toContain('alpha()');
    // The tool result is ONLY the answer — the raw file content must not
    // ride along into the expensive model's context.
    expect(text).not.toContain('export function');
    // Nested usage accounting rides on the result.
    expect(out.usage).toEqual({ input: 4200, output: 90, totalTokens: 4290, cost: { total: 0.0002 } });
  });

  it('wraps each file in XML tags with its path (shunt: clear boundaries)', async () => {
    const a = writeFile('a.ts', 'ALPHA_CONTENT_MARKER');
    const { ctx, streamSimple } = makeCtx(summaryEvents('A summary long enough to pass every trust check we have.'));
    await executeBulkRead({ question: 'q?', paths: [a] }, ctx, cfg, () => {});
    const call = streamSimple.mock.calls[0];
    const prompt = JSON.stringify(call[1]);
    expect(prompt).toContain('<file path=');
    expect(prompt).toContain('ALPHA_CONTENT_MARKER');
    expect(prompt).toContain('q?');
  });

  it('a missing file throws — the orchestrator sees isError and falls back to read', async () => {
    const missing = path.join(dir, 'nope.ts');
    const { ctx, streamSimple } = makeCtx(summaryEvents('unused'));
    await expect(
      executeBulkRead({ question: 'q?', paths: [missing] }, ctx, cfg, () => {})
    ).rejects.toThrow(/nope\.ts/);
    expect(streamSimple).not.toHaveBeenCalled();
  });

  it('an empty paths list throws (nothing to answer from)', async () => {
    const { ctx, streamSimple } = makeCtx(summaryEvents('unused'));
    await expect(executeBulkRead({ question: 'q?', paths: [] }, ctx, cfg, () => {})).rejects.toThrow();
    expect(streamSimple).not.toHaveBeenCalled();
  });

  it('group model not registered → throws (honest error, caller falls back)', async () => {
    const a = writeFile('a.ts', 'content');
    const ctx = {
      ctx: {
        modelRegistry: { find: vi.fn(() => null), runtime: { streamSimple: vi.fn() } },
        signal: undefined,
      },
    };
    await expect(executeBulkRead({ question: 'q?', paths: [a] }, ctx as any, cfg, () => {})).rejects.toThrow(
      /bulk_reader/
    );
  });

  it('caps total raw chars sent to the summarizer (max_raw_chars protects the sub-call prompt)', async () => {
    const a = writeFile('a.txt', 'y'.repeat(40000));
    const b = writeFile('b.txt', 'z'.repeat(40000));
    const { ctx, streamSimple } = makeCtx(summaryEvents('A summary long enough to pass every trust check we have.'));
    await executeBulkRead({ question: 'q?', paths: [a, b] }, ctx, cfg, () => {});
    const call = streamSimple.mock.calls[0];
    const prompt = String((call[1] as any).messages[0].content);
    // 80K raw > 60K cap → truncated, and the truncation is visible to the
    // summarizer so it does not pretend it saw whole files.
    expect(prompt.length).toBeLessThan(70000);
    expect(prompt).toMatch(/truncated/i);
  });

  it('disabled delegation → throws (tool only ships with the feature)', async () => {
    const a = writeFile('a.ts', 'content');
    const { ctx, streamSimple } = makeCtx(summaryEvents('unused'));
    const disabled = { model_groups: {}, delegation: { enabled: false } } as Config;
    await expect(executeBulkRead({ question: 'q?', paths: [a] }, ctx, disabled, () => {})).rejects.toThrow();
    expect(streamSimple).not.toHaveBeenCalled();
  });
});

// ── buildBulkReadPrompt (shunt bulk-reader mode instructions) ──────────────

describe('buildBulkReadPrompt', () => {
  it('demands structured bullets, no prose, exact names/line numbers', () => {
    const prompt = buildBulkReadPrompt('Which methods call the database?', [
      { path: 'src/Service.java', content: 'class Service {}' },
    ]);
    expect(prompt).toContain('Which methods call the database?');
    expect(prompt).toContain('<file path="src/Service.java">');
    expect(prompt).toContain('class Service {}');
    // shunt bulk-reader instructions: structured bullets, no greetings/prose,
    // lead with exact names/types/line numbers, skip unasked content.
    expect(prompt.toLowerCase()).toContain('bullet');
    expect(prompt.toLowerCase()).toContain('line number');
  });
});
