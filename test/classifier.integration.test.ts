// test/classifier.integration.test.ts
// Integration tests for content-sensitive classification with real Ollama calls.
//
// These tests require a running Ollama with gemma2:2b!
// Enable with: TEST_INTEGRATION=true npm test test/classifier.integration.test.ts

import { describe, it, expect } from "vitest";
import { classifyPrompt } from "../src/content-classifier";

// primary model (gemma4:12b-mlx) up to 45s cold-start + fallback (gemma2:2b) 10s → allow 120s
const OLLAMA_TIMEOUT = 120_000;

describe.skipIf(!process.env.TEST_INTEGRATION)("classifyPrompt (Integration)", () => {
  it("classifies simple prompts with Ollama", async () => {
    const result = await classifyPrompt("Replace 'x' with 'y'");
    console.log("Simple prompt classified as:", result);
    expect(["code_simple", "fallback"]).toContain(result.category);
  }, OLLAMA_TIMEOUT);

  it("classifies complex prompts with Ollama", async () => {
    const result = await classifyPrompt("Debug this recursive function");
    console.log("Complex prompt classified as:", result);
    expect(["code_complex", "code_simple", "fallback"]).toContain(result.category);
  }, OLLAMA_TIMEOUT);

  it("classifies design prompts with Ollama", async () => {
    const result = await classifyPrompt("Design an event-sourcing architecture");
    console.log("Design prompt classified as:", result);
    expect(["design", "fallback"]).toContain(result.category);
  }, OLLAMA_TIMEOUT);
});
