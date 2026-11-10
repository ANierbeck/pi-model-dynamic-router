// src/laya-classifier.ts
// Local Laya typed-decision classifier (opt-in, disabled by default).
//
// Contract with the wrapper (spikes/laya-http/server.py) — the endpoint is
// configurable via `integrations.laya.endpoint` (default http://127.0.0.1:8089):
//   POST /classify {prompt: string, context?: {previousUserMessage?, lastAssistantSnippet?}}
//   -> { category: string, confidence: number, probabilities: Record<string, number>, ms: number }
//
// Behavior:
// - One forward pass, a single `choice` question over the 7 VALID_CATEGORIES
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
// Source string for the chain: `laya:<model>@<version>` as the sidecar
// reports it on GET /health, else `laya:<checkpoint>` as configured (plan
// 2026-11-08-laya-model-artifact.md, Solution 5).

import { warnLog } from './logger.ts';
import {
  type IntegrationSpec,
  getIntegrationHealth,
  resetIntegrationHealth,
  setIntegrationHealth,
} from './integration.ts';
import type { ClassificationContext, ClassificationResult } from './content-classifier.ts';
import type { Config } from './types.ts';
import {
  buildClassifierLayaQuestion,
  VALID_CATEGORIES,
  buildContextBlock,
} from './classification-prompt.ts';
import { textOf } from './utils.ts';
import { headSha256, isSafeName } from './laya-model-manifest.ts';

/** Where the sidecar listens unless `integrations.laya.endpoint` says otherwise (a base URL). */
export const LAYA_DEFAULT_ENDPOINT = 'http://127.0.0.1:8089';
export const UNAVAILABLE_TTL_MS = 5 * 60 * 1000; // 5 min; a sidecar can die/restart faster than a 501 backend
/**
 * Consecutive classify timeouts that take the stage down. One slow answer is
 * latency (the sidecar shares the GPU: the same work took 22 ms to 2.6 s on the
 * owner's machine), not an outage — it must not hand the next five minutes of
 * prompts to the cloud chain. A run of timeouts is a hung sidecar, which must
 * not tax every prompt with the full timeout either.
 */
export const TIMEOUT_STRIKES_BEFORE_DOWN = 3;
/** Context budget for the multilingual Laya checkpoint (1,024 tokens). */
export const LAYA_CONTEXT_BUDGET_TOKENS = 1024;

/** Laya's declaration for the integration contract (src/integration.ts). */
export const LAYA_SPEC: IntegrationSpec = {
  name: 'laya',
  label: 'integrations.laya',
  modes: ['active', 'shadow'],
  defaultMode: 'shadow',
  defaultTimeoutMs: 1500,
  defaultEndpoint: LAYA_DEFAULT_ENDPOINT,
  extraKeys: ['checkpoint', 'confidence_threshold', 'compare_in_background', 'observe_momentum'],
  validateExtra: (block): string | undefined => {
    if (!block.checkpoint) {
      return (
        `'checkpoint' is required when enabled:true (pinned HF checkpoint ref, ` +
        `repo:revision — the router never downloads weights, ADR-0025)`
      );
    }
    const t = block.confidence_threshold;
    if (
      t != null &&
      (typeof t !== 'number' ||
        // 0 is valid: "no gate, Laya decides" (owner decision 2026-10-25).
        !(t >= 0 && t <= 1))
    ) {
      warnLog(
        `[router] integrations.laya: invalid confidence_threshold ${JSON.stringify(t)} — falling back to 0.8`
      );
      block.confidence_threshold = 0.8;
    }
    return undefined;
  },
};

/** Registry key of the Laya integration (src/integration.ts); availability lives there. */
const LAYA_INTEGRATION = 'laya';
let _timeoutStrikes = 0;
/** What the sidecar reported on /health at the last successful probe; null = nothing usable. */
let _identity: LayaReportedIdentity | null = null;

/** The request ran into `timeout_ms` (as opposed to failing outright). */
class LayaTimeoutError extends Error {}

/** Conservative chars-per-token ratio for the router's coarse cap (EN ≈ 4, DE ≈ 3.5, code/logs lower). */
const CHARS_PER_TOKEN = 3;
const TRUNCATION_MARKER = '\n[... TRUNCATED ...]\n';

/**
 * Characters available for prompt + context block. Every model input starts
 * with the question head (instructions + the 7 criteria — 161 tokens
 * measured for the v2-r3 head), so the window is not fully ours. The head
 * size is derived
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
  budgetTokens: number = LAYA_CONTEXT_BUDGET_TOKENS
): string {
  const contextChars = buildContextBlock(
    context?.previousUserMessage,
    context?.lastAssistantSnippet
  ).length;
  const allowed = Math.max(0, layaPromptBudgetChars(budgetTokens) - contextChars);
  if (prompt.length <= allowed) return prompt;
  const chunk = Math.floor((allowed - TRUNCATION_MARKER.length) / 2);
  // Degenerate budget (no room for head + marker + tail): a plain prefix is the
  // only honest cut. Also guards slice(-0), which would return the whole string.
  if (chunk < 1) return prompt.slice(0, allowed);
  return prompt.slice(0, chunk) + TRUNCATION_MARKER + prompt.slice(prompt.length - chunk);
}

function markUnavailable(error?: string): void {
  // Keep what was last known good (reported version, last success): a status
  // view of a down sidecar should still say which model it served.
  const prev = getIntegrationHealth(LAYA_INTEGRATION);
  setIntegrationHealth(LAYA_INTEGRATION, {
    state: 'down',
    lastError: error ?? 'stage error',
    ...(prev.version ? { version: prev.version } : {}),
    ...(prev.lastOkAt !== undefined ? { lastOkAt: prev.lastOkAt } : {}),
    until: Date.now() + UNAVAILABLE_TTL_MS,
  });
}

/** Reset availability — for tests only. */
export function resetLayaAvailability(): void {
  resetIntegrationHealth(LAYA_INTEGRATION);
  _timeoutStrikes = 0;
  _identity = null;
}

/** Probe with a real classification task (never a bare ping). TTL-gated per session. */
export async function probeLaya(endpoint: string, timeoutMs: number): Promise<boolean> {
  resetLayaAvailability();
  const probePrompt = 'The quick brown fox jumps over the lazy dog.'; // neutral, obvious category
  // Identity is optional: a sidecar without /health stays fully usable. Read in
  // parallel — the probe runs inline on a user prompt, and a slow /health must
  // not add its latency on top. fetchLayaHealth never rejects.
  const healthP = fetchLayaHealth(endpoint, timeoutMs);
  try {
    const res = await classifyWithLayaRaw(probePrompt, undefined, endpoint, timeoutMs);
    if (!res || typeof res.category !== 'string' || res.category.length === 0) {
      throw new Error('probe returned no valid category');
    }
    const now = Date.now();
    setIntegrationHealth(LAYA_INTEGRATION, {
      state: 'ok',
      lastOkAt: now,
      until: now + UNAVAILABLE_TTL_MS,
    });
    const health = await healthP;
    _identity = health.ok ? withHeadCheck(health.identity) : null;
    const reported = _identity ? labelOf(_identity) : null;
    if (reported) {
      setIntegrationHealth(LAYA_INTEGRATION, {
        ...getIntegrationHealth(LAYA_INTEGRATION),
        version: reported,
      });
    }
    if (_identity?.headMatches === false) {
      const who = labelOf(_identity) ?? endpoint;
      warnLog(
        `[router] integrations.laya: ${who} serves a different head than the router builds ` +
          `(sidecar head_sha256 ${_identity.head_sha256}) — its answers measure prompt drift, ` +
          `not the model; install a matching artifact (pi-laya-model)`
      );
    }
    return true;
  } catch (err) {
    markUnavailable(err instanceof Error ? err.message : textOf(err));
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
  const state = layaAvailabilityState();
  if (state !== 'unknown') return state === 'ok';
  _probeInFlight ??= probeLaya(endpoint, timeoutMs).finally(() => {
    _probeInFlight = null;
  });
  return _probeInFlight;
}

/** True when the wrapper answered healthily and a recent probe succeeded. */
export function isLayaAvailable(): boolean {
  return layaAvailabilityState() === 'ok';
}

/**
 * Three states, because "not probed yet" is neither up nor down: the stage
 * probes lazily on first use, and an expired state is re-probed on the next
 * request. Status output must not report `unknown` as a failure.
 */
export type LayaAvailabilityState = 'ok' | 'down' | 'unknown';

export function layaAvailabilityState(): LayaAvailabilityState {
  return getIntegrationHealth(LAYA_INTEGRATION).state;
}

/** Why the sidecar is considered down; null unless the state is `down`. */
export function getLastProbeError(): string | null {
  const h = getIntegrationHealth(LAYA_INTEGRATION);
  return h.state === 'down' ? (h.lastError ?? null) : null;
}

/** Low-level HTTP call to the wrapper (`endpoint` is the base URL; `/classify` is appended). */
export async function classifyWithLayaRaw(
  prompt: string,
  context: ClassificationContext | undefined,
  endpoint: string,
  timeoutMs: number
): Promise<{
  category: string;
  confidence: number;
  probabilities: Record<string, number>;
  ms: number;
}> {
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
    // The timeout must cover the BODY read too, not just the headers: a
    // sidecar that stalls mid-body would otherwise hang with no limit
    // (merge review 2026-11-01). clearTimeout moved to the finally below.
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    }
    const raw = (await res.json()) as {
      category?: unknown;
      confidence?: unknown;
      probabilities?: unknown;
    };
    if (!raw || typeof raw.category !== 'string' || typeof raw.confidence !== 'number') {
      throw new Error('malformed response: expected {category, confidence, probabilities, ms}');
    }
    const probabilities = raw.probabilities;
    if (
      typeof probabilities !== 'object' ||
      Array.isArray(probabilities) ||
      probabilities === null
    ) {
      throw new Error('malformed response: probabilities must be an object');
    }
    const probabilitiesRecord = probabilities as Record<string, number>;
    return {
      category: raw.category,
      confidence: raw.confidence,
      probabilities: probabilitiesRecord,
      ms: Math.round(performance.now() - t0),
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new LayaTimeoutError(`classify request timed out after ${timeoutMs}ms`, {
        cause: err,
      });
    }
    throw err;
  } finally {
    clearTimeout(id);
  }
}

/** The identity fields a sidecar may report on GET /health; each only when it is trustworthy. */
export interface LayaIdentity {
  model?: string;
  version?: string;
  backend?: string;
  /** Fingerprint of the loaded artifact set (`artifactSha256` in laya-model-manifest.ts). */
  artifact_sha256?: string;
  /** `headSha256` of the head the sidecar serves. */
  head_sha256?: string;
}

/** A reported identity plus the router's verdict on its head (absent when no head was reported). */
export interface LayaReportedIdentity extends LayaIdentity {
  headMatches?: boolean;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const BACKEND_NAME = /^[a-z0-9_-]{1,32}$/;

/**
 * GET <endpoint>/health. Never throws: a sidecar without the route (404),
 * a refused connection, a timeout or a malformed body all yield
 * `{ ok: false, why }`. Fields that fail validation are dropped one by one,
 * because the label is built from them and lands in logs and status.
 */
export async function fetchLayaHealth(
  endpoint: string,
  timeoutMs: number
): Promise<{ ok: true; identity: LayaIdentity } | { ok: false; why: string }> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, '')}/health`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, why: `HTTP ${res.status}` };
    }
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      return { ok: false, why: 'malformed response: not JSON' };
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, why: 'malformed response: not an object' };
    }
    const r = raw as Record<string, unknown>;
    if (r.status !== 'ok') return { ok: false, why: `status ${JSON.stringify(r.status)}` };
    const identity: LayaIdentity = {};
    if (isSafeName(r.model)) identity.model = r.model;
    if (isSafeName(r.version)) identity.version = r.version;
    if (typeof r.backend === 'string' && BACKEND_NAME.test(r.backend)) identity.backend = r.backend;
    if (typeof r.artifact_sha256 === 'string' && SHA256_HEX.test(r.artifact_sha256)) {
      identity.artifact_sha256 = r.artifact_sha256;
    }
    if (typeof r.head_sha256 === 'string' && SHA256_HEX.test(r.head_sha256)) {
      identity.head_sha256 = r.head_sha256;
    }
    return { ok: true, identity };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'AbortError';
    return { ok: false, why: timedOut ? `timed out after ${timeoutMs}ms` : textOf(err) };
  } finally {
    clearTimeout(id);
  }
}

/** The head the router builds, hashed like the artifact manifest does. */
function routerHeadSha256(): string {
  const q = buildClassifierLayaQuestion();
  return headSha256({ instructions: q.instructions, categories: q.criteria });
}

function withHeadCheck(identity: LayaIdentity): LayaReportedIdentity {
  return identity.head_sha256 === undefined
    ? identity
    : { ...identity, headMatches: identity.head_sha256 === routerHeadSha256() };
}

/** `<model>@<version>` when both were reported, else null. */
function labelOf(identity: LayaIdentity | null): string | null {
  return identity?.model && identity.version ? `${identity.model}@${identity.version}` : null;
}

/** The identity from the last successful probe, for /router status; null = none reported. */
export function layaReportedIdentity(): LayaReportedIdentity | null {
  return _identity ? { ..._identity } : null;
}

/**
 * The chain source / decision-log label for the stage: what the sidecar
 * reported (`identity: 'reported'`), else the configured checkpoint
 * (`identity: 'configured'`) — the record says which, so a configured label
 * is never mistaken for a verified one.
 */
export function layaRef(checkpoint: string): { ref: string; identity: 'reported' | 'configured' } {
  const label = labelOf(_identity);
  return label
    ? { ref: `laya:${label}`, identity: 'reported' }
    : { ref: `laya:${checkpoint}`, identity: 'configured' };
}

/**
 * The sidecar's class distribution, or undefined when it is not a usable
 * distribution: it must cover exactly the production taxonomy, with finite
 * probabilities in [0, 1]. Calibration fits on the decision log read these
 * values as samples, so a malformed distribution is dropped, never logged.
 */
export function validLayaDistribution(p: unknown): Record<string, number> | undefined {
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return undefined;
  const entries = Object.entries(p as Record<string, unknown>);
  if (entries.length !== VALID_CATEGORIES.length) return undefined;
  for (const [label, prob] of entries) {
    if (!VALID_CATEGORIES.includes(label as never)) return undefined;
    if (typeof prob !== 'number' || !Number.isFinite(prob) || prob < 0 || prob > 1)
      return undefined;
  }
  return p as Record<string, number>;
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
 * - anything outside the production taxonomy. The legacy 9-category spike
 *   answered `fallback` = "could not tell" — under the v2 taxonomy that
 *   label is simply invalid, and an invalid answer must not shadow the
 *   better classifier stages behind this one.
 */
function vetAnswer(answer: LayaAnswer, threshold: number): ClassificationResult | null {
  if (!(answer.confidence >= threshold)) return null;
  if (!VALID_CATEGORIES.includes(answer.category as never)) return null;
  const top = Object.entries(answer.probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2);
  const reason = top.map(([c, p]) => `${c} (${(p * 100).toFixed(0)}%)`).join('; ');
  return {
    category: answer.category as ClassificationResult['category'],
    reason,
    confidence: answer.confidence,
  };
}

/**
 * Like {@link classifyWithLaya} but also exposes the raw answer when the stage
 * falls through (low confidence, invalid category) — shadow mode logs exactly that.
 * Null = disabled, sidecar unavailable, or the request failed.
 */
export async function classifyWithLayaDetailed(
  prompt: string,
  context: ClassificationContext | undefined,
  options: { cfg?: Config; checkpoint: string }
): Promise<{ answer: LayaAnswer; result: ClassificationResult | null } | null> {
  const cfg = options.cfg?.integrations?.laya;
  if (!cfg?.enabled) return null;
  if (!(await ensureLayaAvailable(cfg.endpoint!, cfg.timeout_ms!))) return null;

  let answer: LayaAnswer;
  try {
    answer = await classifyWithLayaRaw(prompt, context, cfg.endpoint!, cfg.timeout_ms!);
    _timeoutStrikes = 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : textOf(err);
    if (err instanceof LayaTimeoutError && ++_timeoutStrikes < TIMEOUT_STRIKES_BEFORE_DOWN) {
      // Latency, not an outage: the chain answers THIS prompt, Laya stays on.
      warnLog(
        `[router] integrations.laya: ${message} (${_timeoutStrikes}/${TIMEOUT_STRIKES_BEFORE_DOWN}); the chain decides this prompt`
      );
      return null;
    }
    // Going down needs no reset: the next probe (resetLayaAvailability) clears the count.
    markUnavailable(message);
    warnLog(`[router] integrations.laya: classify failed — ${message}; stage disabled`);
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
  options: { cfg?: Config; checkpoint: string }
): Promise<ClassificationResult | null> {
  return (await classifyWithLayaDetailed(prompt, context, options))?.result ?? null;
}
