// src/escalation.ts
// Session loop detection and model-group escalation.
// Owns all escalation state so index.ts stays clean.

import { callOllama } from './ollama-utils.ts';
import { routerLog } from './logger.ts';

export type EscalationLevel = 'operational' | 'tactical' | 'strategic';

const ESCALATION_GROUPS: EscalationLevel[] = ['operational', 'tactical', 'strategic'];

// ── Internal helpers ───────────────────────────────────────────────────────

function extractErrorKeywords(text: string): string[] {
  const keywords = ['error', 'failed', 'wrong', 'incorrect', 'not working', 'does not work', 'broken', 'issue', 'problem'];
  const lower = text.toLowerCase();
  return keywords.filter(kw => lower.includes(kw));
}

function extractUserCorrections(text: string): string[] {
  const corrections = ['again', 'still', 'once more', 'try again', 'nochmal', 'immer noch', 'wieder', 'erneut'];
  const lower = text.toLowerCase();
  return corrections.filter(c => lower.includes(c));
}

/**
 * Single-turn frustration/failure signal. Deliberately looks at the LATEST
 * turn alone rather than requiring the pattern to repeat across 2 consecutive
 * turns (an earlier version used `history.slice(-2).every(...)`, so a single
 * "you stopped again, please proceed" message never fired it: the turn
 * before it is ordinary and `.every()` failed). Real users only say
 * "again"/"still"/"nochmal" ONCE per incident, not twice in a row.
 *
 * USER PROMPT ONLY (roborev job 373 MEDIUM): the assistant's own response
 * text is deliberately never scanned. index.ts's only caller invokes
 * recordTurn() TWICE per logical exchange — once with the user's prompt
 * (assistant text empty), once with the assistant's response (prompt empty)
 * — so a signal keyed off `response` would double-count within one exchange.
 * Worse, the router's own auto-generated fallback narration (pushed into the
 * assistant's message via pushRouterInfo/pushRouterInfoLogged, e.g. "...
 * error: ..." or "...failed, trying ...") would then drive escalation on
 * its own during a rough patch of provider failures, with no real user
 * frustration involved at all.
 */
function hasFrustrationSignal(prompt: string): boolean {
  return extractUserCorrections(prompt).length > 0 || extractErrorKeywords(prompt).length > 0;
}

function nextLevel(current: EscalationLevel): EscalationLevel {
  const idx = ESCALATION_GROUPS.indexOf(current);
  return idx < ESCALATION_GROUPS.length - 1
    ? ESCALATION_GROUPS[idx + 1]
    : ESCALATION_GROUPS[ESCALATION_GROUPS.length - 1];
}

// ── LLM-based loop detection ───────────────────────────────────────────────

const LOOP_DETECTION_PROMPT_TEMPLATE = `You are an expert at detecting session loops in AI conversations.
Analyze the following conversation history and determine if the session is stuck in a loop:

1. A loop exists if the same problem is discussed multiple times without progress
2. Look for repeated errors, identical questions, or user frustration signals
3. User frustration signals include: "again", "still", "once more", "try again", "nochmal", "immer noch"

If the session is stuck in a loop, respond with:
{"shouldEscalate": true, "reason": "<brief explanation>"}

If the session is progressing normally, respond with:
{"shouldEscalate": false, "reason": "No loop detected"}

Conversation history (most recent last):
{{history}}

Respond with valid JSON only:`;

export async function detectLoopWithLLM(
  history: Array<{ prompt: string; response: string }>,
  options: { model?: string; timeoutMs?: number } = {}
): Promise<{ shouldEscalate: boolean; reason: string }> {
  const historyText = history
    .map((t, i) => `Turn ${i + 1}:\nUser: ${t.prompt.slice(0, 200)}\nAssistant: ${t.response.slice(0, 200)}`)
    .join('\n\n');
  const prompt = LOOP_DETECTION_PROMPT_TEMPLATE.replace('{{history}}', historyText);

  try {
    const modelRef = options.model ?? 'ollama/gemma2:2b';
    const ollamaModel = modelRef.startsWith('ollama/') ? modelRef.slice(7) : modelRef;
    const response = await callOllama(ollamaModel, prompt, { timeoutMs: options.timeoutMs ?? 10_000 });
    try {
      return JSON.parse(response) as { shouldEscalate: boolean; reason: string };
    } catch {
      const lower = response.toLowerCase();
      if (lower.includes('true') || lower.includes('escalate')) {
        return { shouldEscalate: true, reason: 'LLM detected loop (non-JSON response)' };
      }
      return { shouldEscalate: false, reason: 'No loop detected (non-JSON response)' };
    }
  } catch (err) {
    routerLog('[escalation] LLM loop detection failed', err);
    return { shouldEscalate: false, reason: 'LLM unavailable, using rule-based detection' };
  }
}

// ── SessionEscalation class ────────────────────────────────────────────────

export type TurnRecord = { prompt: string; response: string };

/**
 * Tracks per-session escalation state.
 * Create one instance per session; call reset() on session_start.
 *
 * Two-tier detection:
 *  1. Streak-based check (synchronous, every turn) — the LATEST turn alone is
 *     scanned for frustration/failure keywords; STREAK_THRESHOLD consecutive
 *     hits escalates one tier and resets the streak.
 *  2. LLM check (fire-and-forget, gemma2:2b, every 3rd turn) — a slower,
 *     secondary signal for loops the keyword streak misses. Its result is
 *     ignored when the streak check already escalated in the same recordTurn
 *     call, preventing double-escalation. A monotonic _sessionId ensures
 *     stale promises from a previous session cannot affect the new session
 *     even if they resolve after reset().
 */
// Consecutive turns carrying a frustration/failure signal before the
// streak-based rule escalates. Matches the observed real-world pattern: a
// user doesn't say "you stopped again" on the FIRST stall (that's normal
// retry noise) but does by the third — escalating on the first occurrence
// would be too trigger-happy, escalating only after 3+ separate incidents
// isn't.
const STREAK_THRESHOLD = 3;

export class SessionEscalation {
  private _level: EscalationLevel = 'operational';
  private _history: TurnRecord[] = [];
  private _llmInFlight = false;
  private _sessionId = 0;
  private _classifierModel: string;
  private _correctionStreak = 0;
  private _streakEscalatedPending = false;

  /**
   * @param classifierModel Ollama ref used for LLM-based loop detection. Should come
   *   from the dynamic group's classifier_fallback in router-config.json — the local
   *   model set differs per setup, so this must not be hardcoded.
   */
  constructor(classifierModel = 'ollama/gemma2:2b') {
    this._classifierModel = classifierModel;
  }

  get level(): EscalationLevel {
    return this._level;
  }

  /** Consecutive turns carrying a frustration/failure signal (diagnostic). */
  get correctionStreak(): number {
    return this._correctionStreak;
  }

  /** Update the classifier model after config load (constructor runs before config is available). */
  setClassifierModel(classifierModel: string): void {
    this._classifierModel = classifierModel;
  }

  reset(): void {
    this._level = 'operational';
    this._history = [];
    this._sessionId++;
    this._correctionStreak = 0;
    this._streakEscalatedPending = false;
  }

  /**
   * Call once per turn_end event for both user and assistant messages
   * (index.ts calls this TWICE per logical exchange: once with the user's
   * prompt and an empty response, once with an empty prompt and the
   * assistant's response).
   */
  recordTurn(prompt: string, response: string): void {
    this._history.push({ prompt, response });

    // Streak-based check: runs on the USER's half of the exchange only (see
    // hasFrustrationSignal's docstring for why response text is never
    // scanned) so one logical exchange advances the streak by exactly one,
    // not up to two, and the router's own fallback narration in the
    // assistant's response can never drive escalation on its own. Escalates
    // once the same signal has shown up STREAK_THRESHOLD times in a row,
    // resetting on any user turn that doesn't carry it (a single clean turn
    // means it wasn't a real ongoing loop).
    if (prompt.trim().length > 0) {
      if (hasFrustrationSignal(prompt)) {
        this._correctionStreak++;
        if (this._correctionStreak >= STREAK_THRESHOLD) {
          const prev = this._level;
          this._level = nextLevel(this._level);
          this._correctionStreak = 0;
          if (prev !== this._level) {
            // Persisted on the instance (not a call-local variable) because the
            // periodic _checkAndEscalate trigger below fires on raw call count,
            // not on which half of the split user/assistant exchange it lands
            // on (roborev job 376 MEDIUM) — it can fire on the very NEXT call
            // (the assistant-only half, empty prompt), which would otherwise
            // see a call-local flag reset to its default and wrongly permit
            // the LLM path to stack a second escalation on top of this one.
            this._streakEscalatedPending = true;
            routerLog(`[escalation] Streak-based escalation (${STREAK_THRESHOLD} consecutive frustration signals). Upgraded from ${prev} to ${this._level}`);
          }
        }
      } else {
        this._correctionStreak = 0;
      }
    }

    // Check every 3rd turn, starting when we have at least 2 entries.
    if (this._history.length >= 2 && (this._history.length - 2) % 3 === 0) {
      this._checkAndEscalate();
    }
  }

  /**
   * LLM-based escalation check (fire-and-forget, gemma2:2b). The synchronous
   * rule-based path lives entirely in recordTurn's streak counter above —
   * this is a secondary, slower signal for loops the keyword streak misses
   * (e.g. repeated semantic frustration without the specific tracked words).
   * Consumes `_streakEscalatedPending` (set by recordTurn's streak check) to
   * prevent a double-escalation when the streak already bumped the level
   * recently — the async LLM result resolves later and must not stack a
   * second bump on top of one the streak already applied.
   */
  private _checkAndEscalate(): void {
    const alreadyEscalatedThisTurn = this._streakEscalatedPending;
    this._streakEscalatedPending = false;
    const recent = this._history.slice(-2);

    if (!this._llmInFlight) {
      this._llmInFlight = true;
      const levelAtCallTime = this._level;
      const sessionAtCallTime = this._sessionId;
      detectLoopWithLLM(recent, { model: this._classifierModel, timeoutMs: 8_000 })
        .then(result => {
          this._llmInFlight = false;
          if (
            result.shouldEscalate &&
            !alreadyEscalatedThisTurn &&
            this._level === levelAtCallTime &&
            this._sessionId === sessionAtCallTime
          ) {
            const prev = this._level;
            this._level = nextLevel(this._level);
            if (prev !== this._level) {
              routerLog(`[escalation] LLM escalation. Upgraded from ${prev} to ${this._level}`);
            }
          }
        })
        .catch(err => {
          this._llmInFlight = false;
          routerLog('[escalation] LLM loop detection failed', err);
        });
    }
  }
}
