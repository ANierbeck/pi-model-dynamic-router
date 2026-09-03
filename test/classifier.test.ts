// test/classifier.test.ts
// Unit tests for content-sensitive classification (without Ollama)

import { describe, it, beforeEach, expect, vi } from "vitest";
import { classifyPrompt, CATEGORY_TO_GROUP, classifyStatically } from "../src/content-classifier.js";
import * as ollamaUtils from "../src/ollama-utils";

// ── Mock for Ollama calls (for unit tests) ────────────────────────────────

vi.mock("../src/ollama-utils", () => ({
  callOllama: vi.fn(),
}));

// ── Test cases ───────────────────────────────────────────────────────────

describe("classifyPrompt (Unit Tests)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("classifies simple code changes as 'code_simple'", async () => {
    vi.mocked(ollamaUtils.callOllama).mockResolvedValue(
      '{"category": "code_simple", "reason": "Simple text replacement", "confidence": 0.95}'
    );
    
    const result = await classifyPrompt("Replace 'foo' with 'bar' in line 42");
    expect(result.category).toBe("code_simple");
    expect(result.reason).toContain("Simple text replacement");
    expect(CATEGORY_TO_GROUP[result.category]).toBe("simple");
  });

  it("classifies complex code changes as 'code_complex'", async () => {
    vi.mocked(ollamaUtils.callOllama).mockResolvedValue(
      '{"category": "code_complex", "reason": "Refactoring required", "confidence": 0.9}'
    );
    
    const result = await classifyPrompt("Optimize this 200-line function for performance");
    expect(result.category).toBe("code_complex");
    expect(CATEGORY_TO_GROUP[result.category]).toBe("tactical");
  });

  it("classifies design questions as 'design'", async () => {
    vi.mocked(ollamaUtils.callOllama).mockResolvedValue(
      '{"category": "design", "reason": "Architecture design", "confidence": 0.85}'
    );
    
    const result = await classifyPrompt("Design an event-sourcing architecture");
    expect(result.category).toBe("design");
    expect(CATEGORY_TO_GROUP[result.category]).toBe("tactical");
  });

  it("classifies unclear requests as 'fallback'", async () => {
    vi.mocked(ollamaUtils.callOllama).mockResolvedValue(
      '{"category": "fallback", "reason": "Unclear request", "confidence": 0.3}'
    );
    
    const result = await classifyPrompt("Make this better");
    expect(result.category).toBe("fallback");
    expect(CATEGORY_TO_GROUP[result.category]).toBe("tactical"); // Default fallback
  });

  it("handles Ollama errors with allowStaticFallback=false (default)", async () => {
    vi.mocked(ollamaUtils.callOllama).mockRejectedValue(new Error("Ollama not running"));
    
    const result = await classifyPrompt("Some request");
    expect(result.category).toBe("fallback");
    expect(result.reason).toBe("Ollama unavailable, static classifier disabled");
  });

  it("handles Ollama errors with allowStaticFallback=true", async () => {
    vi.mocked(ollamaUtils.callOllama).mockRejectedValue(new Error("Ollama not running"));
    
    const result = await classifyPrompt("Explain something", { allowStaticFallback: true });
    expect(result.category).toBe("simple");
    expect(result.reason).toBe("Simple question - simple classification");
  });



  it("validates the JSON format of the Ollama response", async () => {
    vi.mocked(ollamaUtils.callOllama).mockResolvedValue('{"category": "invalid_category", "reason": "test"}');
    
    // Should fall back to fallback, since "invalid_category" is not allowed
    const result = await classifyPrompt("Test");
    expect(result.category).toBe("fallback");
  });

  it("inherits category for short prompts with context", async () => {
    const result = await classifyPrompt("Yes", { 
      context: { lastCategory: "code_complex" } 
    });
    expect(result.category).toBe("code_complex");
    expect(result.reason).toContain("Short prompt");
  });

  // ── Static Classification Tests ────────────────────────────────────────────

  describe("classifyStatically", () => {
    it("classifies 'List TODOs' as 'fallback'", () => {
      const result = classifyStatically("List TODOs");
      expect(result.category).toBe("fallback");
    });

    it("classifies 'Show me the file' as 'fallback'", () => {
      const result = classifyStatically("Show me the file");
      expect(result.category).toBe("fallback");
    });

    it("classifies 'List files' as 'fallback'", () => {
      const result = classifyStatically("List files");
      expect(result.category).toBe("fallback");
    });

    it("classifies 'What is in this file?' as 'simple'", () => {
      const result = classifyStatically("What is in this file?");
      expect(result.category).toBe("simple");
    });


    it("classifies 'Explain briefly' as 'simple'", () => {
      const result = classifyStatically("Explain briefly how this works");
      expect(result.category).toBe("simple");
      expect(result.reason).toContain("simple classification");
    });

    it("classifies 'Summarize this' as 'simple'", () => {
      const result = classifyStatically("Summarize this document");
      expect(result.category).toBe("simple");
    });

    it("classifies 'What does this do?' as 'simple'", () => {
      const result = classifyStatically("What does this function do?");
      expect(result.category).toBe("simple");
    });

    it("classifies 'Fix syntax error' as 'code_simple'", () => {
      const result = classifyStatically("Fix syntax error in line 5");
      expect(result.category).toBe("code_simple");
      expect(result.reason).toContain("code_simple classification");
    });

    it("classifies 'Explain this concept' as 'simple'", () => {
      const result = classifyStatically("Explain this concept in detail");
      expect(result.category).toBe("simple");
      expect(result.reason).toContain("simple classification");
    });

    it("classifies 'Refactor this function' as 'code_complex'", () => {
      const result = classifyStatically("Refactor this 200-line function for performance");
      expect(result.category).toBe("code_complex");
      expect(result.reason).toContain("code_complex classification");
    });

    it("classifies 'Design an architecture' as 'code_complex'", () => {
      const result = classifyStatically("Design an architecture for this system");
      expect(result.category).toBe("code_complex");
      expect(result.reason).toContain("code_complex classification");
    });

    it("classifies 'Create a roadmap' as 'planning'", () => {
      const result = classifyStatically("Create a roadmap for this project");
      expect(result.category).toBe("planning");
      expect(result.reason).toContain("planning classification");
    });

    it("classifies 'What could we do about X?' as 'exploration'", () => {
      const result = classifyStatically("What could we do about this problem?");
      expect(result.category).toBe("exploration");
      expect(result.reason).toContain("exploration classification");
    });

    it("classifies unknown requests as 'fallback'", () => {
      const result = classifyStatically("Some completely unknown request with no keywords");
      expect(result.category).toBe("fallback");
      expect(result.reason).toContain("Could not classify");
    });
  });
});
