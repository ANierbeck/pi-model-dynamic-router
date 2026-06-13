// test/integration.test.ts
// Integrationstests für das gesamte Routing-System

import { describe, it, beforeEach, expect, vi } from "vitest";
import { classifyPrompt, CATEGORY_TO_GROUP } from "../src/content-classifier.js";
import * as ollamaUtils from "../src/ollama-utils";
import piModelRouter from "../index.js";

// ── Mock für Ollama-Aufrufe ─────────────────────────────────────────────────────

vi.mock("../src/ollama-utils", () => ({
  callOllama: vi.fn(),
}));

// ── Testfälle ──────────────────────────────────────────────────────────────

describe("groupStream (Integration Tests)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("behandelt HINT-Override im Prompt", async () => {
    vi.mocked(ollamaUtils.callOllama).mockResolvedValue(
      '{"category": "code_simple", "reason": "Einfache Textersetzung", "confidence": 0.95}'
    );
    
    // Initialize the plugin to set up groupStream
    const mockPi = {
      on: vi.fn(),
      ui: { notify: vi.fn() },
      extension: { dir: '/test/dir' }
    };
    piModelRouter(mockPi);
    
    const { groupStream } = piModelRouter as any;
    
    const mockModel = {
      id: 'dynamic:use-static',
      provider: 'test',
      name: 'dynamic:use-static',
      api: 'test',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 1000,
    };

    const mockContext = {
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'HINT: use group tactical\nErsetze \'foo\' mit \'bar\' in Zeile 42' }]
      }]
    };

    const stream = groupStream(mockModel, mockContext);
    const messages: any[] = [];
    stream.on('text_delta', (msg) => messages.push(msg));
    await new Promise(resolve => stream.on('end', resolve));

    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].text).toContain("HINT: tactical");
  });
});
