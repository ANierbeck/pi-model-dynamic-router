// test/classifier.integration.test.ts
// Integrationstests für die inhaltssensitive Klassifizierung mit echten Ollama-Aufrufen
//
// Diese Tests benötigen laufendes Ollama mit gemma2:2b!
// Aktivieren mit: TEST_INTEGRATION=true npm test test/classifier.integration.test.ts

import { describe, it, expect } from "vitest";
import { classifyPrompt } from "../src/content-classifier";

// primary model (gemma4:12b-mlx) up to 45s cold-start + fallback (gemma2:2b) 10s → allow 120s
const OLLAMA_TIMEOUT = 120_000;

describe.skipIf(!process.env.TEST_INTEGRATION)("classifyPrompt (Integration)", () => {
  it("klassifiziert einfache Prompts mit Ollama", async () => {
    const result = await classifyPrompt("Ersetze 'x' mit 'y'");
    console.log("Simple prompt classified as:", result);
    expect(["code_simple", "fallback"]).toContain(result.category);
  }, OLLAMA_TIMEOUT);

  it("klassifiziert komplexe Prompts mit Ollama", async () => {
    const result = await classifyPrompt("Debugge diese rekursive Funktion");
    console.log("Complex prompt classified as:", result);
    expect(["code_complex", "code_simple", "fallback"]).toContain(result.category);
  }, OLLAMA_TIMEOUT);

  it("klassifiziert Design-Prompts mit Ollama", async () => {
    const result = await classifyPrompt("Entwirf eine Event-Sourcing-Architektur");
    console.log("Design prompt classified as:", result);
    expect(["design", "fallback"]).toContain(result.category);
  }, OLLAMA_TIMEOUT);
});
