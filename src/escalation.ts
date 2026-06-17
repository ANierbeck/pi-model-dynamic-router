// src/escalation.ts
// Session loop detection and model-group escalation.
// Owns all escalation state so index.ts stays clean.

import { callOllama } from './ollama-utils.js';

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

function detectLoopRuleBased(history: Array<{ prompt: string; response: string }>, lookback = 2): boolean {
  if (history.length < lookback) return false;
  const recent = history.slice(-lookback);
  const hasErrors = recent.every(t =>
    extractErrorKeywords(t.prompt).length > 0 || extractErrorKeywords(t.response).length > 0
  );
  const userTurns = recent.filter(t => t.prompt.trim().length > 0);
  const hasCorrections = userTurns.length > 0 && userTurns.every(t =>
    extractUserCorrections(t.prompt).length > 0
  );
  return hasErrors || hasCorrections;
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
    console.warn(`[escalation] LLM loop detection failed: ${err}`);
    return { shouldEscalate: false, reason: 'LLM unavailable, using rule-based detection' };
  }
}

// ── SessionEscalation class ────────────────────────────────────────────────

export type TurnRecord = { prompt: string; response: string };

/**
 * Tracks per-session escalation state.
 * Create one instance per session; call reset() on session_switch.
 *
 * Two-tier detection:
 *  1. Rule-based check (synchronous, immediate) — keyword matching.
 *  2. LLM check (fire-and-forget, gemma2:2b) — always fired, but its result is
 *     ignored when rule-based already escalated, preventing double-escalation.
 *     A monotonic _sessionId ensures stale promises from a previous session
 *     cannot affect the new session even if they resolve after reset().
 */
export class SessionEscalation {
  private _level: EscalationLevel = 'operational';
  private _history: TurnRecord[] = [];
  private _llmInFlight = false;
  private _sessionId = 0;

  get level(): EscalationLevel {
    return this._level;
  }

  reset(): void {
    this._level = 'operational';
    this._history = [];
    this._sessionId++;
  }

  /** Call once per turn_end event for both user and assistant messages. */
  recordTurn(prompt: string, response: string): void {
    this._history.push({ prompt, response });
    // Check every 3rd turn, starting when we have at least 2 entries.
    if (this._history.length >= 2 && (this._history.length - 2) % 3 === 0) {
      this._checkAndEscalate();
    }
  }

  private _checkAndEscalate(): void {
    const recent = this._history.slice(-2);
    const ruleFired = detectLoopRuleBased(recent);

    if (!this._llmInFlight) {
      this._llmInFlight = true;
      const levelAtCallTime = this._level;
      const sessionAtCallTime = this._sessionId;
      detectLoopWithLLM(recent, { model: 'ollama/gemma2:2b', timeoutMs: 8_000 })
        .then(result => {
          this._llmInFlight = false;
          if (
            result.shouldEscalate &&
            !ruleFired &&
            this._level === levelAtCallTime &&
            this._sessionId === sessionAtCallTime
          ) {
            const prev = this._level;
            this._level = nextLevel(this._level);
            if (prev !== this._level) {
              console.log(`[escalation] LLM escalation. Upgraded from ${prev} to ${this._level}`);
            }
          }
        })
        .catch(err => {
          this._llmInFlight = false;
          console.warn(`[escalation] LLM loop detection failed: ${err}`);
        });
    }

    if (ruleFired) {
      const prev = this._level;
      this._level = nextLevel(this._level);
      if (prev !== this._level) {
        console.log(`[escalation] Rule-based loop detection. Upgraded from ${prev} to ${this._level}`);
      }
    }
  }
}
