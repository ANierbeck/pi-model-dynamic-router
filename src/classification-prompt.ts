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
  'simple',
  'code_simple',
  'standard',
  'code_complex',
  'design',
  'planning',
  'continue',
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
- "HINT: use example-model-1"
- "HINT: use group tactical"
- "HINT: nutze example-model-1"
- "HINT: verwende Gruppe complex"
- "HINT: benutz modell xyz"

If the CURRENT REQUEST (not the Context block) contains a HINT instruction
(in any language), extract the model or group name and return it with the
"hint:" prefix:
- For models: {"category": "hint:example-model-1", "reason": "User specified model via HINT", "confidence": 1.0}
- For groups: {"category": "hint:group:tactical", "reason": "User specified group via HINT", "confidence": 1.0}

If NO HINT is present, first apply this DECISION PROCEDURE:

Step 1 - Does the request open a NEW act with new work content? Does it ask
or instruct the assistant to analyze, review, design, draft, explain, solve,
research, change code, or run a NEW specific operation - opening a work item
of its own, even if it builds on previous context ("ok ...", "yes, but ...")?
Then it is a TASK: classify by task type below. Referencing earlier context
does NOT make a request a continuation.

Step 2 - If instead the request only keeps the CURRENT act moving, classify
as continue:
  - bare go-aheads and approvals ("do it", "go ahead", "yes", "Machen!",
    "weiter", "ok", "Und? fertig?")
  - short directives that mechanically EXECUTE or conclude the current act:
    commit, build, push, rebase, run the tests, prepare it ("Bitte
    committen", "bitte neu bauen", "yes, please rebase on main", "ja, mache
    erst die Tests", "Dann bereite alles dafuer vor.") - including approval +
    directive ("Ok, sieht gut aus. Bitte committen")
  - corrections of the action the assistant is CURRENTLY performing ("stop,
    you don't need to figure out the 503" while it is doing exactly that)
  - mid-task status reports feeding results of the current task back
    ("done, and I see: ...") and status checks on the ongoing work
    ("hast du das committet und gepusht?")

Boundary: mechanical execution/conclusion of the CURRENT act -> continue;
new intellectual work content (a new problem, review, design, analysis,
question, or instruction with its own goal) -> task category. When in doubt
-> task category.

Task categories:

- simple:       Simple requests with clear, short answers ("list files", "show TODOs", "what's in this file?", "read this file", "summarize", "explain briefly", "run this command")
- code_simple:  Small code changes (1-10 lines, syntax fixes, renames, typos)
- standard:     Standard requests (general questions, moderate complexity, look something up and report, "explain this concept")
- code_complex: Substantial changes (refactoring, debugging, new features, >50 lines). Also: analyzing, reviewing, or explaining existing code/documentation, checking a plan before an action ("before we commit, make sure ...").
- design:       Architecture, system design, API design, database schema, weighing options and arguing a design position.
- planning:     Task breakdown, roadmaps, prioritization, project planning, synchronization questions ("did we sync that on GH?").
- continue:     NOT a self-contained task - see Step 2.

The request may be in any language. Classify by complexity and required model capability.
Short requests with clear, simple answers -> simple.
"List TODOs", "Show me the file", "run the whoami command" -> simple.
"Explain this code" (simple code) -> simple.
"Explain this concept" -> standard.
"Design an architecture" -> design.
Short imperatives that continue prior work ("do it", "go ahead", "yes", "Machen!", "weiter") -> continue.
"Analyze / review / explain the code / docs" -> code_complex.
A correction or question that opens a new act ("stop, that wasn't an instruction - are they really deleted?", "save that in your memory") -> the matching task category, NOT continue.
Conversational follow-ups that contain new work are TASKS: "schau mal, meine Antwort sollte angekommen sein, oder?" -> standard; "Dann löse noch das letzte Problem" -> code_complex; "mach es zu einer allgemeinen Aussage" -> standard; "yes I want to focus on the spec part, please ..." -> design.
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
 * The FROZEN short instruction head the fine-tuned Laya classifier was
 * trained on (v2-r3 taxonomy, frozen 2026-10-13). Byte-identical to
 * SHORT_INSTRUCTIONS in ~/.laya-ft/to_laya_jsonl_v2.py, which writes it to
 * laya_head_v2.json; the sidecar serves exactly this head via --head-json
 * (train/serve parity is the hard rule). Laya's window is ~1024 tokens and
 * the full v2-r3 production prompt body alone is ~1000+ tokens, so the head
 * is deliberately condensed — the long-form rules are distilled through the
 * training LABELS, not the question text. DO NOT edit this text without
 * retraining and re-validating; the criteria order below is the choice-head
 * order (choice index -> category by position).
 */
export const LAYA_HEAD_V2_INSTRUCTIONS =
  'Classify the user\'s request into exactly one category. ' +
  'simple: short factual question, lookup, read or run something. ' +
  'code_simple: small clear code change. ' +
  'standard: general or multi-step request with a clear procedure. ' +
  'code_complex: substantial coding, debugging, review or analysis of existing code or docs. ' +
  'design: architecture, API or system design, weighing options. ' +
  'planning: task breakdown, roadmap, prioritization. ' +
  'continue: NOT a self-contained task - a go-ahead, a mechanical step of the current act ' +
  '(commit, build, rebase), a status check or a correction of what the assistant is doing right now. ' +
  'A request that opens a new act (new question or instruction) is never continue.';

/**
 * The typed-decision question Laya receives. The head is the frozen
 * LAYA_HEAD_V2_INSTRUCTIONS (not derived from CLASSIFICATION_PROMPT — see
 * its doc comment), criteria in the trained choice-head order. Used for the
 * prompt-window budget (the client sends only prompt + context; the sidecar
 * owns the question head and must serve the same one via --head-json).
 */
export function buildClassifierLayaQuestion(): { instructions: string; criteria: string[] } {
  return { instructions: LAYA_HEAD_V2_INSTRUCTIONS, criteria: [...VALID_CATEGORIES] };
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
