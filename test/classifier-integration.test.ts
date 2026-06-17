// test/classifier-integration.test.ts
// Integrationstests für classifyPrompt mit Ollama-Mocks

import { describe, it, beforeEach, expect, vi } from "vitest";
import { classifyPrompt, CATEGORY_TO_GROUP } from "../src/content-classifier.js";
import * as ollamaUtils from "../src/ollama-utils";

// ── Mock für Ollama-Aufrufe ─────────────────────────────────────────────────────

vi.mock("../src/ollama-utils", () => ({
  callOllama: vi.fn(),
}));

// ── Testfälle ──────────────────────────────────────────────────────────────

describe("classifyPrompt (Integration Tests mit Ollama-Mocks)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("erkennt HINT-Override deterministisch ohne LLM-Aufruf", async () => {
    const result = await classifyPrompt("HINT: use group tactical\nErsetze 'foo' mit 'bar' in Zeile 42");
    // detectHintDirectly short-circuits before the LLM is called
    expect(result).toHaveProperty('hintType', 'group');
    expect(result).toHaveProperty('hintTarget', 'tactical');
    expect(result).toHaveProperty('confidence', 1.0);
    expect(vi.mocked(ollamaUtils.callOllama)).not.toHaveBeenCalled();
  });
});
