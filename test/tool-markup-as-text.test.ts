/**
 * I4 — tool-call markup emitted as TEXT must not count as a good answer.
 *
 * Live incident (2026-11-05, router.log 10:53–10:54Z): `openrouter/openrouter/free`
 * served ten consecutive turns with `stopReason: toolUse` and 0–3 characters of
 * text. The model had not called a tool — it printed its tool call as prose in
 * a pseudo-XML dialect (`<dots_function_call>…</dots_function_call>`), so Pi's
 * parser saw no tool call, the turn ended, and `consumeWithDetection` returned
 * `{ ok: true }` → `recordOk` → the model was REWARDED for it. The same class
 * is documented in src/agent-capability.ts ("35+ consecutive 0–220-char
 * toolUse turns", 2026-09-27) as a failure mode no detector could see, because
 * the stream finishes normally.
 *
 * The fix (TODO.md I4): when the request carries tools, hold the leading text
 * until either a tool-call event arrives or the hold window fills. If the
 * stream ends with no tool call and the held text starts with a generic wire
 * marker, treat it as a soft failure and hand the turn to the next candidate —
 * without ever forwarding the markup to the user.
 *
 * Markers are FORMAT markers, never model names (ADR-0025 §9): the check must
 * catch any dialect, including ones that do not exist yet.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { writeNoOpScanCache, removeNoOpScanCache, flushBackgroundScan } from './helpers/noop-scan-cache.ts';
import { drainStream, makeExtensionContext } from './helpers/extension-harness.ts';

const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

const textOf = (events: any[]): string =>
  events
    .filter((e) => e.type === 'text_delta')
    .map((e) => String(e.delta ?? ''))
    .join('');

const doneMessage = (stopReason = 'stop') => ({
  role: 'assistant',
  content: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  stopReason,
  timestamp: Date.now(),
});

interface HarnessOptions {
  /** Per-model-id generator body. Receives nothing; yields raw stream events. */
  bodies: Record<string, () => AsyncGenerator<any>>;
}

/**
 * Boots the real extension with two candidates in `standard`, both unscored
 * except for the gdpval_builtin ranking hint that puts `first-model` ahead.
 */
async function bootHarness(opts: HarnessOptions) {
  const tmpDir = fs.mkdtempSync('/tmp/tool-markup-');
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, '.pi', 'router-config.json'),
    JSON.stringify({
      free_models: [],
      providers: { openrouter: { free_models: [] } },
      rate_limit_wait_max_ms: 0,
      model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
      gdpval_builtin: { 'first-model': 1400, 'second-model': 900 },
    }),
  );
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  writeNoOpScanCache(scanCachePath);

  vi.resetModules();
  const mod = await import('../index.ts');
  const defaultExport = mod.default as any;

  const { ctx: pi, onHandlers } = makeExtensionContext();
  defaultExport(pi);

  const mkModel = (id: string) => ({
    provider: 'markup-provider',
    id,
    api: 'openai-completions',
    contextWindow: 1_000_000,
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
  });
  const models = [mkModel('first-model'), mkModel('second-model')];
  const streamSimple = vi.fn((model: any) => {
    const body = opts.bodies[model.id];
    if (!body) throw new Error(`unexpected model ${model.id}`);
    return body();
  });
  const modelRegistry = {
    getAvailable: () => models,
    find: (_p: string, modelId: string) => models.find((m) => m.id === modelId) ?? null,
    getApiKeyForProvider: async () => null,
    runtime: { streamSimple },
  };
  const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn(), notify: vi.fn() } };
  await onHandlers['session_start']?.({}, ctx);
  await flushBackgroundScan();

  const stream = async (context: any) =>
    drainStream(defaultExport.groupStream({ provider: 'standard', id: 'standard' }, context, {}));

  const cleanup = () => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    removeNoOpScanCache(scanCachePath);
  };

  return { stream, cleanup, streamSimple };
}

const USER_TURN = { messages: [{ role: 'user', content: 'do the thing' }] };
const WITH_TOOLS = {
  messages: [{ role: 'user', content: 'do the thing' }],
  tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: {} } }],
};

describe('I4: tool-call markup printed as text', () => {
  it('falls over to the next candidate and never forwards the markup (the 2026-11-05 incident)', async () => {
    const harness = await bootHarness({
      bodies: {
        'first-model': async function* () {
          // Exactly the observed shape: the tool call as prose, no tool-call
          // event, and the stream terminates normally.
          yield { type: 'text_delta', delta: '<dots_function_call>\n<invoke name="edit">\n</dots_function_call>' };
          yield { type: 'done', reason: 'stop', message: doneMessage('toolUse') };
        },
        'second-model': async function* () {
          yield { type: 'text_delta', delta: 'ANSWER-FROM-SECOND' };
          yield { type: 'done', reason: 'stop', message: doneMessage() };
        },
      },
    });
    try {
      const events = await harness.stream(WITH_TOOLS);
      const text = textOf(events);

      // The markup was held back and dropped — the user never sees it.
      expect(text).not.toContain('dots_function_call');
      expect(text).toContain('ANSWER-FROM-SECOND');
      // The fallback was narrated with the real reason, not "empty response".
      expect(text).toMatch(/first-model[\s\S]*tool-call markup as text/);
      // Both candidates were actually tried.
      expect(harness.streamSimple).toHaveBeenCalledTimes(2);
    } finally {
      harness.cleanup();
    }
  });

  it('accepts the same text when the request carries no tools (prose must not be punished)', async () => {
    const harness = await bootHarness({
      bodies: {
        'first-model': async function* () {
          yield { type: 'text_delta', delta: '<dots_function_call> is just prose here' };
          yield { type: 'done', reason: 'stop', message: doneMessage() };
        },
      },
    });
    try {
      const events = await harness.stream(USER_TURN);
      expect(textOf(events)).toContain('dots_function_call');
      expect(harness.streamSimple).toHaveBeenCalledTimes(1);
    } finally {
      harness.cleanup();
    }
  });

  it('accepts plain prose with tools present and no tool call', async () => {
    const harness = await bootHarness({
      bodies: {
        'first-model': async function* () {
          yield { type: 'text_delta', delta: 'Here is the answer: 42.' };
          yield { type: 'done', reason: 'stop', message: doneMessage() };
        },
      },
    });
    try {
      const events = await harness.stream(WITH_TOOLS);
      expect(textOf(events)).toContain('Here is the answer: 42.');
      expect(harness.streamSimple).toHaveBeenCalledTimes(1);
    } finally {
      harness.cleanup();
    }
  });

  it('accepts a real tool call with tools present', async () => {
    const harness = await bootHarness({
      bodies: {
        'first-model': async function* () {
          yield { type: 'toolcall_start', contentIndex: 0, partial: {} } as any;
          yield { type: 'toolcall_delta', contentIndex: 0, delta: '{"path":"a"}' } as any;
          yield { type: 'toolcall_end', contentIndex: 0, toolCall: { id: 't1', name: 'read', arguments: {} } } as any;
          yield { type: 'done', reason: 'stop', message: doneMessage('toolUse') };
        },
      },
    });
    try {
      const events = await harness.stream(WITH_TOOLS);
      const types = events.map((e) => e.type);
      expect(types).toContain('toolcall_start');
      expect(harness.streamSimple).toHaveBeenCalledTimes(1);
    } finally {
      harness.cleanup();
    }
  });

  it('flushes a held answer once it outgrows the hold window', async () => {
    // Varied words on purpose: a repeated unit would trip the repetition guard
    // and mask what this test pins (the hold window, not the loop detector).
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    const harness = await bootHarness({
      bodies: {
        'first-model': async function* () {
          yield { type: 'text_delta', delta: long };
          yield { type: 'done', reason: 'stop', message: doneMessage() };
        },
      },
    });
    try {
      const events = await harness.stream(WITH_TOOLS);
      expect(textOf(events)).toContain(long);
      expect(harness.streamSimple).toHaveBeenCalledTimes(1);
    } finally {
      harness.cleanup();
    }
  });
});

describe('I4 review round (2026-11-05): the hold must not leak, reorder or drop the wrong things', () => {
  it('never forwards overflow text that was held before the overflow was recognised', async () => {
    // The first delta alone is not an overflow message; the second completes the
    // pattern ("exceeds the maximum context length"). The first must not reach the
    // user when the candidate is rejected.
    const harness = await bootHarness({
      bodies: {
        'first-model': async function* () {
          yield { type: 'text_delta', delta: 'The request exceeds the' };
          yield { type: 'text_delta', delta: ' maximum context length of this model' };
          yield { type: 'done', reason: 'stop', message: doneMessage() };
        },
      },
    });
    try {
      const events = await harness.stream(WITH_TOOLS);
      expect(textOf(events)).not.toContain('The request exceeds the');
      expect(textOf(events)).not.toContain('maximum context length');
    } finally {
      harness.cleanup();
    }
  });

  it('keeps holding a tool-call markup block that outgrows the window, so it never reaches the user', async () => {
    // A realistic call with JSON arguments is well over 200 characters.
    const args = Array.from({ length: 60 }, (_, i) => `k${i}:v${i * 7}`).join(',');
    const markup = `<tool_call>{"name":"write","arguments":{${args}}}</tool_call>`;
    const harness = await bootHarness({
      bodies: {
        'first-model': async function* () {
          for (let i = 0; i < markup.length; i += 90) {
            yield { type: 'text_delta', delta: markup.slice(i, i + 90) };
          }
          yield { type: 'done', reason: 'stop', message: doneMessage('toolUse') };
        },
        'second-model': async function* () {
          yield { type: 'text_delta', delta: 'ANSWER-FROM-SECOND' };
          yield { type: 'done', reason: 'stop', message: doneMessage() };
        },
      },
    });
    try {
      const events = await harness.stream(WITH_TOOLS);
      expect(textOf(events)).not.toContain('tool_call');
      expect(textOf(events)).toContain('ANSWER-FROM-SECOND');
      expect(harness.streamSimple).toHaveBeenCalledTimes(2);
    } finally {
      harness.cleanup();
    }
  });

  it('keeps the partial answer when the stream is aborted while the hold is open', async () => {
    const harness = await bootHarness({
      bodies: {
        'first-model': async function* () {
          yield { type: 'text_delta', delta: 'partial answer' };
          yield {
            type: 'error',
            reason: 'aborted',
            error: { role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Aborted', timestamp: Date.now() },
          };
        },
      },
    });
    try {
      const events = await harness.stream(WITH_TOOLS);
      expect(textOf(events)).toContain('partial answer');
    } finally {
      harness.cleanup();
    }
  });

  it('forwards text_start, text_delta and text_end in the order the provider sent them', async () => {
    const harness = await bootHarness({
      bodies: {
        'first-model': async function* () {
          yield { type: 'text_start', contentIndex: 0, partial: {} } as any;
          yield { type: 'text_delta', contentIndex: 0, delta: 'Here is the answer: 42.', partial: {} } as any;
          yield { type: 'text_end', contentIndex: 0, content: 'Here is the answer: 42.', partial: {} } as any;
          yield { type: 'done', reason: 'stop', message: doneMessage() };
        },
      },
    });
    try {
      const events = await harness.stream(WITH_TOOLS);
      // The router's own narration is text too; only the block around the answer counts.
      const seq = events.filter((e) => String(e.type).startsWith('text_'));
      const at = seq.findIndex((e) => e.type === 'text_delta' && String(e.delta).includes('Here is the answer'));
      expect(at).toBeGreaterThan(0);
      expect(seq[at - 1].type).toBe('text_start');
      expect(seq[at + 1].type).toBe('text_end');
    } finally {
      harness.cleanup();
    }
  });

  it('accepts an answer that shows a fenced tool-call example (the fence is prose, not the opening)', async () => {
    const harness = await bootHarness({
      bodies: {
        'first-model': async function* () {
          yield { type: 'text_delta', delta: '```xml\n<tool_call>read</tool_call>\n```\nThat is how a call looks.' };
          yield { type: 'done', reason: 'stop', message: doneMessage() };
        },
      },
    });
    try {
      const events = await harness.stream(WITH_TOOLS);
      expect(textOf(events)).toContain('That is how a call looks.');
      expect(harness.streamSimple).toHaveBeenCalledTimes(1);
    } finally {
      harness.cleanup();
    }
  });
});
