// src/content-classifier.ts
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { callOllama } from './ollama-utils.js';
import { CloudClient } from './cloud-client.js';
import { DiscoveryManager } from './discovery.js';
import { lookupGdp } from './metrics.js';
import type { Config, Cache } from './types.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface ClassificationResult {
  category: 
    | 'trivial'
    | 'simple' 
    | 'code_simple'
    | 'standard'
    | 'code_complex' 
    | 'design'
    | 'planning'
    | 'exploration'
    | 'fallback';
  reason: string;
  confidence?: number;
}

export type FullClassificationResult = ClassificationResult | HintClassificationResult;

export interface ClassificationContext {
  lastCategory?: ClassificationResult['category'];
  previousUserMessage?: string;
  lastAssistantSnippet?: string | undefined;
  lastModel?: string | undefined;  // Model to reuse (e.g., after compaction)
  isCompaction?: boolean;  // NEW: Explicit compaction flag
}

export interface HintClassificationResult {
  reason: string;
  confidence: number;
  hintType: 'model' | 'group' | 'tier';
  hintTarget: string;
}

// Cost tiers for escalation logic. Derived from GDPval, not hardcoded model names —
// the router config's model set differs per user/setup, so tiering must be dynamic.
// Thresholds mirror the min_gdpval values of the scout/tactical/strategic groups
// in router-config.json, keeping escalation consistent with actual group routing.
const TIER_TO_GROUP: Record<string, string> = {
  'cheap': 'scout',
  'medium': 'tactical',
  'expensive': 'strategic',
};

const TIER_GDPVAL_THRESHOLDS: { tier: string; min: number }[] = [
  { tier: 'expensive', min: 700 },
  { tier: 'medium', min: 300 },
  { tier: 'cheap', min: 0 },
];

const TASK_COMPLEXITY_TIER: Record<string, string> = {
  'trivial': 'cheap',
  'simple': 'cheap',
  'code_simple': 'medium',
  'standard': 'medium',
  'code_complex': 'expensive',
  'design': 'expensive',
  'planning': 'expensive',
  'exploration': 'medium',
};

function getModelCostTier(modelRef: string): string {
  const gdpval = lookupGdp(modelRef) ?? 0;
  for (const { tier, min } of TIER_GDPVAL_THRESHOLDS) {
    if (gdpval >= min) return tier;
  }
  return 'cheap';
}

/**
 * Apply escalation logic: if the task complexity suggests a different cost tier
 * than the last model used, return a hint to switch groups.
 */
function applyEscalationLogic(
  classification: FullClassificationResult,
  lastModel: string
): HintClassificationResult | null {
  // Only apply to ClassificationResult (not already a hint)
  if ('hintType' in classification) {
    return null;
  }

  const lastTier = getModelCostTier(lastModel);
  const targetTier = TASK_COMPLEXITY_TIER[classification.category] || 'medium';

  // If the target tier differs from the last model's tier, escalate/de-escalate
  if (targetTier !== lastTier) {
    const targetGroup = TIER_TO_GROUP[targetTier];
    if (targetGroup) {
      return {
        reason: `Escalation: ${lastTier} → ${targetTier} for ${classification.category} task`,
        confidence: 0.95,
        hintType: 'group',
        hintTarget: targetGroup,
      };
    }
  }

  return null;
}

interface ClassificationOptions {
  model?: string;
  timeoutMs?: number;
  fallbackModel?: string;
  fallbackTimeoutMs?: number;
  context?: ClassificationContext;
  allowStaticFallback?: boolean;
  cfg?: Config;
  cache?: Cache;
  allowCloudFallback?: boolean;
}

// ── Defaults ────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'gemma4:12b-mlx';
const DEFAULT_TIMEOUT = 45_000; // gemma4:12b-mlx needs ~22s on M3 Max
const FALLBACK_MODEL = 'gemma2:2b';
const FALLBACK_TIMEOUT = 10_000;
const MIN_CONFIDENCE = 0.5;
const CONTINUATION_MAX_WORDS = 4;

// ── Classification Prompt ────────────────────────────────────────────────
// Written in English for model performance — handles input in any language.

const CLASSIFICATION_PROMPT = `Classify the following user request into exactly one category:

IMPORTANT HINT RULE: If the request starts with "HINT:" (case-insensitive), ALWAYS return a hint category.
CRITICAL: If the request begins with "HINT:", ignore the rest of the request and return:
- For model hints: {"category": "hint:<model-name>", "reason": "User specified model via HINT", "confidence": 1.0}
- For group hints: {"category": "hint:group:<group-name>", "reason": "User specified group via HINT", "confidence": 1.0}

Examples of HINT instructions:
- "HINT: use mistral-medium-3.5"
- "HINT: use group tactical"
- "HINT: nutze mistral-medium-3.5"
- "HINT: verwende Gruppe complex"
- "HINT: benutz modell xyz"

If the request contains a HINT instruction (in any language), extract the model or group name and return it with the "hint:" prefix:
- For models: {"category": "hint:mistral-medium-3.5", "reason": "User specified model via HINT", "confidence": 1.0}
- For groups: {"category": "hint:group:tactical", "reason": "User specified group via HINT", "confidence": 1.0}

If NO HINT is present, classify normally into one of these categories:

- trivial:      Very simple requests ("list files", "show TODOs", "what's in this file?", "read this file")
- simple:       Simple questions ("explain briefly", "summarize", "what does this do?", "tell me about")
- code_simple:   Small code changes (1–10 lines, syntax fixes, renames, typos)
- standard:      Standard requests (general questions, moderate complexity, "explain this concept")
- code_complex:  Substantial changes (refactoring, debugging, new features, >50 lines). Also: analyzing, reviewing, or explaining existing code/documentation.
- design:       Architecture, system design, API design, database schema
- planning:     Task breakdown, roadmaps, prioritization, project planning
- exploration:  Vague or open-ended questions with no clear deliverable ("what could we do about X?", brainstorming, unclear requirements). NOT code analysis.
- fallback:     Ambiguous, or a short continuation/confirmation of previous work

The request may be in any language. Classify by complexity and required model capability.
Short requests with clear, simple answers → trivial or simple.
"List TODOs", "Show me the file" → trivial.
"Explain this code" (simple code) → simple.
"Explain this concept" → standard.
"Design an architecture" → design.
Short imperatives that continue prior work ("do it", "go ahead", "yes", "Machen!", "weiter") → fallback.
"Analyze / review / explain the code / docs" → code_complex (not exploration).

{{context_block}}Current request: "{{prompt}}"

Respond with JSON only, no extra text:
{"category": "<category>", "reason": "<1-2 sentences>", "confidence": <0.0-1.0>}`;

// ── Core Logic ───────────────────────────────────────────────────────────

// Group-verb prefixes shared by groupMatch and the incomplete-group guard
const GROUP_VERB_PREFIX = /^(?:use\s+group|verwende\s+gruppe|nutze\s+gruppe|benutz(?:e)?\s+gruppe)/i;

/**
 * Deterministic HINT detection — bypasses the LLM entirely.
 * Matches "HINT: ..." at the start of a prompt (case-insensitive, any language).
 * Returns HintClassificationResult or null if no HINT prefix found.
 * Returns null for incomplete hints (e.g. "HINT: use group" with no name) so the
 * caller can fall through to LLM classification rather than misclassifying the
 * group-keyword as a model name.
 */
export function detectHintDirectly(prompt: string): HintClassificationResult | null {
  const match = prompt.match(/^\s*HINT\s*:\s*(.+)/i);
  if (!match) return null;
  const instruction = match[1].trim();

  // Group hint: "use group tactical", "verwende Gruppe X", "nutze gruppe X", "benutze Gruppe X"
  const groupMatch = instruction.match(
    new RegExp(GROUP_VERB_PREFIX.source + /\s+(\S+)/.source, 'i')
  );
  if (groupMatch) {
    return {
      reason: 'User specified group via HINT',
      confidence: 1.0,
      hintType: 'group',
      hintTarget: groupMatch[1].toLowerCase(),
    };
  }

  // Guard: group-verb prefix present but no name follows → incomplete hint, let LLM handle it
  if (GROUP_VERB_PREFIX.test(instruction)) return null;

  // Model hint: "use mistral-medium-3.5", "nutze mistral/mistral-medium-3.5", bare "mistral-medium-3.5"
  const modelMatch = instruction.match(
    /^(?:use\s+|nutze\s+|verwende\s+|benutz(?:e)?\s+(?:modell\s+)?)?(\S+)/i
  );
  if (modelMatch) {
    const target = modelMatch[1].replace(/[,;.]$/, '');
    if (target.length > 0) {
      return {
        reason: 'User specified model via HINT',
        confidence: 1.0,
        hintType: 'model',
        hintTarget: target,
      };
    }
  }

  return null;
}

export async function classifyPrompt(
  prompt: string,
  options: ClassificationOptions = {}
): Promise<FullClassificationResult> {
  const {
    model = DEFAULT_MODEL,
    timeoutMs = DEFAULT_TIMEOUT,
    fallbackModel = FALLBACK_MODEL,
    fallbackTimeoutMs = FALLBACK_TIMEOUT,
    context = {},
    allowStaticFallback = false,
    allowCloudFallback = false,
    cfg,
    cache,
  } = options;

  // Detect HINT prefix deterministically — no LLM needed, always correct.
  const directHint = detectHintDirectly(prompt);
  if (directHint) return directHint;

  // Model momentum: FORCE reuse of last model ONLY during compaction
  if (context.isCompaction && context.lastModel) {
    return {
      reason: 'Model continuity during compaction',
      confidence: 1.0,
      hintType: 'model',
      hintTarget: context.lastModel,
    };
  }

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

  const tryClassify = async (m: string, t: number): Promise<FullClassificationResult> => {
    const response = await callOllama(m, ollamaPrompt, { timeoutMs: t });
    // Strip <think>...</think> blocks (gemma4 and other reasoning models output these)
    const cleaned = response.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    // Extract first JSON object in case of surrounding text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned) as ClassificationResult;
    if (!isValidFullClassification(parsed)) {
      // If category is invalid but structure is valid, map to fallback
      const rawParsed = parsed as any;
      if (rawParsed && typeof rawParsed.category === 'string' && typeof rawParsed.reason === 'string') {
        console.warn(`[classifier] Invalid category "${rawParsed.category}" from LLM, falling back to 'fallback'`);
        return { category: 'fallback', reason: rawParsed.reason, confidence: rawParsed.confidence ?? 0 };
      }
      throw new Error(`Invalid format: ${response}`);
    }
    
    // Check for HINT override in the classification result
    if (parsed.category && parsed.category.startsWith('hint:')) {
      // Extract the hint target from the category
      const hintTarget = parsed.category.slice(5); // Remove 'hint:' prefix
      
      // Guard: if hintTarget is empty, return explicit fallback
      if (!hintTarget || hintTarget.length === 0) {
        console.warn(`[classifier] Empty HINT target received from LLM: ${parsed.category}`);
        return { 
          category: 'fallback', 
          reason: 'Empty HINT target from LLM', 
          confidence: 0.5 
        };
      }
      
      if (hintTarget.startsWith('group:')) {
        // This is a group hint
        const groupName = hintTarget.slice(6); // Remove 'group:' prefix
        if (!groupName || groupName.length === 0) {
          console.warn(`[classifier] Empty group name in HINT: ${parsed.category}`);
          return { 
            category: 'fallback', 
            reason: 'Empty group name in HINT', 
            confidence: 0.5 
          };
        }
        return {
          reason: parsed.reason || 'User specified group via HINT',
          confidence: 1.0,
          hintType: 'group',
          hintTarget: groupName,
        };
      } else {
        // This is a model hint - clean up common prefixes like "use ", "nutze ", etc.
        // Extract just the model name by removing common verbs
        let cleanHintTarget = hintTarget.trim();
        const verbPrefixes = ['use ', 'use:', 'nutze ', 'nutze:', 'utilise ', 'utilise:', 'utilizar ', 'utilizar:'];
        for (const prefix of verbPrefixes) {
          if (cleanHintTarget.toLowerCase().startsWith(prefix)) {
            cleanHintTarget = cleanHintTarget.slice(prefix.length).trim();
            break;
          }
        }
        
        return {
          reason: parsed.reason || 'User specified model via HINT',
          confidence: 1.0,
          hintType: 'model',
          hintTarget: cleanHintTarget,
        };
      }
    }
    
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

  // Primary model — may be slow on cold start
  let classificationResult: FullClassificationResult | null = null;
  try {
    classificationResult = await tryClassify(model, timeoutMs);
  } catch (primaryError) {
    // Cold-start timeout or load error → retry immediately with the fallback model
    if (model !== fallbackModel) {
      try {
        console.error(
          `[classifier] Primary model "${model}" failed, retrying with ${fallbackModel}:`,
          (primaryError as Error).message
        );
        classificationResult = await tryClassify(fallbackModel, fallbackTimeoutMs);
      } catch (fallbackError) {
        console.error(`[classifier] Fallback model also failed:`, (fallbackError as Error).message);
      }
    }
  }

  // Escalation logic: if we have a classification and lastModel, check if we need to escalate
  if (classificationResult && context.lastModel && !context.isCompaction) {
    const result = applyEscalationLogic(classificationResult, context.lastModel);
    if (result) {
      return result;
    }
  }

  if (classificationResult) {
    return classificationResult;
  }

  // Cloud fallback: Try free cloud models
  // Only activate when allowCloudFallback is true AND cfg/cache are available
  if (allowCloudFallback && cfg && cache) {
    try {
      const discovery = new DiscoveryManager(cfg, cache);
      const cloudModels = discovery.getFreeModels();
      
      if (cloudModels.length > 0) {
        const cloudClient = new CloudClient(cfg);
        
        for (const modelRef of cloudModels) {
          try {
            const cloudResponse = await cloudClient.callModel(modelRef, ollamaPrompt);
            const cleaned = cloudResponse.content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
            const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned) as FullClassificationResult;
            if (isValidFullClassification(parsed)) {
              console.log(`[classifier] Cloud model ${modelRef} succeeded`);
              // Apply escalation logic to cloud result
              if (context.lastModel && !context.isCompaction) {
                const result = applyEscalationLogic(parsed, context.lastModel);
                if (result) {
                  return result;
                }
              }
              return parsed;
            }
          } catch (cloudError) {
            console.warn(`[classifier] Cloud model ${modelRef} failed:`, (cloudError as Error).message);
          }
        }
      }
    } catch (cloudFallbackError) {
      console.warn('[classifier] Cloud fallback failed:', (cloudFallbackError as Error).message);
    }
  }

  // Static fallback
  if (!allowStaticFallback) {
    console.warn('[classifier] Ollama models failed, static classifier disabled — returning fallback');
    return { category: 'fallback', reason: 'Ollama unavailable, static classifier disabled', confidence: 0 };
  }

  console.warn('[classifier] Ollama and cloud models failed, falling back to static classification');

  const staticResult = classifyStatically(prompt);
  // Apply escalation logic to static result
  if (context.lastModel && !context.isCompaction) {
    const result = applyEscalationLogic(staticResult, context.lastModel);
    if (result) {
      return result;
    }
  }
  return staticResult;
}

function isValidClassification(obj: any): obj is ClassificationResult {
  return (
    obj &&
    typeof obj.category === 'string' &&
    ['trivial', 'simple', 'code_simple', 'standard', 'code_complex', 'design', 'planning', 'exploration', 'fallback'].includes(
      obj.category
    ) &&
    typeof obj.reason === 'string'
  );
}

function isValidHintClassification(obj: any): obj is HintClassificationResult {
  return (
    obj &&
    (obj.hintType === 'model' || obj.hintType === 'group') &&
    typeof obj.hintTarget === 'string' &&
    obj.hintTarget.length > 0 &&
    typeof obj.reason === 'string' &&
    obj.confidence === 1.0
  );
}

function isValidFullClassification(obj: any): obj is FullClassificationResult {
  // Check for normal classification
  if (isValidClassification(obj)) return true;
  
  // Check for raw HINT response from LLM (before extraction)
  // These have category starting with 'hint:' but no hintType/hintTarget yet
  if (obj && 
      typeof obj.category === 'string' && 
      obj.category.startsWith('hint:') && 
      typeof obj.reason === 'string') {
    return true;
  }
  
  // Check for processed HINT classification
  return isValidHintClassification(obj);
}



// ── Mapping ──────────────────────────────────────────────────────────────

export const CATEGORY_TO_GROUP: Record<ClassificationResult['category'], string> = {
  trivial:      'scout',       // any free model
  simple:       'operational', // GDPval ≥ 300
  code_simple:  'simple',      // GDPval ≥ 300, max_cost=0 (free models only)
  standard:     'operational', // GDPval ≥ 300
  code_complex: 'tactical',   // GDPval ≥ 600 (mistral-medium-3.5 qualifies)
  design:       'tactical',   // GDPval ≥ 600
  planning:     'tactical',   // GDPval ≥ 600
  exploration:  'scout',       // any model, cheap
  fallback:     'tactical',   // uncertain → use a decent model, not a free one
};

export function getGroupForCategory(category: string): string {
  return CATEGORY_TO_GROUP[category as ClassificationResult['category']] ?? 'fallback';
}

// ── Static Classification Fallback ─────────────────────────────────────

/**
 * Static classification as fallback when Ollama/Cloud is not available
 * Uses keyword matching for simple categorization
 */
export function classifyStatically(prompt: string): ClassificationResult {
  const lowerPrompt = prompt.toLowerCase();

  // Trivial: Only very specific file/list/todo context phrases
  // The AND condition ensures the keywords appear in a relevant context
  const trivialKeywords = [/what(?:'s| is) in\s/i];
  
  if (trivialKeywords.some(regex => regex.test(lowerPrompt)) &&
      (lowerPrompt.includes('file') || lowerPrompt.includes('todo') || 
       lowerPrompt.includes('list') || lowerPrompt.includes('content'))) {
    return {
      category: 'trivial',
      reason: 'Simple request - trivial classification',
      confidence: 0.9,
    };
  }

  // Simple: Simple questions/explanations
  const simpleKeywords = [
    'explain', 'summarize', 'summary', 'what does', 'what is',
    'tell me', 'describe', 'briefly', 'short', 'quick',
    'meaning', 'definition', 'what\'s', 'how to', 'how do'
  ];
  
  if (simpleKeywords.some(kw => lowerPrompt.includes(kw))) {
    return {
      category: 'simple',
      reason: 'Simple question - simple classification',
      confidence: 0.85,
    };
  }

  // Code Simple: Small code changes
  const codeSimpleKeywords = [
    'fix', 'rename', 'typo', 'syntax', 'import', 'export',
    'add a', 'remove', 'delete', 'change', 'update',
    'one line', 'few lines', 'small'
  ];
  
  if (codeSimpleKeywords.some(kw => lowerPrompt.includes(kw)) &&
      (lowerPrompt.includes('code') || lowerPrompt.includes('function') || 
       lowerPrompt.includes('variable') || lowerPrompt.includes('line'))) {
    return {
      category: 'code_simple',
      reason: 'Small code change - code_simple classification',
      confidence: 0.8,
    };
  }

  // Standard: Standard requests
  const standardKeywords = [
    'explain this', 'how does', 'why does', 'what are',
    'difference', 'compare', 'pro and con', 'advantage',
    'disadvantage', 'when to use', 'best practice'
  ];
  
  if (standardKeywords.some(kw => lowerPrompt.includes(kw))) {
    return {
      category: 'standard',
      reason: 'Standard request - standard classification',
      confidence: 0.8,
    };
  }

  // Code Complex: Complex code tasks
  const codeComplexKeywords = [
    'refactor', 'debug', 'architecture', 'design', 'implement',
    'new feature', 'complex', 'large', 'many lines',
    'review', 'analyze', 'optimize', 'performance'
  ];
  
  if (codeComplexKeywords.some(kw => lowerPrompt.includes(kw))) {
    return {
      category: 'code_complex',
      reason: 'Complex code task - code_complex classification',
      confidence: 0.85,
    };
  }

  // Design: Architecture/Design
  const designKeywords = [
    'architecture', 'system design', 'api design', 'database',
    'schema', 'diagram', 'flowchart', 'uml', 'structure'
  ];
  
  if (designKeywords.some(kw => lowerPrompt.includes(kw))) {
    return {
      category: 'design',
      reason: 'Design task - design classification',
      confidence: 0.9,
    };
  }

  // Planning: Planning/Roadmaps
  const planningKeywords = [
    'roadmap', 'plan', 'prioritize', 'prioritization',
    'task breakdown', 'tasks', 'steps', 'milestone',
    'timeline', 'schedule', 'break down'
  ];
  
  if (planningKeywords.some(kw => lowerPrompt.includes(kw))) {
    return {
      category: 'planning',
      reason: 'Planning task - planning classification',
      confidence: 0.85,
    };
  }

  // Exploration: Open-ended questions/Brainstorming
  const explorationKeywords = [
    'what could', 'what should', 'brainstorm', 'ideas',
    'suggestions', 'options', 'possibilities', 'vague',
    'open-ended', 'what if'
  ];
  
  if (explorationKeywords.some(kw => lowerPrompt.includes(kw))) {
    return {
      category: 'exploration',
      reason: 'Exploration task - exploration classification',
      confidence: 0.75,
    };
  }

  // Fallback
  return {
    category: 'fallback',
    reason: 'Could not classify - fallback',
    confidence: 0.5,
  };
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
  
  // Helper function to apply model group resolution
  async function applyModelGroup(group: string, context: any): Promise<void> {
    const toolResult = await piWithTools.tools.resolve_model_group.execute({ group });
    if (toolResult?.details?.selected) {
      const { provider, modelId } = toolResult.details;
      const model = context.modelRegistry.find(provider, modelId);
      if (model) await pi.setModel(model);
    }
  }
  
  piWithHooks.hooks.before_user_prompt(
    async ({ prompt, context }: { prompt: string; context: any }) => {
      const classification = await classifyPrompt(prompt);
      // Handle HINT classification
      if ('hintType' in classification) {
        // HINT overrides are not supported in this hook context
        console.warn(`[classifier] HINT override not supported in hook context, falling back to static classification`);
        const staticResult = classifyStatically(prompt);
        const group = CATEGORY_TO_GROUP[staticResult.category];
        await applyModelGroup(group, context);
        return;
      }
      const group = CATEGORY_TO_GROUP[classification.category];
      await applyModelGroup(group, context);
    }
  );
}
