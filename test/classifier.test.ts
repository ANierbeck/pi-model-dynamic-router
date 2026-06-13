// test/classifier.test.ts
// Unit-Tests für die inhaltssensitive Klassifizierung (ohne Ollama)

import { describe, it, beforeEach, expect, vi } from "vitest";
import { classifyPrompt, CATEGORY_TO_GROUP, classifyStatically } from "../src/content-classifier";
import * as ollamaUtils from "../src/ollama-utils";

// ── Mock für Ollama-Aufrufe (für Unit-Tests) ───────────────────────────────

vi.mock("../src/ollama-utils", () => ({
  callOllama: vi.fn(),
}));

// ── Testfälle ────────────────────────────────────────────────────────────

describe("classifyPrompt (Unit Tests)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("klassifiziert einfache Code-Änderungen als 'code_simple'", async () => {
    vi.mocked(ollamaUtils.callOllama).mockResolvedValue(
      '{"category": "code_simple", "reason": "Einfache Textersetzung", "confidence": 0.95}'
    );
    
    const result = await classifyPrompt("Ersetze 'foo' mit 'bar' in Zeile 42");
    expect(result.category).toBe("code_simple");
    expect(result.reason).toContain("Einfache Textersetzung");
    expect(CATEGORY_TO_GROUP[result.category]).toBe("simple");
  });

  it("klassifiziert komplexe Code-Änderungen als 'code_complex'", async () => {
    vi.mocked(ollamaUtils.callOllama).mockResolvedValue(
      '{"category": "code_complex", "reason": "Refactoring erforderlich", "confidence": 0.9}'
    );
    
    const result = await classifyPrompt("Optimiere diese 200-Zeilen-Funktion für Performance");
    expect(result.category).toBe("code_complex");
    expect(CATEGORY_TO_GROUP[result.category]).toBe("complex");
  });

  it("klassifiziert Design-Fragen als 'design'", async () => {
    vi.mocked(ollamaUtils.callOllama).mockResolvedValue(
      '{"category": "design", "reason": "Architektur-Entwurf", "confidence": 0.85}'
    );
    
    const result = await classifyPrompt("Entwirf eine Event-Sourcing-Architektur");
    expect(result.category).toBe("design");
    expect(CATEGORY_TO_GROUP[result.category]).toBe("complex");
  });

  it("klassifiziert unklare Anfragen als 'fallback'", async () => {
    vi.mocked(ollamaUtils.callOllama).mockResolvedValue(
      '{"category": "fallback", "reason": "Unklare Anfrage", "confidence": 0.3}'
    );
    
    const result = await classifyPrompt("Mach das besser");
    expect(result.category).toBe("fallback");
    expect(CATEGORY_TO_GROUP[result.category]).toBe("trivial"); // Default-Fallback
  });

  it("behandelt Ollama-Fehler als Fallback", async () => {
    vi.mocked(ollamaUtils.callOllama).mockRejectedValue(new Error("Ollama not running"));
    
    const result = await classifyPrompt("Irgendeine Anfrage");
    expect(result.category).toBe("fallback");
    expect(result.reason).toMatch(/falling back to static classification|Could not classify/);
  });

  it("validiert das JSON-Format der Ollama-Antwort", async () => {
    vi.mocked(ollamaUtils.callOllama).mockResolvedValue('{"category": "invalid_category", "reason": "test"}');
    
    // Sollte auf Fallback fallen, da "invalid_category" nicht erlaubt ist
    const result = await classifyPrompt("Test");
    expect(result.category).toBe("fallback");
  });

  it("erbt Kategorie für kurze Prompts mit Kontext", async () => {
    const result = await classifyPrompt("Ja", { 
      context: { lastCategory: "code_complex" } 
    });
    expect(result.category).toBe("code_complex");
    expect(result.reason).toContain("Short prompt");
  });

  // ── Static Classification Tests ────────────────────────────────────────────

  describe("classifyStatically", () => {
    it("klassifiziert 'List TODOs' als 'trivial'", () => {
      const result = classifyStatically("List TODOs");
      expect(result.category).toBe("trivial");
      expect(result.reason).toContain("trivial classification");
    });

    it("klassifiziert 'Show me the file' als 'trivial'", () => {
      const result = classifyStatically("Show me the file");
      expect(result.category).toBe("trivial");
    });

    it("klassifiziert 'List files' als 'trivial'", () => {
      const result = classifyStatically("List files");
      expect(result.category).toBe("trivial");
    });

    it("klassifiziert 'What is in this file?' als 'trivial'", () => {
      const result = classifyStatically("What is in this file?");
      expect(result.category).toBe("trivial");
    });

    it("klassifiziert 'Explain briefly' als 'simple'", () => {
      const result = classifyStatically("Explain briefly how this works");
      expect(result.category).toBe("simple");
      expect(result.reason).toContain("simple classification");
    });

    it("klassifiziert 'Summarize this' als 'simple'", () => {
      const result = classifyStatically("Summarize this document");
      expect(result.category).toBe("simple");
    });

    it("klassifiziert 'What does this do?' als 'simple'", () => {
      const result = classifyStatically("What does this function do?");
      expect(result.category).toBe("simple");
    });

    it("klassifiziert 'Fix syntax error' als 'code_simple'", () => {
      const result = classifyStatically("Fix syntax error in line 5");
      expect(result.category).toBe("code_simple");
      expect(result.reason).toContain("code_simple classification");
    });

    it("klassifiziert 'Explain this concept' als 'simple'", () => {
      const result = classifyStatically("Explain this concept in detail");
      expect(result.category).toBe("simple");
      expect(result.reason).toContain("simple classification");
    });

    it("klassifiziert 'Refactor this function' als 'code_complex'", () => {
      const result = classifyStatically("Refactor this 200-line function for performance");
      expect(result.category).toBe("code_complex");
      expect(result.reason).toContain("code_complex classification");
    });

    it("klassifiziert 'Design an architecture' als 'code_complex'", () => {
      const result = classifyStatically("Design an architecture for this system");
      expect(result.category).toBe("code_complex");
      expect(result.reason).toContain("code_complex classification");
    });

    it("klassifiziert 'Create a roadmap' als 'planning'", () => {
      const result = classifyStatically("Create a roadmap for this project");
      expect(result.category).toBe("planning");
      expect(result.reason).toContain("planning classification");
    });

    it("klassifiziert 'What could we do about X?' als 'exploration'", () => {
      const result = classifyStatically("What could we do about this problem?");
      expect(result.category).toBe("exploration");
      expect(result.reason).toContain("exploration classification");
    });

    it("klassifiziert unbekannte Anfragen als 'fallback'", () => {
      const result = classifyStatically("Some completely unknown request with no keywords");
      expect(result.category).toBe("fallback");
      expect(result.reason).toContain("Could not classify");
    });
  });
});
