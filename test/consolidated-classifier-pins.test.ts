// test/consolidated-classifier-pins.test.ts
// Consolidation of one-file-per-incident micro tests (suite hygiene round
// 2026-10-04): each former standalone file lives on as its own describe,
// named after the original file - failure output stays greppable. The
// tests themselves are UNCHANGED; hooks and fixtures moved verbatim.

import { describe, it, expect } from 'vitest';
import { CATEGORY_TO_GROUP, getGroupForCategory } from '../src/content-classifier.ts';
import { classifyPrompt } from "../src/content-classifier";
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

describe('classifier-mapping-hints', () => {
  // Tests for CATEGORY_TO_GROUP / getGroupForCategory (category → router group).
  // detectHintDirectly lives in hint-classification / detect-hint-synonyms,
  // classifyStatically in classifier.test.ts.


  describe('CATEGORY_TO_GROUP / getGroupForCategory', () => {
    it('maps all nine categories to their router groups', () => {
      expect(CATEGORY_TO_GROUP).toEqual({
        trivial: 'scout',
        simple: 'operational',
        code_simple: 'simple',
        standard: 'operational',
        code_complex: 'tactical',
        design: 'planning',
        planning: 'planning',
        exploration: 'scout',
        fallback: 'tactical',
      });
    });

    it('resolves every known category', () => {
      expect(getGroupForCategory('trivial')).toBe('scout');
      expect(getGroupForCategory('simple')).toBe('operational');
      expect(getGroupForCategory('code_simple')).toBe('simple');
      expect(getGroupForCategory('standard')).toBe('operational');
      expect(getGroupForCategory('code_complex')).toBe('tactical');
      expect(getGroupForCategory('design')).toBe('planning');
      expect(getGroupForCategory('planning')).toBe('planning');
      expect(getGroupForCategory('exploration')).toBe('scout');
      expect(getGroupForCategory('fallback')).toBe('tactical');
    });

    it('routes unknown categories to the fallback group', () => {
      expect(getGroupForCategory('does-not-exist')).toBe('fallback');
      expect(getGroupForCategory('')).toBe('fallback');
    });
  });
});


describe('classifier.integration', () => {
  // test/classifier.integration.test.ts
  // Integration tests for content-sensitive classification with real Ollama calls.
  //
  // These tests require a running Ollama with gemma2:2b!
  // Enable with: TEST_INTEGRATION=true npm test test/classifier.integration.test.ts


  // primary model (mistral-nemo:latest) up to 45s cold-start + fallback (gemma2:2b) 10s → allow 120s
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
});


describe('config-classifier-model', () => {
  // test/config-classifier-model.test.ts
  // ADR-0009: the bundled dynamic.classifier_model overrides DEFAULT_MODEL in
  // content-classifier.ts, so it must itself be schema-capable. Ollama's MLX
  // backend rejects every JSON-schema call with HTTP 501 (live 2026-09-26).


  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const repoCfg = JSON.parse(readFileSync(join(repoRoot, 'router-config.json'), 'utf-8'));

  describe('bundled classifier model config', () => {
    it('does not configure an MLX-backend model as classifier primary', () => {
      const primary: string = repoCfg.model_groups.dynamic.classifier_model;
      expect(primary).toBeTruthy();
      expect(primary).not.toMatch(/-mlx\b/i);
    });

    it('matches the DEFAULT_MODEL in content-classifier.ts', () => {
      const src = readFileSync(join(repoRoot, 'src/content-classifier.ts'), 'utf-8');
      const def = src.match(/const DEFAULT_MODEL = '([^']+)'/)?.[1];
      expect(def).toBeTruthy();
      expect(repoCfg.model_groups.dynamic.classifier_model).toBe(`ollama/${def}`);
    });
  });
});
