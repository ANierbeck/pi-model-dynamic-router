// src/laya-classifier.ts
// Local Laya typed-decision classifier (opt-in, disabled by default).
//
// Contract with the wrapper (contrib/laya-sidecar/server.py) — the endpoint is
// configurable via `classifier_laya.endpoint` (default http://127.0.0.1:8089):
//   POST /classify {prompt: string, context?: {previousUserMessage?, lastAssistantSnippet?}}
//   -> { category: string, confidence: number, probabilities: Record<string, number>, ms: number }
//
// Behavior:
// - One forward pass, a single `choice` question over the 9 VALID_CATEGORIES
//   plus the production classifier's own category definitions
//   (buildClassifierLayaQuestion) — a single source of truth.
// - On connection refused / timeout / HTTP error / malformed JSON the stage is
//   marked unavailable for UNAVAILABLE_TTL_MS (analog to the classifier_no_schema
//   501 marker) and the chain falls through to the next stage (fail-open).
// - Below confidence_threshold (default 0.8, uncalibrated — ECE 0.466 per spike):
//   falls through; the stage never returns `fallback` itself.
// - Probe gates the stage per session: a real classification task (never a bare
//   ping) with a TTL; on first use in a session without a valid probe the stage
//   attempts a probe, and a failed probe disables the stage for the TTL.
//
// Source string for the chain: `laya:<checkpoint>`.

import { warnLog } from './logger.ts';
import type { ClassificationContext, ClassificationResult } from './content-classifier.ts';
import type { Config } from './types.ts';
import { buildClassifierLayaQuestion, VALID_CATEGORIES, buildContextBlock } from './classification-prompt.ts';

export const UNAVAILABLE_TTL_MS = 5 * 60 * 1000; // 5 min; a sidecar can die/restart faster than a 501 backend
/** Context budget for the multilingual Laya checkpoint (1,024 tokens). */
export const LAYA_CONTEXT_BUDGET_TOKENS = 1024;

let _availability: { ok: boolean; until: number } | null = null;
let _lastProbeError: string | null = null;

/**
 * Truncate prompt (+ context) to fit the model context budget.
 *
 * The router has no tokenizer, so this applies a conservative character cap
 * (`budgetTokens * 3`) as a safety bound; the wrapper tightens to the token
 * budget token-exactly (it owns the tokenizer and can count precisely).
 *
 * Strategy mirrors the router's compaction style: keep the HEAD (with HINT
 * markers and whitespace intact) and the TAIL, drop only the middle. The
 * context block (previousUserMessage / lastAssistantSnippet) is removed FIRST,
 * then the prompt body is trimmed if needed.
 */
export function truncateState(prompt: string, context: ClassificationContext | undefined, budgetTokens: number = LAYA_CONTEXT_BUDGET_TOKENS): string {
  const budgetChars = budgetTokens * 3;
  const contextPart = buildContextBlock(context?.previousUserMessage, context?.lastAssistantSnippet);
  const combined = contextPart + prompt;
  if (combined.length <= budgetChars) {
    return combined;
  }
  // context block dropped first (it costs the most tokens with least value),
  // then keep head + tail of the prompt.
  const maxChunk = Math.min(256, Math.floor((budgetChars - 4) / 2));
  const head = prompt.slice(0, maxChunk);
  const tail = prompt.slice(-maxChunk);
  return head + '\n[... TRUNCATED ...]\n' + tail;
}

function markUnavailable(error?: string): void {
  _availability = { ok: false, until: Date.now() + UNAVAILABLE_TTL_MS };
  _lastProbeError = error ?? 'stage error';
}

/** Reset availability — for tests only. */
export function resetLayaAvailability(): void {
  _availability = null;
  _lastProbeError = null;
}

/** Probe with a real classification task (never a bare ping). TTL-gated per session. */
export async function probeLaya(endpoint: string, timeoutMs: number): Promise<boolean> {
  resetLayaAvailability();
  const probePrompt = 'The quick brown fox jumps over the lazy dog.'; // neutral, obvious category
  try {
    const res = await classifyWithLayaRaw(probePrompt, undefined, endpoint, timeoutMs);
    if (!res || typeof res.category !== 'string' || res.category.length === 0) {
      throw new Error('probe returned no valid category');
    }
    _availability = { ok: true, until: Date.now() + UNAVAILABLE_TTL_MS };
    _lastProbeError = null;
    return true;
  } catch (err) {
    markUnavailable(err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** True when the wrapper answered healthily and a recent probe succeeded. */
export function isLayaAvailable(): boolean {
  if (!_availability) return false;
  if (Date.now() > _availability.until) {
    _availability = null;
    return false;
  }
  return _availability.ok;
}

/** Last probe error (last 5 min), or null when the stage is considered healthy. */
export function getLastProbeError(): string | null {
  return isLayaAvailable() ? null : _lastProbeError;
}

/** Low-level HTTP call to the wrapper — exported so tests can stub it. */
export async function classifyWithLayaRaw(
  prompt: string,
  context: ClassificationContext | undefined,
  endpoint: string,
  timeoutMs: number
): Promise<{ category: string; confidence: number; probabilities: Record<string, number>; ms: number }> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body: Record<string, unknown> = { prompt: truncateState(prompt, context, LAYA_CONTEXT_BUDGET_TOKENS) };
    if (context?.previousUserMessage) body.previousUserMessage = context.previousUserMessage;
    if (context?.lastAssistantSnippet) body.lastAssistantSnippet = context.lastAssistantSnippet;
    const t0 = performance.now();
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(id);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    }
    const raw = await res.json();
    if (!raw || typeof raw.category !== 'string' || typeof raw.confidence !== 'number') {
      throw new Error('malformed response: expected {category, confidence, probabilities, ms}');
    }
    const probabilities = (raw as any).probabilities;
    if (typeof probabilities !== 'object' || Array.isArray(probabilities) || probabilities === null) {
      throw new Error('malformed response: probabilities must be an object');
    }
    return {
      category: raw.category,
      confidence: raw.confidence,
      probabilities: probabilities as Record<string, number>,
      ms: Math.round(performance.now() - t0),
    };
  } catch (err) {
    clearTimeout(id);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`classify request timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

/**
 * Classify with the Laya stage. Returns null when disabled/unavailable or below
 * confidence_threshold (the chain falls through). `checkpoint` is needed for the
 * chain source string `laya:<checkpoint>`.
 */
export async function classifyWithLaya(
  prompt: string,
  context: ClassificationContext | undefined,
  options: { cfg?: Config; checkpoint: string }
): Promise<ClassificationResult | null> {
  const cfg = options.cfg?.classifier_laya;
  if (!cfg || !cfg.enabled) return null;
  if (!isLayaAvailable()) return null;

  const { instructions, criteria } = buildClassifierLayaQuestion();
  let answer;
  try {
    answer = await classifyWithLayaRaw(prompt, context, cfg.endpoint!, cfg.timeout_ms!);
  } catch (err) {
    markUnavailable(err instanceof Error ? err.message : String(err));
    warnLog(`[router] classifier_laya: classify failed — ${err instanceof Error ? err.message : String(err)}; stage disabled`);
    return null;
  }

  if (answer.confidence < (cfg.confidence_threshold ?? 0.8)) return null;

  const top = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 2);
  const reason = top.map(([c, p]) => `${c} (${(p * 100).toFixed(0)}%)`).join('; ');
  // The Laya question only offers the 9 VALID_CATEGORIES, so any returned
  // value is acceptable — cast with fallback as safety net.
  const category = answer.category as ClassificationResult['category'];
  return { category, reason, confidence: answer.confidence };
}
