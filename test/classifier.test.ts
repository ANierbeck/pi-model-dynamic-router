// test/classifier.test.ts
// Unit-Tests für die inhaltssensitive Klassifizierung (ohne Ollama)

import { describe, it, beforeEach, expect, vi } from "vitest";
import { classifyPrompt, CATEGORY_TO_GROUP } from "../src/content-classifier";
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
});
