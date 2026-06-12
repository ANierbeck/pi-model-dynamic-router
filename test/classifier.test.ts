// test/classifier.test.ts
// Tests für die inhaltssensitive Klassifizierung

import { classifyPrompt, CATEGORY_TO_GROUP } from "../src/content-classifier";
import { callOllama } from "../src/ollama-utils";

// ── Mock für Ollama-Aufrufe (für Unit-Tests) ───────────────────────────────

jest.mock("../src/ollama-utils", () => ({
  callOllama: jest.fn(),
}));

const mockCallOllama = callOllama as jest.Mock;

// ── Testfälle ────────────────────────────────────────────────────────────

describe("classifyPrompt", () => {
  beforeEach(() => {
    mockCallOllama.mockReset();
  });

  it("klassifiziert einfache Code-Änderungen als 'code_simple'", async () => {
    mockCallOllama.mockResolvedValue(
      '{"category": "code_simple", "reason": "Einfache Textersetzung", "confidence": 0.95}'
    );
    
    const result = await classifyPrompt("Ersetze 'foo' mit 'bar' in Zeile 42");
    expect(result.category).toBe("code_simple");
    expect(result.reason).toContain("Einfache Textersetzung");
    expect(CATEGORY_TO_GROUP[result.category]).toBe("operational");
  });

  it("klassifiziert komplexe Code-Änderungen als 'code_complex'", async () => {
    mockCallOllama.mockResolvedValue(
      '{"category": "code_complex", "reason": "Refactoring erforderlich", "confidence": 0.9}'
    );
    
    const result = await classifyPrompt("Optimiere diese 200-Zeilen-Funktion für Performance");
    expect(result.category).toBe("code_complex");
    expect(CATEGORY_TO_GROUP[result.category]).toBe("tactical");
  });

  it("klassifiziert Design-Fragen als 'design'", async () => {
    mockCallOllama.mockResolvedValue(
      '{"category": "design", "reason": "Architektur-Entwurf", "confidence": 0.85}'
    );
    
    const result = await classifyPrompt("Entwirf eine Event-Sourcing-Architektur");
    expect(result.category).toBe("design");
    expect(CATEGORY_TO_GROUP[result.category]).toBe("strategic");
  });

  it("klassifiziert unklare Anfragen als 'fallback'", async () => {
    mockCallOllama.mockResolvedValue(
      '{"category": "fallback", "reason": "Unklare Anfrage", "confidence": 0.3}'
    );
    
    const result = await classifyPrompt("Mach das besser");
    expect(result.category).toBe("fallback");
    expect(CATEGORY_TO_GROUP[result.category]).toBe("tactical"); // Default-Fallback
  });

  it("behandelt Ollama-Fehler als Fallback", async () => {
    mockCallOllama.mockRejectedValue(new Error("Ollama not running"));
    
    const result = await classifyPrompt("Irgendeine Anfrage");
    expect(result.category).toBe("fallback");
    expect(result.reason).toContain("Ollama error");
  });

  it("validiert das JSON-Format der Ollama-Antwort", async () => {
    mockCallOllama.mockResolvedValue('{"category": "invalid_category", "reason": "test"}');
    
    // Sollte auf Fallback fallen, da "invalid_category" nicht erlaubt ist
    const result = await classifyPrompt("Test");
    expect(result.category).toBe("fallback");
  });
});

// ── Integrationstest (mit echten Ollama-Aufrufen) ────────────────────────

describe("classifyPrompt (Integration)", () => {
  // WARNUNG: Diese Tests benötigen laufendes Ollama mit gemma2:2b!
  // Deaktiviert per Default — aktivieren mit `TEST_INTEGRATION=true npm test`
  const TEST_INTEGRATION = process.env.TEST_INTEGRATION === "true";

  if (TEST_INTEGRATION) {
    it("klassifiziert echte Prompts mit Ollama", async () => {
      // Ollama muss laufen und gemma2:2b verfügbar sein
      jest.unmock("../src/ollama-utils"); // Mock entfernen
      
      const simpleResult = await classifyPrompt("Ersetze 'x' mit 'y'");
      console.log("Simple prompt classified as:", simpleResult);
      expect(["code_simple", "fallback"]).toContain(simpleResult.category);

      const complexResult = await classifyPrompt("Debugge diese rekursive Funktion");
      console.log("Complex prompt classified as:", complexResult);
      expect(["code_complex", "fallback"]).toContain(complexResult.category);
    }, 20000); // Timeout erhöhen für Ollama-Aufrufe
  } else {
    it.skip("Integrationstests deaktiviert (setze TEST_INTEGRATION=true)", () => {});
  }
});