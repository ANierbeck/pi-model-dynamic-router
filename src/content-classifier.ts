// src/content-classifier.ts
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { callOllama } from './ollama-utils.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface ClassificationResult {
  category: 'code_simple' | 'code_complex' | 'design' | 'planning' | 'exploration' | 'fallback';
  reason: string;
  confidence?: number;
}

export interface ClassificationContext {
  lastCategory?: ClassificationResult['category'];
  previousUserMessage?: string;
  lastAssistantSnippet?: string;
}

interface ClassificationOptions {
  model?: string;
  timeoutMs?: number;
  context?: ClassificationContext;
}

// ── Defaults ────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'gemma2:2b';
const DEFAULT_TIMEOUT = 15_000; // gemma2:2b needs ~5-8s inference
const FALLBACK_MODEL = 'gemma2:2b';
const FALLBACK_TIMEOUT = 10_000;
const MIN_CONFIDENCE = 0.5;
const CONTINUATION_MAX_WORDS = 4;

// ── Classification Prompt ────────────────────────────────────────────────
// Written in English for model performance — handles input in any language.

const CLASSIFICATION_PROMPT = `Classify the following user request into exactly one category:

- code_simple:  Small code changes (1–10 lines, syntax fixes, renames, typos)
- code_complex: Substantial changes (refactoring, debugging, new features, >50 lines). Also: analyzing, reviewing, or explaining existing code/documentation.
- design:       Architecture, system design, API design, database schema
- planning:     Task breakdown, roadmaps, prioritization, project planning
- exploration:  Vague or open-ended questions with no clear deliverable ("what could we do about X?", brainstorming, unclear requirements). NOT code analysis.
- fallback:     Ambiguous, or a short continuation/confirmation of previous work

The request may be in any language. Classify by intent, not language.
Short imperatives that continue prior work ("do it", "go ahead", "yes", "Machen!", "weiter") → fallback.
"Analyze / review / explain the code / docs" → code_complex (not exploration).

{{context_block}}Current request: "{{prompt}}"

Respond with JSON only, no extra text:
{"category": "<category>", "reason": "<1-2 sentences>", "confidence": <0.0-1.0>}`;

// ── Core Logic ───────────────────────────────────────────────────────────

export async function classifyPrompt(
  prompt: string,
  options: ClassificationOptions = {}
): Promise<ClassificationResult> {
  const { model = DEFAULT_MODEL, timeoutMs = DEFAULT_TIMEOUT, context = {} } = options;

  // Short-prompt momentum: ≤4 words with a known prior category → inherit it.
  // Language-agnostic: "yes", "do it", "Machen!", "oui", "dale" all qualify.
  const wordCount = prompt.trim().split(/\s+/).length;
  if (context.lastCategory && wordCount <= CONTINUATION_MAX_WORDS) {
    return {
      category: context.lastCategory,
      reason: 'Short prompt — inheriting previous task context',
      confidence: 0.85,
    };
  }

  // Build context block injected into the prompt
  const contextLines: string[] = [];
  if (context.previousUserMessage) {
    contextLines.push(`Previous user message: "${context.previousUserMessage.slice(0, 120)}"`);
  }
  if (context.lastAssistantSnippet) {
    contextLines.push(
      `Last assistant response (excerpt): "${context.lastAssistantSnippet.slice(0, 150)}"`
    );
  }
  const contextBlock = contextLines.length > 0 ? `Context:\n${contextLines.join('\n')}\n\n` : '';

  const ollamaPrompt = CLASSIFICATION_PROMPT.replace('{{context_block}}', contextBlock).replace(
    '{{prompt}}',
    prompt
  );

  const tryClassify = async (m: string, t: number): Promise<ClassificationResult> => {
    const response = await callOllama(m, ollamaPrompt, { timeoutMs: t });
    // Strip <think>...</think> blocks (gemma4 and other reasoning models output these)
    const cleaned = response.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    // Extract first JSON object in case of surrounding text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned) as ClassificationResult;
    if (!isValidClassification(parsed)) throw new Error(`Invalid format: ${response}`);
    if (parsed.confidence !== undefined && parsed.confidence < MIN_CONFIDENCE) {
      const inherited = context.lastCategory ?? 'fallback';
      return {
        category: inherited,
        reason: `Low confidence (${parsed.confidence}) — ${context.lastCategory ? 'using prior context' : 'falling back'}`,
        confidence: parsed.confidence,
      };
    }
    return parsed;
  };

  // Primary model (gemma4:12b-mlx) — may be slow on cold start
  try {
    return await tryClassify(model, timeoutMs);
  } catch (primaryError) {
    // Cold-start timeout or load error → retry immediately with the small model
    if (model !== FALLBACK_MODEL) {
      try {
        console.error(
          `[classifier] Primary model "${model}" failed, retrying with ${FALLBACK_MODEL}:`,
          (primaryError as Error).message
        );
        return await tryClassify(FALLBACK_MODEL, FALLBACK_TIMEOUT);
      } catch (fallbackError) {
        console.error(`[classifier] Fallback model also failed:`, (fallbackError as Error).message);
      }
    }
  }

  return {
    category: context.lastCategory ?? 'fallback',
    reason: 'Both classification models failed — using momentum or fallback',
    confidence: 0,
  };
}

function isValidClassification(obj: any): obj is ClassificationResult {
  return (
    obj &&
    typeof obj.category === 'string' &&
    ['code_simple', 'code_complex', 'design', 'planning', 'exploration', 'fallback'].includes(
      obj.category
    ) &&
    typeof obj.reason === 'string'
  );
}

// ── Mapping ──────────────────────────────────────────────────────────────

export const CATEGORY_TO_GROUP: Record<ClassificationResult['category'], string> = {
  code_simple: 'operational',
  code_complex: 'tactical',
  design: 'strategic',
  planning: 'tactical',
  exploration: 'scout',
  fallback: 'tactical',
};

export function getGroupForCategory(category: string): string {
  return CATEGORY_TO_GROUP[category as ClassificationResult['category']] ?? 'fallback';
}

// ── PI Integration (legacy hook) ─────────────────────────────────────────

interface ExtensionAPIWithHooks extends ExtensionAPI {
  hooks: {
    before_user_prompt: (
      callback: (args: { prompt: string; context: any }) => Promise<void>
    ) => void;
  };
}

export function setupContentBasedRouting(pi: ExtensionAPI) {
  const piWithHooks = pi as unknown as ExtensionAPIWithHooks;
  const piWithTools = pi as unknown as {
    tools: { resolve_model_group: { execute: (params: { group: string }) => Promise<any> } };
  };
  piWithHooks.hooks.before_user_prompt(
    async ({ prompt, context }: { prompt: string; context: any }) => {
      const classification = await classifyPrompt(prompt);
      const group = CATEGORY_TO_GROUP[classification.category];
      const toolResult = await piWithTools.tools.resolve_model_group.execute({ group });
      if (toolResult?.details?.selected) {
        const { provider, modelId } = toolResult.details;
        const model = context.modelRegistry.find(provider, modelId);
        if (model) await pi.setModel(model);
      }
    }
  );
}
