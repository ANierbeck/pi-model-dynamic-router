// test/classifier-memory-block-context.test.ts
//
// Regression: the memory extension's context block must never be read as a
// user message by the classifier-context extractors.
//
// The memory extension (customType "pi-memory-context") injects a standalone
// message `<memory>\n…\n</memory>` directly BEFORE every real user prompt. Pi
// turns it into a `role: 'user'` entry in context.messages, so the
// "second-to-last user message" that feeds the classifier's
// "Previous user message:" line was the memory block for almost every turn
// (found 2026-10-12: 112 of 131 classifier-decision records, 85 %). The real
// previous message never reached the classifier, and every continuation
// ("Soll ich nochmal neu starten?") was judged without its conversation.
//
// Contract pinned here: a message that is exactly one `<memory>…</memory>`
// block is not a user message, for both the previous-message and the
// current-prompt extractor. A real message that merely mentions the tag
// stays a user message.

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeNoOpScanCache,
  removeNoOpScanCache,
  flushBackgroundScan,
} from './helpers/noop-scan-cache.ts';

vi.mock('../src/ollama-utils.ts', () => ({
  callOllama: vi.fn(async () =>
    JSON.stringify({ category: 'trivial', reason: 'test', confidence: 0.9 })
  ),
  isOllamaAvailable: vi.fn(async () => true),
}));

const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

const MEMORY_BODY = 'final_fix_2026_05_31: Extension komplett neu aufgebaut, altes Verzeichnis geloescht';
const memoryBlock = `<memory>\n## Relevant Memory\n- ${MEMORY_BODY}\n</memory>`;

/** Runs one groupStream turn through the real router and returns the text the classifier saw. */
async function classifierSees(messages: any[]): Promise<string> {
  const ollamaUtils = await import('../src/ollama-utils.ts');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-memory-block-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, '.pi', 'router-config.json'),
    JSON.stringify({
      free_models: [],
      providers: {},
      model_groups: {
        dynamic: { method: 'dynamic' },
        scout: { method: 'best', min_gdpval: 0, fallback_groups: [] },
      },
      gdpval_builtin: { 'ollama/scout-model': 100 },
    })
  );
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  const dynBak = `${dynamicConfigPath}.memblock-bak`;
  const cacheBak = `${scanCachePath}.memblock-bak`;
  const hadDyn = fs.existsSync(dynamicConfigPath);
  const hadCache = fs.existsSync(scanCachePath);
  if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
  if (hadCache) fs.renameSync(scanCachePath, cacheBak);
  writeNoOpScanCache(scanCachePath, { localModels: ['foo:3b'] });

  try {
    vi.resetModules();
    const defaultExport = (await import('../index.ts')).default as any;
    vi.mocked(ollamaUtils.callOllama).mockClear();

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
    defaultExport(pi);

    const scoutModel = { provider: 'ollama', id: 'scout-model', api: 'openai-completions', contextWindow: 100_000 };
    const streamSimple = vi.fn(() =>
      (async function* () {
        yield { type: 'text_delta', delta: 'scout reply' };
        yield { type: 'done' };
      })()
    );
    const modelRegistry = {
      getAvailable: () => [scoutModel],
      find: () => scoutModel,
      getApiKeyForProvider: async () => null,
      runtime: { streamSimple },
    };
    const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
    await onHandlers['session_start']?.({}, ctx);
    await flushBackgroundScan();

    for await (const _ev of defaultExport.groupStream({ provider: 'dynamic', id: 'dynamic' }, { messages }, {})) {
      /* drain so classification runs */
    }
    expect(vi.mocked(ollamaUtils.callOllama)).toHaveBeenCalledTimes(1);
    return vi.mocked(ollamaUtils.callOllama).mock.calls[0][1] as string;
  } finally {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
    removeNoOpScanCache(scanCachePath);
    if (hadCache) fs.renameSync(cacheBak, scanCachePath);
  }
}

describe('classifier context: the memory extension block is not a user message', () => {
  it('"Previous user message" is the real previous message, not the memory block', async () => {
    const seen = await classifierSees([
      { role: 'user', content: memoryBlock },
      { role: 'user', content: 'Pi ist neu gestartet, es sollte jetzt alles funktionieren.' },
      { role: 'assistant', content: 'Der Build ist vollstaendig und korrekt.' },
      { role: 'user', content: memoryBlock },
      { role: 'user', content: 'Soll ich nochmal neu starten?' },
    ]);
    expect(seen).toContain('Previous user message: "Pi ist neu gestartet');
    expect(seen).not.toContain('<memory>');
    expect(seen).not.toContain(MEMORY_BODY.slice(0, 30));
    expect(seen).toContain('Soll ich nochmal neu starten?');
  }, 30000);

  it('first turn: no previous message at all (the block alone must not become one)', async () => {
    const seen = await classifierSees([
      { role: 'user', content: memoryBlock },
      { role: 'user', content: 'Wie ist der Stand der Tests im Repo gerade?' },
    ]);
    expect(seen).not.toContain('Previous user message');
    expect(seen).not.toContain(MEMORY_BODY.slice(0, 30));
  }, 30000);

  it('array-form content blocks are recognised too', async () => {
    const seen = await classifierSees([
      { role: 'user', content: [{ type: 'text', text: 'Bitte pruefe die Konfiguration des Routers.' }] },
      { role: 'assistant', content: 'Erledigt.' },
      { role: 'user', content: [{ type: 'text', text: memoryBlock }] },
      { role: 'user', content: [{ type: 'text', text: 'Und was ist mit dem Cache?' }] },
    ]);
    expect(seen).toContain('Previous user message: "Bitte pruefe die Konfiguration');
    expect(seen).not.toContain('<memory>');
  }, 30000);

  it('a block that is the LAST user entry is never classified as the request', async () => {
    const seen = await classifierSees([
      { role: 'user', content: 'Frueher gestellte Frage zum Thema Logging im Router.' },
      { role: 'assistant', content: 'Antwort.' },
      { role: 'user', content: 'Aktuelle Anfrage: fasse den Diff zusammen.' },
      { role: 'user', content: memoryBlock },
    ]);
    expect(seen).toContain('Aktuelle Anfrage: fasse den Diff zusammen.');
    expect(seen).not.toContain(MEMORY_BODY.slice(0, 30));
  }, 30000);

  it('a real message that merely mentions the tag stays a user message', async () => {
    const seen = await classifierSees([
      { role: 'user', content: 'Warum steht <memory> in meinem Prompt, wenn ich nichts eingebe?' },
      { role: 'assistant', content: 'Das ist die Memory-Extension.' },
      { role: 'user', content: memoryBlock },
      { role: 'user', content: 'Danke, dann lass es so.' },
    ]);
    expect(seen).toContain('Previous user message: "Warum steht <memory> in meinem Prompt');
  }, 30000);

  it('isMemoryContextText: exact block only', async () => {
    const { isMemoryContextText } = await import('../src/utils.ts');
    expect(isMemoryContextText(memoryBlock)).toBe(true);
    expect(isMemoryContextText(`  \n${memoryBlock}\n  `)).toBe(true);
    expect(isMemoryContextText('Warum steht <memory> hier?')).toBe(false);
    expect(isMemoryContextText(`${memoryBlock}\nund noch eine Frage`)).toBe(false);
    expect(isMemoryContextText(`Frage davor\n${memoryBlock}`)).toBe(false);
    expect(isMemoryContextText('')).toBe(false);
  });
});
