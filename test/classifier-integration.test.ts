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

  it("behandelt HINT-Override im Prompt", async () => {
    vi.mocked(ollamaUtils.callOllama).mockResolvedValue(
      '{"category": "code_simple", "reason": "Einfache Textersetzung", "confidence": 0.95}'
    );
    
    const result = await classifyPrompt("HINT: use group tactical\nErsetze 'foo' mit 'bar' in Zeile 42");
    expect(result.category).toBe("code_simple");
    expect(result.reason).toContain("Einfache Textersetzung");
    expect(CATEGORY_TO_GROUP[result.category]).toBe("operational");
  });
});
