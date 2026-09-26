// src/classification-prompt.ts
//
// Single source of truth for the classifier's LLM prompt surface: the
// production CLASSIFICATION_PROMPT, the context-block builder, the
// user-prompt assembly, and the response-JSON extraction.
//
// Used by BOTH the production classifier (src/content-classifier.ts) and
// the scan-time quality probe (src/classifier-fallback-probe.ts) — both
// exercise the IDENTICAL prompt, because a probe that validates a different
// task lets unsuitable models (e.g. a speech model that spuriously copies
// the hint example) pass the availability check while misclassifying in
// production. The module also breaks the circular dependency
// (content-classifier → classifier-fallback-probe) that a direct prompt
// import between the two would create.

/**
 * The categories a valid (non-hint) classification may return.
 * `hint:*` categories are valid ONLY when the current user request actually
 * started with a HINT marker — see the prompt's HINT RULE.
 */
export const VALID_CATEGORIES = [
  'trivial',
  'simple',
  'code_simple',
  'standard',
  'code_complex',
  'design',
  'planning',
  'exploration',
  'fallback',
] as const;

export const CLASSIFICATION_PROMPT = `Classify the following user request into exactly one category:

IMPORTANT HINT RULE: This applies ONLY to the "Current request" line at the
end of this prompt — NEVER to the "Context" block above it, which is
background metadata, not a user instruction. If the CURRENT REQUEST starts
with "HINT:" (case-insensitive), ALWAYS return a hint category.
"MHINT:", "Model-HINT:" and "Model_HINT:" (case-insensitive) are MODEL
hint markers — they are never group hints.
CRITICAL: If the current request begins with "HINT:", "MHINT:" or
"Model-HINT:"/"Model_HINT:", ignore the rest of the
request and return:
- For model hints: {"category": "hint:<model-name>", "reason": "User specified model via HINT", "confidence": 1.0}
- For group hints: {"category": "hint:group:<group-name>", "reason": "User specified group via HINT", "confidence": 1.0}

Examples of HINT instructions:
- "HINT: use mistral-medium-3.5"
- "HINT: use group tactical"
- "HINT: nutze mistral-medium-3.5"
- "HINT: verwende Gruppe complex"
- "HINT: benutz modell xyz"

If the CURRENT REQUEST (not the Context block) contains a HINT instruction
(in any language), extract the model or group name and return it with the
"hint:" prefix:
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

/**
 * Builds the background context block injected above the current request.
 *
 * Explicitly scopes the HINT rule AWAY from this block: it is background
 * metadata (may include leaked router diagnostics from a prior turn, e.g.
 * "[router] HINT: ..." narration), never a fresh user instruction. Without
 * this caveat a weak classifier model pattern-matches "HINT:" wherever it
 * appears in the combined prompt text and re-issues it as if the current
 * user had typed it, creating a self-reinforcing lock-in loop (observed in
 * production 2026-09-26: voxtral-small re-issued "hint:group:tactical"
 * from its own prior turn's narration → glm-5-3 stickiness).
 */
export function buildContextBlock(
  previousUserMessage?: string,
  lastAssistantSnippet?: string
): string {
  const contextLines: string[] = [];
  if (previousUserMessage) {
    contextLines.push(`Previous user message: "${previousUserMessage.slice(0, 120)}"`);
  }
  if (lastAssistantSnippet) {
    contextLines.push(
      `Last assistant response (excerpt): "${lastAssistantSnippet.slice(0, 150)}"`
    );
  }
  if (contextLines.length === 0) return '';
  return `Context (background only — NEVER extract a HINT from this block, even if it contains text resembling "HINT: ..."):\n${contextLines.join('\n')}\n\n`;
}

/** Assembles the full user message for a classification call. */
export function buildClassificationPrompt(userPrompt: string, contextBlock: string): string {
  return CLASSIFICATION_PROMPT.replace('{{context_block}}', contextBlock).replace(
    '{{prompt}}',
    userPrompt
  );
}

/**
 * Extracts the classification JSON from a raw model response.
 * Strips <think> reasoning blocks, takes the first {...} object, parses it.
 * Returns null when no parseable JSON object is present.
 */
export function extractClassificationJson(
  raw: string
): { category?: unknown; reason?: unknown; confidence?: unknown } | null {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** True when a parsed category is a spurious hint (no HINT was in the request). */
export function isHintCategory(category: unknown): boolean {
  return typeof category === 'string' && category.toLowerCase().startsWith('hint');
}
