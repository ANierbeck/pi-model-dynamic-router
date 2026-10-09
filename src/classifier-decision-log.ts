// Classifier decision log (docs/plans/2026-10-08-classifier-decision-log.md).
//
// WHY: router.log proves that the classifier *chain* is healthy (latency,
// fallbacks), but nothing records *what* was decided from *what input* —
// accuracy is invisible, and a second classifier (Laya) could not be
// compared against the known one fairly (shadow comparison needs identical
// inputs and the known chain's per-candidate outcomes). This module adds
// exactly that record, one JSONL line per classifyPrompt call, fail-open.
//
// PRIVACY: the file lives in the user's home and receives prompts, so it is
// created with mode 0600 and `store_text` gates every prompt-derived string:
// "none" (default) stores only lengths and a sha prefix — enough to join
// records and spot duplicates, nothing reconstructable; "full" is the
// replay mode the owner enables locally.

import { createHash } from 'node:crypto';
import { appendRotating, procTag } from './logger.ts';
import type { ClassifierLogConfig } from './types.ts';

export const DECISION_LOG_VERSION = 1;

/** One candidate attempt inside an LLM chain. */
export interface DecisionAttempt {
  /** Provider/model ref, or `ollama/<id>` on the local path. */
  ref: string;
  /** ok | failed | skipped */
  outcome: 'ok' | 'failed' | 'skipped';
  /** Machine-classified failure reason; never the raw body (may echo secrets). */
  why?: 'timeout' | 'http-429' | 'http-4xx' | 'http-5xx' | 'empty-reply' | 'unparseable' | 'invalid-category' | 'no-credentials' | 'not-in-registry';
  /** Wall time of the attempt in ms. */
  ms?: number;
}

/** Coarse failure classification for an error string/body (no raw text stored). */
export function classifyError(raw: string): DecisionAttempt['why'] {
  const s = raw.toLowerCase();
  if (/abort|timeout|timed out|etimedout|deadline/.test(s)) return 'timeout';
  if (/\b429\b|rate limit|quota/.test(s)) return 'http-429';
  if (/\b40[0-9]\b|\b41[0-9]\b|\b42[0-9]\b/.test(s)) return 'http-4xx';
  if (/\b5[0-9][0-9]\b|internal server|upstream/.test(s)) return 'http-5xx';
  return 'unparseable';
}

/** Input facts about the prompt (no text at `store_text: "none"`). */
export interface DecisionInput {
  chars: number;
  words: number;
  /** First 12 hex chars of sha256(prompt) — dedupe/join key, not reversible. */
  sha: string;
  text: null | { prompt: string; previousUserMessage?: string; lastAssistantSnippet?: string };
  context: {
    hasContextBlock: boolean;
    lastCategory?: string | null;
    isCompaction?: boolean;
    hasHistory: boolean;
  };
}

export interface DecisionRecord {
  v: number;
  ts: string;
  proc: string;
  /** hint | compaction | momentum | cache | llm-local | llm-cloud | static | fallback */
  stage: string;
  /** Model ref that produced the final classification (null for static/fallback). */
  answered_by: string | null;
  /** Chain of candidate attempts, in order, including skips (LLM stages only). */
  chain: DecisionAttempt[];
  /** Where a cache entry came from (`cloud:<ref>` etc.) — cache hits only. */
  cache_origin: string | null;
  /** The classification as the model returned it, before post-processing. */
  raw: null | { category: string | null; confidence: number | null; reason: null | string };
  /** The classification actually applied, with the routed group. */
  final: {
    category: string | null;
    group: string | null;
    hint: null | { type: string; target: string };
    reason: null | string;
  };
  /** Post-processing applied between raw and final. */
  steps: string[];
  /** Total classifyPrompt time in ms. */
  ms: number;
  input: DecisionInput;
}

/** Mutable per-call trace threaded through the classifier via AsyncLocalStorage. */
export interface ClassificationTrace {
  chain: DecisionAttempt[];
  raw: DecisionRecord['raw'];
  steps: string[];
  cacheOrigin: string | null;
  /** Ref of the model that answered (updated by noteSource). */
  answeredBy: string | null;
}

export function newTrace(): ClassificationTrace {
  return { chain: [], raw: null, steps: [], cacheOrigin: null, answeredBy: null };
}

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);

export function decisionLogPath(home: string): string {
  return `${home}/.pi/logs/classifier-decisions.jsonl`;
}

/** Normalized logging config; null = off (absent/disabled/`options.cfg` undefined). */
export function resolveClassifierLogConfig(
  cfgBlock: ClassifierLogConfig | undefined,
): { store: 'none' | 'snippet' | 'full'; maxBytes: number; keep: number } | null {
  if (!cfgBlock?.enabled) return null;
  const store = cfgBlock.store_text === 'snippet' || cfgBlock.store_text === 'full' ? cfgBlock.store_text : 'none';
  return {
    store,
    maxBytes: cfgBlock.max_bytes && cfgBlock.max_bytes > 0 ? cfgBlock.max_bytes : 20 * 1024 * 1024,
    keep: cfgBlock.keep && cfgBlock.keep > 0 ? cfgBlock.keep : 3,
  };
}

function storeInput(
  log: { store: 'none' | 'snippet' | 'full' },
  prompt: string,
  context: { previousUserMessage?: string | undefined; lastAssistantSnippet?: string | undefined } | undefined,
): DecisionInput['text'] {
  if (log.store === 'full') {
    return {
      prompt,
      ...(context?.previousUserMessage ? { previousUserMessage: context.previousUserMessage } : {}),
      ...(context?.lastAssistantSnippet ? { lastAssistantSnippet: context.lastAssistantSnippet } : {}),
    };
  }
  if (log.store === 'snippet') return { prompt: prompt.slice(0, 120) };
  return null;
}

export interface RecordParams {
  prompt: string;
  stage: string;
  trace: ClassificationTrace;
  final: {
    category: string | null;
    group: string | null;
    hint: null | { type: string; target: string };
    reason: string | null;
    confidence?: number | null;
  };
  // Structural subset of the classifier's ClassificationContext (imported
  // structurally, not by name — content-classifier imports this module).
  context: {
    previousUserMessage?: string | undefined;
    lastAssistantSnippet?: string | undefined;
    lastCategory?: string | undefined;
    isCompaction?: boolean | undefined;
  } | undefined;
  ms: number;
  cfgBlock: ClassifierLogConfig | undefined;
  home: string;
}

export function buildDecisionRecord(p: RecordParams): DecisionRecord {
  const log = resolveClassifierLogConfig(p.cfgBlock)!;
  const reasonsAllowed = log.store !== 'none';
  return {
    v: DECISION_LOG_VERSION,
    ts: new Date().toISOString(),
    proc: procTag(),
    stage: p.stage,
    answered_by: p.trace.answeredBy,
    chain: p.trace.chain,
    cache_origin: p.trace.cacheOrigin,
    raw: p.trace.raw && {
      category: p.trace.raw.category ?? null,
      confidence: p.trace.raw.confidence ?? null,
      reason: reasonsAllowed ? p.trace.raw.reason : null,
    },
    final: {
      category: p.final.category,
      group: p.final.group,
      hint: p.final.hint,
      reason: reasonsAllowed ? p.final.reason : null,
    },
    steps: p.trace.steps,
    ms: p.ms,
    input: {
      chars: p.prompt.length,
      words: p.prompt.trim() ? p.prompt.trim().split(/\s+/).length : 0,
      sha: sha(p.prompt),
      text: storeInput(log, p.prompt, p.context),
      context: {
        // buildContextBlock returns a block only when at least one of the
        // two history texts exists — same condition here.
        hasContextBlock: !!(p.context?.previousUserMessage || p.context?.lastAssistantSnippet),
        lastCategory: p.context?.lastCategory ?? null,
        isCompaction: !!p.context?.isCompaction,
        hasHistory: !!(p.context?.previousUserMessage || p.context?.lastAssistantSnippet),
      },
    },
  };
}

/** Append one record, never throwing (fail-open: logging must not break routing). */
export function writeDecisionRecord(rec: DecisionRecord, home: string, log: { maxBytes: number; keep: number }): void {
  try {
    appendRotating(decisionLogPath(home), JSON.stringify(rec), log, 0o600);
  } catch {
    // Unwritable location, full disk, another process rotating: swallow.
    // The classification is worth more than its log line.
  }
}
