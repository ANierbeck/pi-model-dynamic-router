// test/hint-classification.test.ts
// Unit-Tests für LLM-basierte HINT-Klassifizierung

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyPrompt, classifyStatically } from '../src/content-classifier.js';
import type { ClassificationResult, HintClassificationResult, FullClassificationResult } from '../src/content-classifier.js';

// ── Mock für callOllama ─────────────────────────────────────────────────

const originalCallOllama = (await import('../src/ollama-utils.js')).callOllama;

// ── Tests ────────────────────────────────────────────────────────────────

describe('HINT Classification', () => {
  beforeEach(() => {
    // Mock callOllama für HINT-Tests
    vi.mock('../src/ollama-utils.js', async () => {
      const actual = await vi.importActual('../src/ollama-utils.js');
      return {
        ...actual,
        callOllama: vi.fn(),
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('HINT Model Detection', () => {
    it('erkennt HINT mit Modellname (englisch)', async () => {
      const { callOllama } = await import('../src/ollama-utils.js');
      
      // Mock response mit HINT-Kategorie
      vi.mocked(callOllama).mockResolvedValue(
        JSON.stringify({
          category: 'hint:mistral-medium-3.5',
          reason: 'User specified model via HINT',
          confidence: 1.0
        })
      );

      const result = await classifyPrompt('HINT: use mistral-medium-3.5 and analyze this code');
      
      // Sollte ein HintClassificationResult sein
      expect(result).toHaveProperty('hintType', 'model');
      expect(result).toHaveProperty('hintTarget', 'mistral-medium-3.5');
      expect(result).toHaveProperty('confidence', 1.0);
      expect(result.reason).toContain('HINT');
    });

    it('erkennt HINT mit Modellname (deutsch)', async () => {
      const { callOllama } = await import('../src/ollama-utils.js');
      
      vi.mocked(callOllama).mockResolvedValue(
        JSON.stringify({
          category: 'hint:mistral-medium-3.5',
          reason: 'User specified model via HINT',
          confidence: 1.0
        })
      );

      const result = await classifyPrompt('HINT: nutze mistral-medium-3.5 und analysiere diesen Code');
      
      expect(result).toHaveProperty('hintType', 'model');
      expect(result).toHaveProperty('hintTarget', 'mistral-medium-3.5');
    });

    it('erkennt HINT mit Gruppenname', async () => {
      const { callOllama } = await import('../src/ollama-utils.js');
      
      vi.mocked(callOllama).mockResolvedValue(
        JSON.stringify({
          category: 'hint:group:tactical',
          reason: 'User specified group via HINT',
          confidence: 1.0
        })
      );

      const result = await classifyPrompt('HINT: use group tactical for this task');
      
      expect(result).toHaveProperty('hintType', 'group');
      expect(result).toHaveProperty('hintTarget', 'tactical');
    });

    it('erkennt HINT ohne use-Keyword', async () => {
      const { callOllama } = await import('../src/ollama-utils.js');
      
      vi.mocked(callOllama).mockResolvedValue(
        JSON.stringify({
          category: 'hint:mistral-medium-3.5',
          reason: 'User specified model via HINT',
          confidence: 1.0
        })
      );

      const result = await classifyPrompt('HINT: mistral-medium-3.5 analyze this');
      
      expect(result).toHaveProperty('hintType', 'model');
      expect(result).toHaveProperty('hintTarget', 'mistral-medium-3.5');
    });
  });

  describe('HINT Fallback Handling', () => {
    it('behandelt leeren HINT-Target mit Fallback', async () => {
      const { callOllama } = await import('../src/ollama-utils.js');
      
      // Mock response mit leerem HINT-Target
      vi.mocked(callOllama).mockResolvedValue(
        JSON.stringify({
          category: 'hint:',
          reason: 'Empty HINT',
          confidence: 1.0
        })
      );

      const result = await classifyPrompt('HINT: ');
      
      // Sollte auf Fallback zurückgreifen
      expect(result).toHaveProperty('category', 'fallback');
      expect(result).toHaveProperty('reason', 'Empty HINT target from LLM');
      expect(result).toHaveProperty('confidence', 0.5);
    });

    it('behandelt leeren Gruppenname in HINT', async () => {
      const { callOllama } = await import('../src/ollama-utils.js');
      
      // Mock response mit leerem Gruppenname
      vi.mocked(callOllama).mockResolvedValue(
        JSON.stringify({
          category: 'hint:group:',
          reason: 'Empty group HINT',
          confidence: 1.0
        })
      );

      const result = await classifyPrompt('HINT: use group');
      
      // Sollte auf Fallback zurückgreifen
      expect(result).toHaveProperty('category', 'fallback');
      expect(result).toHaveProperty('reason', 'Empty group name in HINT');
    });
  });

  describe('Normale Klassifizierung (kein HINT)', () => {
    it('klassifiziert normale Anfragen ohne HINT', async () => {
      const { callOllama } = await import('../src/ollama-utils.js');
      
      // Mock response ohne HINT
      vi.mocked(callOllama).mockResolvedValue(
        JSON.stringify({
          category: 'code_complex',
          reason: 'Complex coding task',
          confidence: 0.95
        })
      );

      const result = await classifyPrompt('Refactor this complex function');
      
      // Sollte normale ClassificationResult sein
      expect(result).toHaveProperty('category', 'code_complex');
      expect(result).not.toHaveProperty('hintType');
      expect(result).not.toHaveProperty('hintTarget');
    });

    it('klassifiziert einfache Anfragen', async () => {
      const { callOllama } = await import('../src/ollama-utils.js');
      
      vi.mocked(callOllama).mockResolvedValue(
        JSON.stringify({
          category: 'simple',
          reason: 'Simple question',
          confidence: 0.9
        })
      );

      const result = await classifyPrompt('What is the capital of France?');
      
      expect(result).toHaveProperty('category', 'simple');
      expect(result).toHaveProperty('confidence', 0.9);
    });
  });

  describe('Statische Klassifizierung als Fallback', () => {
    it('klassifiziert statisch wenn LLM fehlschlägt', async () => {
      const { callOllama } = await import('../src/ollama-utils.js');
      
      // Mock callOllama, um Fehler zu werfen
      vi.mocked(callOllama).mockRejectedValue(new Error('Ollama not available'));

      const result = await classifyPrompt('List all files in this directory');
      
      // Sollte statische Klassifizierung verwenden
      expect(result.category).toBeDefined();
      expect(typeof result.category).toBe('string');
    });
  });

  describe('Typ-Sicherheit', () => {
    it('HintClassificationResult hat keine category', () => {
      const hintResult: HintClassificationResult = {
        reason: 'User specified model via HINT',
        confidence: 1.0,
        hintType: 'model',
        hintTarget: 'mistral-medium-3.5'
      };
      
      // Sollte kein category Feld haben
      expect(hintResult).not.toHaveProperty('category');
      expect(hintResult.hintType).toBe('model');
      expect(hintResult.hintTarget).toBe('mistral-medium-3.5');
    });

    it('ClassificationResult hat category aber kein hintType', () => {
      const normalResult: ClassificationResult = {
        category: 'code_complex',
        reason: 'Complex task',
        confidence: 0.95
      };
      
      expect(normalResult).toHaveProperty('category', 'code_complex');
      expect(normalResult).not.toHaveProperty('hintType');
      expect(normalResult).not.toHaveProperty('hintTarget');
    });
  });
});
