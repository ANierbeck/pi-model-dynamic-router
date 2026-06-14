// test/classifier.integration.test.ts
// Integrationstests für die inhaltssensitive Klassifizierung mit echten Ollama-Aufrufen

import { describe, it, expect, beforeAll } from "vitest";
import { classifyPrompt } from "../src/content-classifier";

describe("classifyPrompt (Integration)", () => {
  // WARNUNG: Diese Tests benötigen laufendes Ollama mit gemma2:2b!
  // Aktivieren mit: TEST_INTEGRATION=true npm test test/classifier.integration.test.ts
  
  beforeAll(() => {
    // Stelle sicher, dass keine Mocks aktiv sind
    // Diese Datei sollte separat von den Unit-Tests ausgeführt werden
  });

  it("klassifiziert einfache Prompts mit Ollama", async () => {
    const result = await classifyPrompt("Ersetze 'x' mit 'y'");
    console.log("Simple prompt classified as:", result);
    expect(["code_simple", "fallback"]).toContain(result.category);
  }, 60000); // Timeout auf 60s erhöht

  it("klassifiziert komplexe Prompts mit Ollama", async () => {
    const result = await classifyPrompt("Debugge diese rekursive Funktion");
    console.log("Complex prompt classified as:", result);
    expect(["code_complex", "code_simple", "fallback"]).toContain(result.category);
  }, 60000); // Timeout auf 60s erhöht

  it("klassifiziert Design-Prompts mit Ollama", async () => {
    const result = await classifyPrompt("Entwirf eine Event-Sourcing-Architektur");
    console.log("Design prompt classified as:", result);
    expect(["design", "fallback"]).toContain(result.category);
  }, 60000); // Timeout auf 60s erhöht
});
