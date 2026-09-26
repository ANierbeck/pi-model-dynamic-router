// src/error-signatures.ts
// Tier-1 catalogue of provider failure signatures (ADR-0008).
//
// A failure is `permanent` only when its signature is a property of the
// model/account that retrying can never fix. Everything else is `transient`
// (rate limits, timeouts, unknown text) or `request` (depends on the request,
// e.g. tool use) and must never block a model. Signatures are scoped per
// provider: the same HTTP status means something different elsewhere
// (Ollama's 404 "model not found" is fixed by `ollama pull`).

export type FailureVerdict = 'permanent' | 'request' | 'transient';

export interface FailureClassification {
  verdict: FailureVerdict;
  /** Stable reason key for permanent/request verdicts. */
  reason?: string;
  /** HTTP status parsed from the failure text, when present. */
  code?: number;
  /** Normalised key: `<code>:<reason>` or `transient`. */
  signature: string;
}

interface Signature {
  code: number;
  reason: string;
  verdict: Exclude<FailureVerdict, 'transient'>;
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

const SIGNATURES_BY_PROVIDER: Record<string, readonly Signature[]> = {
  openrouter: OPENROUTER_SIGNATURES,
};

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

/** Classifies a failure observed for `ref` (provider/model) from its error text. */
export function classifyFailure(ref: string, text: string): FailureClassification {
  const provider = ref.split('/')[0];
  const signatures = SIGNATURES_BY_PROVIDER[provider];
  const codeMatch = /\b([45]\d\d)\b/.exec(text);
  const code = codeMatch ? Number(codeMatch[1]) : undefined;
  if (!signatures || code === undefined) return { verdict: 'transient', signature: 'transient' };

  const { message, routingStep, ineligibility } = parseBody(text);
  for (const sig of signatures) {
    if (sig.code === code && sig.matches(message, routingStep, ineligibility)) {
      return { verdict: sig.verdict, reason: sig.reason, code, signature: `${code}:${sig.reason}` };
    }
  }
  return { verdict: 'transient', code, signature: 'transient' };
}
