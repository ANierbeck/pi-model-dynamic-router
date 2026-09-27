// src/error-signatures.ts
// Provider failure classification for the learned blocklist (ADR-0008).
//
// Verdicts:
//   permanent — a known signature that is a property of the model/account;
//               retrying can never fix it (Tier 1 blocks on first sight).
//   request   — depends on the request (e.g. tool use), never blocks.
//   transient — known to heal: rate limits, 429/5xx, timeouts, network
//               errors, aborts, overflows, empty text, account-wide auth
//               failures (401, invalid key). Never counts.
//   unknown   — anything else. Tier 2 may promote a repeated unknown
//               signature (see model-blocklist.ts).
// Tier-1 signatures are scoped per provider: the same HTTP status means
// something different elsewhere (Ollama's 404 "model not found" is fixed by
// `ollama pull`).

import { isRateLimitText, isOverflowErrorText, isAbortLikeText } from './detection.ts';

export type FailureVerdict = 'permanent' | 'request' | 'transient' | 'unknown';

export interface FailureClassification {
  verdict: FailureVerdict;
  /** Stable reason key for permanent/request verdicts. */
  reason?: string;
  /** HTTP status parsed from the failure text, when present. */
  code?: number;
  /** Normalised key: `<code>:<reason>`, `transient`, or `<code|x>:<message>` for unknown. */
  signature: string;
}

interface Signature {
  code: number;
  reason: string;
  verdict: Exclude<FailureVerdict, 'unknown'>;
  matches(message: string, routingStep: string | undefined, ineligibility: string[]): boolean;
}

// Order matters: the request-dependent tool-use 404 shares the "No endpoints
// found" prefix with the decommissioned signature and must win.
const OPENROUTER_SIGNATURES: readonly Signature[] = [
  {
    code: 404,
    reason: 'no-tool-support',
    verdict: 'request',
    matches: (m, step) => /support tool use/i.test(m) || step === 'Filter by Tool Compatibility',
  },
  {
    code: 403,
    reason: 'agentic-harness-gate',
    verdict: 'permanent',
    matches: (m, step) => /only available on agentic harnesses/i.test(m) || step === 'Gate Free Endpoints by Agentic Harness',
  },
  {
    code: 404,
    reason: 'workspace-guardrail',
    verdict: 'permanent',
    matches: (m, _step, inel) =>
      inel.some((r) => r.includes('guardrail')) || /matching your guardrail restrictions/i.test(m),
  },
  {
    code: 404,
    reason: 'free-variant-retired',
    verdict: 'permanent',
    matches: (m) => /unavailable for free\. The paid version is available/i.test(m),
  },
  {
    code: 404,
    reason: 'decommissioned',
    verdict: 'permanent',
    matches: (m) => /No endpoints found for /i.test(m),
  },
];

// Mistral historically answers account-level/request trouble with a bare
// 422 or 403 "status code (no body)" — observed 2026-09-26/27 for every
// router-scanned mistral/mistral-zai model streamed through the
// OpenAI-compatible transport. Keep the known-transient verdict so the
// learned blocklist treats these as a soft account-level condition instead
// of 'unknown'. The hard-cooldown decision is NOT made here — detection.ts's
// isPaidCloudRateLimitFailure gates that on the error text (HTTP 429/402 or
// rate-limit wording), so these signatures can never trigger a 24h
// cooldown on their own.
const MISTRAL_SIGNATURES: readonly Signature[] = [
  { code: 422, reason: 'quota-no-body', verdict: 'transient', matches: (m) => /status code \(no body\)/i.test(m) },
  { code: 403, reason: 'quota-no-body', verdict: 'transient', matches: (m) => /status code \(no body\)/i.test(m) },
];

const SIGNATURES_BY_PROVIDER: Record<string, readonly Signature[]> = {
  openrouter: OPENROUTER_SIGNATURES,
  mistral: MISTRAL_SIGNATURES,
  'mistral-zai': MISTRAL_SIGNATURES,
};

// Account-wide failures (bad/expired key, auth): they hit every model of the
// provider and heal when the user fixes the key, so they must never block
// individual models — a per-model block would outlive the fix (review
// 2026-09-27).
const ACCOUNT_TEXT = /invalid api key|incorrect api key|unauthori[sz]ed|authentication|user not found|no auth credentials|api key (?:is )?(?:missing|expired|revoked)/i;

// Request-dependent wording from any provider: the model works without tools.
const REQUEST_TEXT = /does not support tools|support tool use/i;

function parseBody(text: string): { message: string; routingStep?: string; ineligibility: string[] } {
  const start = text.indexOf('{');
  if (start >= 0) {
    try {
      const body = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1));
      const meta = body?.metadata ?? body?.error?.metadata ?? {};
      return {
        message: String(body?.message ?? body?.error?.message ?? text),
        routingStep: typeof meta.failed_routing_step === 'string' ? meta.failed_routing_step : undefined,
        ineligibility: Array.isArray(meta.ineligibility_reasons)
          ? meta.ineligibility_reasons.map((r: { reason?: unknown }) => String(r?.reason ?? ''))
          : [],
      };
    } catch {
      // Truncated or non-JSON body: fall back to substring matching below.
    }
  }
  return { message: text, ineligibility: [] };
}

// Known-transient wording. Includes generic upstream and stream-level
// failures (OpenRouter's "Provider returned error", finish_reason/stop errors,
// injected SSE errors): they cannot be told apart from flakiness, and the
// ADR's asymmetry says not to block without confidence.
const TRANSIENT_TEXT = new RegExp(
  [
    'timeout', 'timed out', 'econnreset', 'econnrefused', 'etimedout', 'enotfound', 'eai_again',
    'fetch failed', 'socket hang up', 'network', 'connection error', 'overloaded',
    'temporarily unavailable', 'service unavailable', 'provider returned error',
    'finish_reason: error', 'stopped with: error', 'ended without a finish reason',
    'error injected into sse stream',
  ].map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'i'
);

/** Lowercases and strips ids, numbers and quotes so repeats of one error share a key. */
function normalizeMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[0-9a-f]{8,}/g, '')
    .replace(/\d+/g, '#')
    .replace(/["'`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** Classifies a failure observed for `ref` (provider/model) from its error text. */
export function classifyFailure(ref: string, text: string): FailureClassification {
  if (!text.trim()) return { verdict: 'transient', signature: 'transient' };
  const provider = ref.split('/')[0];
  const codeMatch = /\b([45]\d\d)\b/.exec(text);
  const code = codeMatch ? Number(codeMatch[1]) : undefined;
  const { message, routingStep, ineligibility } = parseBody(text);

  const signatures = SIGNATURES_BY_PROVIDER[provider];
  if (signatures && code !== undefined) {
    for (const sig of signatures) {
      if (sig.code === code && sig.matches(message, routingStep, ineligibility)) {
        return { verdict: sig.verdict, reason: sig.reason, code, signature: `${code}:${sig.reason}` };
      }
    }
  }

  if (code === 401 || ACCOUNT_TEXT.test(text)) {
    return { verdict: 'transient', reason: 'account-auth', ...(code !== undefined ? { code } : {}), signature: 'transient' };
  }
  if (REQUEST_TEXT.test(text)) {
    return { verdict: 'request', reason: 'no-tool-support', ...(code !== undefined ? { code } : {}), signature: 'request:no-tool-support' };
  }
  if (
    code === 429 ||
    (code !== undefined && code >= 500) ||
    isRateLimitText(text) ||
    isOverflowErrorText(text) ||
    isAbortLikeText(text) ||
    TRANSIENT_TEXT.test(text)
  ) {
    return { verdict: 'transient', ...(code !== undefined ? { code } : {}), signature: 'transient' };
  }
  return {
    verdict: 'unknown',
    ...(code !== undefined ? { code } : {}),
    signature: `${code ?? 'x'}:${normalizeMessage(message)}`,
  };
}
