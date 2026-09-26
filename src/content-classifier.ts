// src/content-classifier.ts
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { callOllama, isOllamaAvailable } from './ollama-utils.ts';
import { DiscoveryManager } from './discovery.ts';
import { lookupGdp } from './metrics.ts';
import { routerLog } from './logger.ts';
import type { Config, Cache } from './types.ts';
import { getCachedFallbackModels, selectClassifierCandidates, hasProbedFallback } from './classifier-fallback-probe.ts';
import {
  buildContextBlock,
  buildClassificationPrompt,
  extractClassificationJson,
  isHintCategory,
} from './classification-prompt.ts';

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
  lastCategory?: ClassificationResult['category'] | undefined;
  previousUserMessage?: string | undefined;
  lastAssistantSnippet?: string | undefined;
  lastModel?: string | undefined;  // Model to reuse (e.g., after compaction)
  isCompaction?: boolean;  // NEW: Explicit compaction flag
  /**
   * Whether `lastModel` is currently in the router's rate-limit/soft-failure
   * cooldown. When true, compaction-continuity must NOT hint back to it —
   * doing so would resolve straight through the HINT override path, which
   * clears the very cooldown that was protecting against a model that just
   * failed, and retry it immediately on every subsequent turn.
   */
  lastModelLimited?: boolean;
}

export interface HintClassificationResult {
  reason: string;
  confidence: number;
  hintType: 'model' | 'group' | 'tier';
  hintTarget: string;
  /**
   * 'user' (default) — the user explicitly named this model/group via a
   * "HINT: ..." prefix; a stale cooldown must not block a deliberate choice,
   * so the router clears it.
   * 'auto' — the router generated this hint itself (e.g. compaction model
   * continuity). It is a preference, not a deliberate override, so any
   * existing cooldown on the target must be respected rather than cleared.
   */
  origin?: 'user' | 'auto';
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
 * Apply escalation logic: if the task complexity suggests a different group
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
  /**
   * Pinned cloud classifier model ref ("provider/id") from the dynamic
   * group's classifier_cloud_model config. When set and resolvable, it is
   * tried FIRST in the cloud fallback chain — before the probe-verified
   * cached list. Deterministic override for users who want a specific
   * (e.g. subscription-covered) model to classify, regardless of what
   * the scan-time probe ranked first.
   */
  pinnedCloudModel?: string;
  /**
   * Pi's one-shot completion API (modelRegistry.completeSimple). When the
   * cloud fallback runs, the classifier uses this instead of its own HTTP
   * client so pi owns auth + provider quirks — the user's keys live in pi's
   * auth store, not in router-config.json, so the router must NOT roll its
   * own key resolution. The model is resolved from the ref via findModel.
   */
  completeSimple?: (
    model: any,
    ctx: any,
    options?: any
  ) => Promise<{ content?: any[]; errorMessage?: string; stopReason?: string }>;
  /**
   * Resolves a model ref ("provider/id") to a pi Model object from the
   * registry, so completeSimple can be called. Returns undefined if pi
   * doesn't know the model.
   */
  findModel?: (ref: string) => any | undefined;
  /**
   * Pi's available models (modelRegistry.getAvailable()), pre-resolved so the
   * classifier can pick the cheapest without a second round-trip. Optional.
   */
  availableModels?: readonly any[];
}

// ── Defaults ────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'gemma4:12b-mlx';
const DEFAULT_TIMEOUT = 45_000; // gemma4:12b-mlx needs ~22s on M3 Max

// ── Classification cache (LRU + TTL) ────────────────────────────────────────
// Repeated identical prompts (subagent fan-out, retry loops, re-asks) would
// otherwise re-run the LLM classifier every time — a 22s gemma4:12b call each.
// Cache the prompt → classification result, evicting least-recently-used past
// MAX_CLASSIFY_CACHE entries and expiring entries after CLASSIFY_CACHE_TTL_MS.
const MAX_CLASSIFY_CACHE = 64;
const CLASSIFY_CACHE_TTL_MS = 5 * 60_000; // 5 minutes
interface ClassifyCacheEntry {
  result: FullClassificationResult;
  ts: number;
}
const classifyCache = new Map<string, ClassifyCacheEntry>();

function classifyCacheGet(prompt: string): FullClassificationResult | null {
  const entry = classifyCache.get(prompt);
  if (!entry) return null;
  if (Date.now() - entry.ts > CLASSIFY_CACHE_TTL_MS) {
    classifyCache.delete(prompt);
    return null;
  }
  // LRU: move to end (most-recently-used) by re-inserting.
  classifyCache.delete(prompt);
  classifyCache.set(prompt, entry);
  return entry.result;
}

function classifyCacheSet(prompt: string, result: FullClassificationResult): void {
  if (classifyCache.size >= MAX_CLASSIFY_CACHE) {
    // Evict the oldest entry (first in iteration order).
    const oldest = classifyCache.keys().next().value;
    if (oldest !== undefined) classifyCache.delete(oldest);
  }
  classifyCache.set(prompt, { result, ts: Date.now() });
}
const FALLBACK_MODEL = 'gemma2:2b';
const FALLBACK_TIMEOUT = 10_000;
const MIN_CONFIDENCE = 0.5;
const CONTINUATION_MAX_WORDS = 4;

// ── Classification Prompt ────────────────────────────────────────────────
// Written in English for model performance — handles input in any language.

// CLASSIFICATION_PROMPT moved to src/classification-prompt.ts (shared with the
// scan-time classifier probe — single source of truth for the prompt surface).

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
  // F6 (2026-09-02): the colon is OPTIONAL — a user typing "HINT use
  // mistral-zai/glm-5-2 Please proceed…" (no colon) should still be
  // recognized. To guard against false positives (the word "hint" in
  // natural prose like "can I get a hint about…"), we require one of:
  //   - a colon after HINT (the explicit form: "HINT: ..."), OR
  //   - a group-verb (use/nutze/verwende/benutze, optionally followed by
  //     "modell") immediately after HINT (the "HINT use <model>" form).
  // Bare "HINT <something>" without either is too ambiguous with prose.
  // NOTE: the bare noun `gruppe`/`group` is intentionally NOT in the
  // lookahead - group hints are recognized via GROUP_VERB_PREFIX below
  // ("use group X", "verwende gruppe X"), not via the bare noun, so the
  // English and German forms behave symmetrically (roborev job 451 LOW).
  // Marker rule (2026-09-20): "HINT" is the USER's reserved channel to the
  // router (model OR group hints). "MHINT" / "Model-HINT" / "Model_HINT"
  // are the router's own model-hint marker and its user-typable synonyms —
  // MODEL hints by definition, so they never enter the group branch. This
  // reserves plain HINT: for the user and stops the router's own narration
  // ("> [router] MHINT: …") from ever being re-read as a user instruction
  // (the 2026-09-18 lock-in loop).
  const match = prompt.match(/^\s*(HINT|MHINT|MODEL[-_]HINT)\b\s*(?::|(?=\s*(?:use|nutze|verwende|benutz(?:e)?(?:\s+modell)?)\b))\s*:?\s+(.+)/i);
  if (!match) return null;
  const isModelOnlyMarker = match[1].toUpperCase() !== 'HINT';
  const instruction = match[2].trim();

  // Group hint: "use group tactical", "verwende Gruppe X", "nutze gruppe X", "benutze Gruppe X"
  // (only for the plain user HINT marker — MHINT variants are model-only)
  const groupMatch = isModelOnlyMarker
    ? null
    : instruction.match(
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
    // Guard (roborev job 451 LOW): if the optional verb prefix consumed
    // nothing and the captured target IS the verb itself (e.g. "HINT use"
    // with no model), reject - let the LLM classifier handle it instead of
    // trying to resolve a model literally named "use"/"nutze"/etc.
    const knownVerbs = new Set(['use', 'nutze', 'verwende', 'benutze', 'benutzt']);
    if (target.length > 0 && !knownVerbs.has(target.toLowerCase())) {
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

/**
 * Converts a raw LLM `hint:*` classification (e.g. {category:
 * 'hint:group:tactical', reason}) into a processed HintClassificationResult
 * (hintType + hintTarget). Shared by the Ollama path and the cloud fallback
 * loop inside classifyPrompt so both produce identical hint semantics.
 * Returns null when the hint target is empty or malformed — callers degrade
 * (Ollama: explicit fallback classification; cloud: skip to next model).
 * Takes the raw parsed JSON object (any, guarded internally with typeof
 * checks — same convention as isValidFullClassification).
 */
function toHintClassification(parsed: any): FullClassificationResult | null {
  const category = typeof parsed.category === 'string' ? parsed.category : '';
  if (!isHintCategory(category)) return null;
  const hintTarget = category.slice(5).trim(); // Remove 'hint:' prefix
  if (!hintTarget) return null;

  if (hintTarget.startsWith('group:')) {
    // This is a group hint
    const groupName = hintTarget.slice(6).trim(); // Remove 'group:' prefix
    if (!groupName) return null;
    return {
      reason: parsed.reason || 'User specified group via HINT',
      confidence: 1.0,
      hintType: 'group',
      hintTarget: groupName,
    };
  }

  // This is a model hint — clean up common prefixes like "use ", "nutze ".
  let cleanHintTarget = hintTarget;
  const verbPrefixes = ['use ', 'use:', 'nutze ', 'nutze:', 'utilise ', 'utilise:', 'utilizar ', 'utilizar:'];
  for (const prefix of verbPrefixes) {
    if (cleanHintTarget.toLowerCase().startsWith(prefix)) {
      cleanHintTarget = cleanHintTarget.slice(prefix.length).trim();
      break;
    }
  }
  if (!cleanHintTarget) return null; // e.g. "hint:use" with nothing after the verb
  return {
    reason: parsed.reason || 'User specified model via HINT',
    confidence: 1.0,
    hintType: 'model',
    hintTarget: cleanHintTarget,
  };
}

/**
 * True when the user request itself carries a HINT marker ANYWHERE — not
 * only at the start (start-position hints are handled by detectHintDirectly
 * before any LLM path). This is the spurious guard for raw hint:* LLM
 * replies in the cloud fallback loop: without a marker in the CURRENT
 * request, such a reply means the model copied HINT narration out of the
 * context block (voxtral incident 2026-09-26) and must not be trusted.
 * Mirrors detectHintDirectly's colon/verb-lookahead disambiguation so prose
 * like "can I get a hint about…" does not count.
 */
function containsHintMarker(prompt: string): boolean {
  return /(?:^|[^A-Za-z0-9_-])(?:HINT|MHINT|MODEL[-_]HINT)\b\s*(?::|(?=\s*(?:use|nutze|verwende|benutz(?:e)?(?:\s+modell)?)\b))\s*:?\s+\S/i.test(prompt);
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
    completeSimple,
    findModel,
    availableModels,
    pinnedCloudModel,
  } = options;

  // Detect HINT prefix deterministically — no LLM needed, always correct.
  const directHint = detectHintDirectly(prompt);
  if (directHint) return directHint;

  // Model momentum: during compaction we need a model with enough context
  // window. If the last model was a large cloud model, reuse it. If it was a
  // small local model (which can't handle the full compacted context), route
  // to 'strategic' instead — the context-window guard in driveStream will
  // skip any model that's too small.
  if (context.isCompaction) {
    // Check if the last model has a large enough context window for compaction.
    // Local models (ollama, lm-studio) often have small windows (4K-8K).
    if (context.lastModel && !context.lastModelLimited) {
      const isSmallLocal = /ollama\/|lm-studio\//i.test(context.lastModel) ||
                          /\b(2b|3b|4b|7b|8b|9b|12b|14b)\b/i.test(context.lastModel);
      if (!isSmallLocal) {
        return {
          reason: 'Model continuity during compaction (large model)',
          confidence: 1.0,
          hintType: 'model',
          hintTarget: context.lastModel,
          origin: 'auto',
        };
      }
    }
    // Last model was small, unknown, or currently in cooldown (just failed) —
    // route to strategic for compaction instead of hammering the same model.
    return {
      category: 'code_complex',
      reason: context.lastModelLimited
        ? 'Compaction — last model is in cooldown, routing to strategic'
        : 'Compaction — routing to strategic for large context window',
      confidence: 0.9,
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

  // Background context block (shared builder; the HINT-rule scoping and
  // narration-leak caveat live in classification-prompt.ts).
  const contextBlock = buildContextBlock(
    context.previousUserMessage,
    context.lastAssistantSnippet
  );

  // Cache check: only for the LLM-classification path (after the deterministic
  // early-returns above). Cache key is the raw prompt — the deterministic cases
  // (HINT, compaction, short-prompt momentum) never reach here, and context
  // (previous message / last assistant snippet) varies per turn so we only
  // cache when there's no context block, to avoid a stale hit when the same
  // prompt re-appears in a different conversation context.
  if (!contextBlock) {
    const cached = classifyCacheGet(prompt);
    if (cached) return cached;
  }

  const ollamaPrompt = buildClassificationPrompt(prompt, contextBlock);

  const tryClassify = async (m: string, t: number): Promise<FullClassificationResult> => {
    const response = await callOllama(m, ollamaPrompt, { timeoutMs: t });
    // Strip reasoning blocks and extract the first JSON object — shared
    // helper (identical to the former inline extraction; null means
    // unparseable, which degrades exactly like the old thrown SyntaxError).
    const extracted = extractClassificationJson(response);
    if (!extracted) {
      throw new Error(`Invalid format: ${response}`);
    }
    const parsed = extracted as ClassificationResult;
    if (!isValidFullClassification(parsed)) {
      // If category is invalid but structure is valid, map to fallback
      const rawParsed = parsed as any;
      if (rawParsed && typeof rawParsed.category === 'string' && typeof rawParsed.reason === 'string') {
        routerLog(`[classifier] Invalid category "${rawParsed.category}" from LLM, falling back to 'fallback'`);
        return { category: 'fallback', reason: rawParsed.reason, confidence: rawParsed.confidence ?? 0 };
      }
      throw new Error(`Invalid format: ${response}`);
    }
    
    // Check for HINT override in the classification result.
    // Conversion is shared with the cloud fallback loop via
    // toHintClassification so both paths produce identical hint semantics
    // (code review 2026-09-26, Important #1).
    if (isHintCategory(parsed.category)) {
      const hint = toHintClassification(parsed);
      if (!hint) {
        routerLog(`[classifier] Unusable HINT target received from LLM: ${parsed.category}`);
        return {
          category: 'fallback',
          reason: 'Empty or malformed HINT target from LLM',
          confidence: 0.5,
        };
      }
      return hint;
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

  // Primary model — may be slow on cold start. A short availability probe
  // guards BOTH local attempts: when the daemon is unreachable (down or
  // hanging port), we skip straight to the cloud fallback chain instead of
  // burning primary+fallback timeouts on every prompt.
  let classificationResult: FullClassificationResult | null = null;
  if (await isOllamaAvailable()) {
    try {
      classificationResult = await tryClassify(model, timeoutMs);
    } catch (primaryError) {
      // Cold-start timeout or load error → retry immediately with the fallback model
      if (model !== fallbackModel) {
        try {
          routerLog(
            `[classifier] Primary model "${model}" failed, retrying with ${fallbackModel}`,
            (primaryError as Error).message
          );
          classificationResult = await tryClassify(fallbackModel, fallbackTimeoutMs);
        } catch (fallbackError) {
          routerLog(`[classifier] Fallback model also failed`, (fallbackError as Error).message);
        }
      }
    }
  } else {
    routerLog('[classifier] Ollama daemon unreachable — skipping both local models');
  }

  // Escalation logic: if we have a classification and lastModel, check if we need to escalate
  if (classificationResult && context.lastModel && !context.isCompaction) {
    const result = applyEscalationLogic(classificationResult, context.lastModel);
    if (result) {
      return result;
    }
  }

  if (classificationResult) {
    // Cache the LLM classification result for repeated identical prompts
    // (only when there was no conversation context — see cache check above).
    if (!contextBlock) classifyCacheSet(prompt, classificationResult);
    return classificationResult;
  }

  // Cloud fallback: when Ollama is unavailable, classify using pi's own
  // model registry (completeSimple) — pi already owns the model list, the
  // auth (keys live in pi's auth store, not router-config.json), and the
  // provider HTTP quirks. The router must NOT roll its own HTTP client + key
  // resolution (the old CloudClient path threw "No API key for provider"
  // whenever the key wasn't duplicated into router-config.json).
  //
  // Model selection: prefer the probe-verified cached list
  // (cache.classifier_fallback_models, populated at scan time by
  // probeAndCache — a quality probe with real classification cases, incl.
  // the HINT-narration trap, filters broken/misclassifying candidates). If
  // the probe hasn't
  // run yet this scan cycle, fall back to selectClassifierCandidates
  // (price + gdpval tiered discovery) and the try-each loop acts as a lazy
  // probe. Only activate when allowCloudFallback is true AND cfg/cache + the
  // pi completeSimple/findModel hooks are available.
  if (allowCloudFallback && cfg && cache && completeSimple && findModel) {
    try {
      // Prefer the probe-verified cached list (fast path — no probing at
      // classification time, the probe ran at scan time).
      let modelsToTry = getCachedFallbackModels(cache);
      let source = 'probed';
      if (modelsToTry.length === 0) {
        // Probe hasn't run or found nothing — lazy discovery as a fallback.
        // This also handles the first classification before the first scan
        // completes the probe.
        modelsToTry = selectClassifierCandidates(cfg, cache);
        source = 'discovered';
      }
      if (modelsToTry.length === 0) {
        // Last resort: the static free_models list from config.
        const discovery = new DiscoveryManager(cfg, cache);
        modelsToTry = discovery.getFreeModels();
        source = 'static-free';
      }
      // Pinned cloud classifier (dynamic group's classifier_cloud_model):
      // tried FIRST — before the probe-verified list — so a user-pinned
      // (e.g. subscription-covered) model classifies deterministically. The
      // findModel guard in the loop below skips it if pi doesn't know it.
      if (pinnedCloudModel) {
        // Tried FIRST — dedup instead of skip so a pinned ref that already
        // sits in the probe-verified list still moves to position 0 (code
        // review 2026-09-26, Minor #3).
        modelsToTry = [pinnedCloudModel, ...modelsToTry.filter((m) => m !== pinnedCloudModel)];
        source = `pinned+${source}`;
      }
      routerLog(`[classifier] Cloud fallback trying ${modelsToTry.length} model(s) (${source}): ${modelsToTry.join(', ')}`);
      // Distinguish "probe ran but all candidates failed" from "probe hasn't
      // run yet" so the empty-list case is diagnosable from logs (roborev
      // job 445 LOW).
      if (modelsToTry.length === 0 && source === 'discovered' && hasProbedFallback(cache)) {
        routerLog('[classifier] Cloud fallback: probe ran at scan time but all probed candidates failed — falling back through discovered/static-free tiers.');
      }

      const classifyCtx: any = {
        messages: [{ role: 'user', content: ollamaPrompt }],
      };

      for (const modelRef of modelsToTry) {
        try {
          const model = findModel(modelRef);
          if (!model) {
            routerLog(`[classifier] Cloud model ${modelRef} not in pi registry — skipping`);
            continue;
          }
          const result = await completeSimple(model, classifyCtx, undefined);
          if (result.errorMessage || result.stopReason === 'error') {
            routerLog(`[classifier] Cloud model ${modelRef} failed`, result.errorMessage ?? 'error');
            continue;
          }
          // AssistantMessage.content is an array of TextContent | ThinkingContent
          // | ToolCall. Concatenate the text blocks (skip <think> blocks).
          const raw = (result.content ?? [])
            .filter((b: any) => b.type === 'text' && typeof b.text === 'string')
            .map((b: any) => b.text)
            .join('');
          // Shared extraction helper (identical to the former inline
          // extraction; null means unparseable, which degrades exactly
          // like the old thrown SyntaxError — catch skips to next model).
          const extracted = extractClassificationJson(raw);
          if (!extracted) {
            throw new Error(`Invalid format from cloud model ${modelRef}`);
          }
          const parsed = extracted as FullClassificationResult;
          if (isValidFullClassification(parsed)) {
            // HINT replies need conversion + a spurious guard (code review
            // 2026-09-26, Important #1): the Ollama path converts raw hint:*
            // categories into processed hints, but this loop returned them
            // AS-IS — an invalid category that pollutes lastClassifiedCategory
            // (short-prompt momentum) and misroutes via the CATEGORY_TO_GROUP
            // miss. A hint:* reply is legitimate only when the CURRENT request
            // itself carries a HINT marker (start-position hints already
            // returned via detectHintDirectly before this loop); otherwise the
            // model copied HINT narration out of the context block (voxtral
            // incident 2026-09-26) and the candidate is skipped like any other
            // bad reply.
            if (isHintCategory((extracted as any).category)) {
              if (!containsHintMarker(prompt)) {
                throw new Error(
                  `Cloud model ${modelRef} echoed a spurious HINT (${(extracted as any).category}) — no HINT in the current request`
                );
              }
              const hint = toHintClassification(extracted);
              if (!hint) {
                throw new Error(`Cloud model ${modelRef} returned an unusable HINT: ${(extracted as any).category}`);
              }
              routerLog(`[classifier] Cloud model ${modelRef} succeeded (HINT conversion via pi completeSimple)`);
              return hint;
            }
            routerLog(`[classifier] Cloud model ${modelRef} succeeded (via pi completeSimple)`);
            // Apply escalation logic to cloud result
            if (context.lastModel && !context.isCompaction) {
              const escalated = applyEscalationLogic(parsed, context.lastModel);
              if (escalated) {
                return escalated;
              }
            }
            return parsed;
          }
        } catch (cloudError) {
          routerLog(`[classifier] Cloud model ${modelRef} failed`, (cloudError as Error).message);
        }
      }
    } catch (cloudFallbackError) {
      routerLog(`[classifier] Cloud fallback failed`, (cloudFallbackError as Error).message);
    }
  }

  // Static fallback
  if (!allowStaticFallback) {
    routerLog('[classifier] Ollama models failed, static classifier disabled — returning fallback');
    // F5 (2026-09-02): apply escalation to the hard-coded fallback too.
    // Previously this returned `{ category:'fallback' }` directly, skipping
    // applyEscalationLogic — so a user on a cheap model who asked a complex
    // question while Ollama was down got `fallback→tactical`, but tactical's
    // intent (escalate to a capable model) was never enforced. Now we build
    // a fallback result and run it through the same escalation path as a
    // successful classification, so the last model's tier still triggers a
    // bump when the task complexity warrants it.
    const fallbackResult: FullClassificationResult = {
      category: 'fallback',
      reason: 'Ollama unavailable, static classifier disabled',
      confidence: 0,
    };
    if (context.lastModel && !context.isCompaction) {
      const escalated = applyEscalationLogic(fallbackResult, context.lastModel);
      if (escalated) return escalated;
    }
    return fallbackResult;
  }

  routerLog('[classifier] Ollama and cloud models failed, falling back to static classification');

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
  const trivialKeywords = [/what(?:'s| is) in\s/i];
  
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
        routerLog('[classifier] HINT override not supported in hook context, falling back to static classification');
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
