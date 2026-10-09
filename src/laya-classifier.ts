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

/** Conservative chars-per-token ratio for the router's coarse cap (EN ≈ 4, DE ≈ 3.5, code/logs lower). */
const CHARS_PER_TOKEN = 3;
const TRUNCATION_MARKER = '\n[... TRUNCATED ...]\n';

/**
 * Characters available for prompt + context block. Every model input starts
 * with the question head (instructions + the 9 criteria — 408 tokens measured
 * in the spike), so the window is not fully ours. The head size is derived
 * from the production prompt surface instead of being hardcoded, so it follows
 * edits to the category definitions.
 */
export function layaPromptBudgetChars(budgetTokens: number = LAYA_CONTEXT_BUDGET_TOKENS): number {
  const { instructions, criteria } = buildClassifierLayaQuestion();
  const headChars = instructions.length + criteria.join(', ').length;
  return Math.max(0, budgetTokens * CHARS_PER_TOKEN - headChars);
}

/**
 * Emergency brake: shrink the prompt so that prompt + the context block the
 * wrapper prepends fit the model window. The router has no tokenizer, so this
 * is a coarse character bound; the wrapper owns the token-exact cut. The
 * prompt is sent whole whenever it fits — the window is a hard model
 * constraint, not a cost lever. When it does not fit, HEAD and TAIL are kept
 * and only the middle is dropped (the ask is usually at the start, the
 * pasted material's conclusion at the end).
 *
 * Returns the prompt part only; the context travels separately (see
 * classifyWithLayaRaw) because the wrapper builds the context block itself.
 */
export function truncatePromptForLaya(
  prompt: string,
  context: ClassificationContext | undefined,
  budgetTokens: number = LAYA_CONTEXT_BUDGET_TOKENS,
): string {
  const contextChars = buildContextBlock(context?.previousUserMessage, context?.lastAssistantSnippet).length;
  const allowed = Math.max(0, layaPromptBudgetChars(budgetTokens) - contextChars);
  if (prompt.length <= allowed) return prompt;
  const chunk = Math.floor((allowed - TRUNCATION_MARKER.length) / 2);
  // Degenerate budget (no room for head + marker + tail): a plain prefix is the
  // only honest cut. Also guards slice(-0), which would return the whole string.
  if (chunk < 1) return prompt.slice(0, allowed);
  return prompt.slice(0, chunk) + TRUNCATION_MARKER + prompt.slice(prompt.length - chunk);
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

let _probeInFlight: Promise<boolean> | null = null;

/**
 * Availability for the next request. A fresh state (healthy OR down) is
 * trusted for its TTL — a down sidecar must not be hammered. An unknown or
 * expired state triggers ONE probe (concurrent callers share it), so the
 * stage needs no startup hook and recovers on its own after a restart of the
 * sidecar; nothing else in the router calls probeLaya().
 */
async function ensureLayaAvailable(endpoint: string, timeoutMs: number): Promise<boolean> {
  if (_availability && Date.now() <= _availability.until) return _availability.ok;
  _probeInFlight ??= probeLaya(endpoint, timeoutMs).finally(() => {
    _probeInFlight = null;
  });
  return _probeInFlight;
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

/** Low-level HTTP call to the wrapper (`endpoint` is the base URL; `/classify` is appended). */
export async function classifyWithLayaRaw(
  prompt: string,
  context: ClassificationContext | undefined,
  endpoint: string,
  timeoutMs: number
): Promise<{ category: string; confidence: number; probabilities: Record<string, number>; ms: number }> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body: Record<string, unknown> = { prompt: truncatePromptForLaya(prompt, context) };
    // Nested, and only the fields that exist — the wrapper reads `context` and
    // builds the context block itself.
    const ctx: Record<string, string> = {};
    if (context?.previousUserMessage) ctx.previousUserMessage = context.previousUserMessage;
    if (context?.lastAssistantSnippet) ctx.lastAssistantSnippet = context.lastAssistantSnippet;
    if (Object.keys(ctx).length > 0) body.context = ctx;
    const t0 = performance.now();
    const res = await fetch(`${endpoint.replace(/\/+$/, '')}/classify`, {
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

export interface LayaAnswer {
  category: string;
  confidence: number;
  probabilities: Record<string, number>;
  ms: number;
}

/**
 * Apply the stage's veto rules to a raw answer; null = the chain must go on.
 * - below `confidence_threshold` (written so that NaN also fails);
 * - `fallback`: it means "could not tell", and in the spike it was the most
 *   frequent confident answer (51 of 85) — returning it would shadow every
 *   better classifier behind this stage;
 * - anything outside the production taxonomy.
 */
function vetAnswer(answer: LayaAnswer, threshold: number): ClassificationResult | null {
  if (!(answer.confidence >= threshold)) return null;
  if (answer.category === 'fallback' || !VALID_CATEGORIES.includes(answer.category as never)) return null;
  const top = Object.entries(answer.probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2);
  const reason = top.map(([c, p]) => `${c} (${(p * 100).toFixed(0)}%)`).join('; ');
  return { category: answer.category as ClassificationResult['category'], reason, confidence: answer.confidence };
}

/**
 * Like {@link classifyWithLaya} but also exposes the raw answer when the stage
 * falls through (low confidence, `fallback`) — shadow mode logs exactly that.
 * Null = disabled, sidecar unavailable, or the request failed.
 */
export async function classifyWithLayaDetailed(
  prompt: string,
  context: ClassificationContext | undefined,
  options: { cfg?: Config; checkpoint: string },
): Promise<{ answer: LayaAnswer; result: ClassificationResult | null } | null> {
  const cfg = options.cfg?.classifier_laya;
  if (!cfg || !cfg.enabled) return null;
  if (!(await ensureLayaAvailable(cfg.endpoint!, cfg.timeout_ms!))) return null;

  let answer: LayaAnswer;
  try {
    answer = await classifyWithLayaRaw(prompt, context, cfg.endpoint!, cfg.timeout_ms!);
  } catch (err) {
    markUnavailable(err instanceof Error ? err.message : String(err));
    warnLog(`[router] classifier_laya: classify failed — ${err instanceof Error ? err.message : String(err)}; stage disabled`);
    return null;
  }
  return { answer, result: vetAnswer(answer, cfg.confidence_threshold ?? 0.8) };
}

/**
 * Classify with the Laya stage. Returns null when disabled/unavailable, below
 * confidence_threshold, or vetoed (see vetAnswer) — the chain falls through.
 * `checkpoint` names the chain source `laya:<checkpoint>` for the caller.
 */
export async function classifyWithLaya(
  prompt: string,
  context: ClassificationContext | undefined,
  options: { cfg?: Config; checkpoint: string },
): Promise<ClassificationResult | null> {
  return (await classifyWithLayaDetailed(prompt, context, options))?.result ?? null;
}
