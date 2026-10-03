// test/model-blocklist.test.ts
// ADR-0008 step 1 (Tier 1): known-permanent OpenRouter failure signatures
// block a model on first sight, persist in the cache, expire after 7 days
// and clear on success. Fixture texts are verbatim router.log lines from
// the 2026-09-26 incident.

import { describe, it, expect } from 'vitest';
import { classifyFailure } from '../src/error-signatures.ts';
import {
  BLOCKLIST_TTL_MS,
  recordBlocklistFailure,
  isBlocked,
  recordBlocklistSuccess,
  clearBlocklist,
  activeBlocks,
} from '../src/model-blocklist.ts';
import type { Cache, Config } from '../src/types.ts';
import { Router } from '../src/routing.ts';
import { setConfig, setCache } from '../src/metrics.ts';

const AGENTIC =
  '403: {"message":"thinkingmachines/inkling:free is only available on agentic harnesses. Try plugging it into a coding agent or productivity app listed on https://openrouter.ai/apps","code":403}';
const GUARDRAIL =
  '404: {"message":"0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy. We removed them for the following reasons (an endpoint may have matched multiple reasons):\\nFree model training violation (guardrail): 1 endpoint excluded","code":404,"metadata":{"input_endpoint_count":1,"ineligibility_reasons":[{"reason":"free-model-training-violation-by-guardrail","endpoint_count":1}],"failed_routing_step":"Filter by Guardrails"}}';
const GUARDRAIL_OLD =
  '404: {"message":"No endpoints available matching your guardrail restrictions and data policy. Configure: https://openrouter.ai/settings/privacy","code":404}';
const DECOMMISSIONED = '404: {"message":"No endpoints found for nex-agi/nex-n2.5-pro:free.","code":404}';
const FREE_RETIRED =
  '404: {"message":"This model is unavailable for free. The paid version is available now - use this slug instead: z-ai/glm-5.2","code":404}';
const TOOL_USE =
  '404: {"message":"No endpoints found that support tool use. Try disabling \\"read\\".","code":404,"metadata":{"failed_routing_step":"Filter by Tool Compatibility"}}';
// Verbatim router.log fixture (sourcelume 2026-10-03): OpenRouter wraps the
// upstream error in metadata.raw — the real, deterministic cause (the
// request's tool schema can't be folded into the provider's request grammar)
// lives INSIDE the raw string, the outer message is just "Provider returned
// error".
// Built structurally (three escaping levels: inner error JSON → truncated,
// embedded as a JSON string in metadata.raw, embedded in the outer body) —
// hand-escaping this fixture produced subtly wrong bytes twice.
const innerError = {
  error: {
    code: '400',
    message:
      'failed to translate request: folding the request grammar: tool "subagent" parameter schema: parameter "gate": more than one JSON reading of the same emitted value',
    param: 'tools',
    type: 'invalid_request_error',
  },
};
// The observed upstream raw body is TRUNCATED: the inner error object's
// closing brace is the last one, the raw object's own closing brace is
// missing, a trailing newline follows.
const truncatedRaw = JSON.stringify(innerError).slice(0, -1) + '\n';
const TOOL_SCHEMA_400 = `400: ${JSON.stringify({
  message: 'Provider returned error',
  code: 400,
  metadata: {
    raw: truncatedRaw,
    provider_name: 'ModelRun',
    is_byok: false,
    provider_error_code: '400',
  },
})}`;
const RATE_LIMIT = '429 status code (no body)';

const OR = 'openrouter/thinkingmachines/inkling:free';

describe('classifyFailure — Tier-1 signature catalogue', () => {
  it.each([
    [AGENTIC, 'agentic-harness-gate', 403],
    [GUARDRAIL, 'workspace-guardrail', 404],
    [GUARDRAIL_OLD, 'workspace-guardrail', 404],
    [DECOMMISSIONED, 'decommissioned', 404],
    [FREE_RETIRED, 'free-variant-retired', 404],
  ])('classifies a permanent OpenRouter failure (%#) as %s', (text, reason, code) => {
    expect(classifyFailure(OR, text)).toMatchObject({ verdict: 'permanent', reason, code });
  });

  it('treats "no endpoints that support tool use" as request-dependent, never permanent', () => {
    expect(classifyFailure(OR, TOOL_USE).verdict).toBe('request');
  });

  // Sourcelume 2026-10-03: qwen3.8-27b:free answered this 400 on EVERY
  // tool-carrying request (6×) while tool-less requests to the same model
  // succeeded. Root cause it was never learned: the generic wrapper text
  // "Provider returned error" sits in TRANSIENT_TEXT, so the inner
  // invalid_request_error (param tools, deterministic request-shape problem)
  // was never looked at — classified transient, never counted. It must be
  // request-dependent (like no-tool-support), never transient: the model
  // itself works fine without the incompatible tool schema.
  it('classifies a 400 tool-grammar fold error as request-dependent, not transient', () => {
    expect(classifyFailure(OR, TOOL_SCHEMA_400)).toMatchObject({
      verdict: 'request',
      reason: 'tool-schema-incompatible',
      code: 400,
    });
  });

  it('never counts a request-dependent failure toward the blocklist', () => {
    const cache = { model_failure_streaks: {} } as Cache;
    expect(recordBlocklistFailure(cache, OR, TOOL_SCHEMA_400)).toBeNull();
    expect(cache.model_failure_streaks![OR]).toBeUndefined();
  });

  it('treats rate limits, timeouts and unknown text as not permanent', () => {
    expect(classifyFailure(OR, RATE_LIMIT).verdict).not.toBe('permanent');
    expect(classifyFailure(OR, 'no response within timeout').verdict).not.toBe('permanent');
    expect(classifyFailure(OR, '').verdict).not.toBe('permanent');
  });

  it('only applies OpenRouter signatures to OpenRouter refs', () => {
    expect(classifyFailure('ollama/qwen3:8b', '404: {"error":"model \\"qwen3:8b\\" not found, try pulling it first"}').verdict)
      .not.toBe('permanent');
    expect(classifyFailure('mistral/some-model', DECOMMISSIONED).verdict).not.toBe('permanent');
  });

  it('recognizes the signature inside the orchestrator/probe wording around the body', () => {
    expect(classifyFailure(OR, `trivial-read: ${AGENTIC}`).verdict).toBe('permanent');
  });
});

describe('model blocklist state (cache.model_blocklist)', () => {
  it('blocks on the first permanent failure and records reason, code and timestamps', () => {
    const cache: Cache = {};
    const entry = recordBlocklistFailure(cache, OR, AGENTIC, 1_000);
    expect(entry).toMatchObject({ reason: 'agentic-harness-gate', code: 403, first_seen: 1_000, last_seen: 1_000, occurrences: 1 });
    expect(isBlocked(cache, OR, 1_001)).toBe(true);
    expect(cache.model_blocklist?.[OR]).toBeDefined();
  });

  it('does not block on known-transient or request-dependent failures', () => {
    const cache: Cache = {};
    expect(recordBlocklistFailure(cache, OR, RATE_LIMIT, 1_000)).toBeNull();
    expect(recordBlocklistFailure(cache, OR, TOOL_USE, 1_000)).toBeNull();
    expect(isBlocked(cache, OR, 1_001)).toBe(false);
  });

  it('expires after the 7-day TTL so the model is re-probed', () => {
    const cache: Cache = {};
    recordBlocklistFailure(cache, OR, GUARDRAIL, 0);
    expect(isBlocked(cache, OR, BLOCKLIST_TTL_MS - 1)).toBe(true);
    expect(isBlocked(cache, OR, BLOCKLIST_TTL_MS)).toBe(false);
  });

  it('a re-confirmation after re-probe re-blocks, counts the occurrence and resets the TTL', () => {
    const cache: Cache = {};
    recordBlocklistFailure(cache, OR, GUARDRAIL, 0);
    const again = recordBlocklistFailure(cache, OR, GUARDRAIL, BLOCKLIST_TTL_MS + 5);
    expect(again).toMatchObject({ first_seen: 0, last_seen: BLOCKLIST_TTL_MS + 5, occurrences: 2 });
    expect(isBlocked(cache, OR, BLOCKLIST_TTL_MS + 6)).toBe(true);
  });

  it('a success clears the block', () => {
    const cache: Cache = {};
    recordBlocklistFailure(cache, OR, AGENTIC, 0);
    expect(recordBlocklistSuccess(cache, OR)).toBe(true);
    expect(isBlocked(cache, OR, 1)).toBe(false);
    expect(recordBlocklistSuccess(cache, OR)).toBe(false);
  });

  it('activeBlocks lists unexpired entries with time to the next re-probe', () => {
    const cache: Cache = {};
    recordBlocklistFailure(cache, OR, AGENTIC, 0);
    recordBlocklistFailure(cache, 'openrouter/liquid/lfm-2.5-2.6b:free', GUARDRAIL, -BLOCKLIST_TTL_MS);
    const active = activeBlocks(cache, 100);
    expect(active.map((b) => b.ref)).toEqual([OR]);
    expect(active[0].reprobeInMs).toBe(BLOCKLIST_TTL_MS - 100);
  });
});

describe('runtime filter: Router.allDiscoveredRefs drops blocked models', () => {
  it('excludes a blocked ref and re-admits it once the block has expired', () => {
    const cfg: Config = { model_groups: {}, model_metrics: {} };
    const cache: Cache = {
      available_models: [
        { id: 'thinkingmachines/inkling:free', provider: 'openrouter', cost_per_m: 0 },
        { id: 'healthy', provider: 'mistral', cost_per_m: 0 },
      ],
    };
    setConfig(cfg);
    setCache(cache);
    const router = new Router(cfg, cache, new Map());

    recordBlocklistFailure(cache, OR, AGENTIC);
    expect(router.allDiscoveredRefs()).not.toContain(OR);
    expect(router.allDiscoveredRefs()).toContain('mistral/healthy');

    cache.model_blocklist![OR].last_seen = Date.now() - BLOCKLIST_TTL_MS - 1;
    expect(router.allDiscoveredRefs()).toContain(OR);
  });
});

// ── Tier 2 (ADR-0008): unknown signatures ──────────────────────────────────

const UNKNOWN_400 = '400: {"message":"Invalid request: unsupported parameter \'reasoning_effort\'","code":400}';
const UNKNOWN_400_OTHER = '400: {"message":"Invalid request: context must start with a user turn","code":400}';
const HOUR = 60 * 60_000;
const T2 = 'openrouter/vendor/flaky-model';

function failTimes(cache: Cache, ref: string, text: string, times: number, start: number, stepMs: number) {
  let last: ReturnType<typeof recordBlocklistFailure> = null;
  for (let i = 0; i < times; i++) last = recordBlocklistFailure(cache, ref, text, start + i * stepMs);
  return last;
}

describe('classifyFailure — unknown vs known-transient', () => {
  it('marks an unmatched 4xx as unknown with a stable, id-free signature', () => {
    const a = classifyFailure(T2, UNKNOWN_400);
    const b = classifyFailure(T2, UNKNOWN_400.replace("'reasoning_effort'", "'reasoning_effort'  "));
    expect(a.verdict).toBe('unknown');
    expect(a.signature).toBe(b.signature);
    expect(classifyFailure(T2, UNKNOWN_400_OTHER).signature).not.toBe(a.signature);
  });

  it.each([
    ['429 status code (no body)'],
    ['503: {"message":"Service Unavailable","code":503}'],
    ['fetch failed: ECONNRESET'],
    ['no response within timeout'],
    ['This operation was aborted'],
    [''],
  ])('treats %j as known-transient', (text) => {
    expect(classifyFailure(T2, text).verdict).toBe('transient');
  });

  // Real router.log texts (2026-09-26) that must never feed Tier 2.
  it.each([
    ['mistral-zai/codestral-2508', '422 status code (no body)'], // Mistral daily quota
    ['mistral/labs-leanstral-1-5', '403 status code (no body)'], // Mistral daily quota
    ['mistral-zai/zai-glm-5-2', 'Connection error.'],
    ['openrouter/minimax/minimax-m3:free', '400: {"message":"Provider returned error","code":400}'],
    ['err-provider/m', 'Provider finish_reason: error'],
    ['mistral/mistral-small-2603', 'Provider stopped with: error'],
    ['mistral/zai-glm-5-3', 'Mistral stream ended without a finish reason'],
    ['openrouter/stealth/space-bunny-alpha', 'JSON error injected into SSE stream'],
  ])('treats %s "%s" as known-transient', (ref, text) => {
    expect(classifyFailure(ref, text).verdict).toBe('transient');
  });

  it('treats "does not support tools" from any provider as request-dependent', () => {
    expect(classifyFailure('openrouter/x/y', '400: {"message":"x does not support tools"}').verdict).toBe('request');
  });

  it('leaves a Mistral "Invalid model" 400 as unknown (Tier-2 candidate)', () => {
    const c = classifyFailure(
      'mistral/mistral-large-2411',
      'Mistral API error (400): {"object":"error","message":"Invalid model: mistral-large-2411","type":"invalid_model"}'
    );
    expect(c.verdict).toBe('unknown');
    expect(c.code).toBe(400);
  });
});

describe('Tier 2 promotion', () => {
  it('blocks after 5 same-signature failures spanning at least one hour', () => {
    const cache: Cache = {};
    expect(failTimes(cache, T2, UNKNOWN_400, 4, 0, HOUR / 4)).toBeNull();
    const entry = recordBlocklistFailure(cache, T2, UNKNOWN_400, HOUR);
    expect(entry).toMatchObject({ reason: 'unknown-signature', code: 400, occurrences: 1 });
    expect(isBlocked(cache, T2, HOUR + 1)).toBe(true);
    expect(cache.model_failure_streaks?.[T2]).toBeUndefined();
  });

  it('does not block a burst of 5 failures inside one hour', () => {
    const cache: Cache = {};
    expect(failTimes(cache, T2, UNKNOWN_400, 5, 0, 60_000)).toBeNull();
    expect(isBlocked(cache, T2, 5 * 60_000)).toBe(false);
    // ...but the streak keeps counting, so the next failure past the hour blocks.
    expect(recordBlocklistFailure(cache, T2, UNKNOWN_400, HOUR)).not.toBeNull();
  });

  it('a success resets the streak', () => {
    const cache: Cache = {};
    failTimes(cache, T2, UNKNOWN_400, 4, 0, HOUR / 4);
    recordBlocklistSuccess(cache, T2);
    expect(recordBlocklistFailure(cache, T2, UNKNOWN_400, 2 * HOUR)).toBeNull();
    expect(cache.model_failure_streaks?.[T2]?.count).toBe(1);
  });

  it('a different unknown signature restarts the streak', () => {
    const cache: Cache = {};
    failTimes(cache, T2, UNKNOWN_400, 4, 0, HOUR / 4);
    expect(recordBlocklistFailure(cache, T2, UNKNOWN_400_OTHER, HOUR)).toBeNull();
    expect(cache.model_failure_streaks?.[T2]?.count).toBe(1);
  });

  it('known-transient failures in between neither count nor reset', () => {
    const cache: Cache = {};
    failTimes(cache, T2, UNKNOWN_400, 4, 0, HOUR / 4);
    recordBlocklistFailure(cache, T2, '429 status code (no body)', HOUR - 1);
    expect(cache.model_failure_streaks?.[T2]?.count).toBe(4);
    expect(recordBlocklistFailure(cache, T2, UNKNOWN_400, HOUR)).not.toBeNull();
  });

  it('never promotes local providers (daemon trouble, not a model property)', () => {
    const cache: Cache = {};
    const local = 'ollama/qwen3:8b';
    failTimes(cache, local, '404: {"error":"model \\"qwen3:8b\\" not found, try pulling it first"}', 10, 0, HOUR / 2);
    expect(isBlocked(cache, local, 6 * HOUR)).toBe(false);
  });

  it('restarts a streak whose last failure is older than the TTL', () => {
    const cache: Cache = {};
    failTimes(cache, T2, UNKNOWN_400, 4, 0, HOUR / 4);
    expect(recordBlocklistFailure(cache, T2, UNKNOWN_400, BLOCKLIST_TTL_MS + HOUR)).toBeNull();
    expect(cache.model_failure_streaks?.[T2]?.count).toBe(1);
  });

  it('an expired Tier-2 block re-blocks on the first failure with the same signature', () => {
    const cache: Cache = {};
    failTimes(cache, T2, UNKNOWN_400, 5, 0, HOUR / 4);
    const later = BLOCKLIST_TTL_MS + 2 * HOUR;
    expect(isBlocked(cache, T2, later)).toBe(false);
    expect(recordBlocklistFailure(cache, T2, UNKNOWN_400, later)).toMatchObject({ occurrences: 2 });
    expect(isBlocked(cache, T2, later + 1)).toBe(true);
  });
});

// ── Review 2026-09-27: account-wide failures and manual unblock ────────────

describe('account-wide failures never block a model', () => {
  it.each([
    ['401: {"message":"User not found.","code":401}'],
    ['401 status code (no body)'],
    ['Invalid API key provided'],
    ['403: {"message":"Unauthorized: authentication failed","code":403}'],
  ])('%s is not a Tier-2 candidate', (text) => {
    expect(classifyFailure(T2, text).verdict).toBe('transient');
    const cache: Cache = {};
    for (let i = 0; i < 6; i++) recordBlocklistFailure(cache, T2, text, i * HOUR);
    expect(isBlocked(cache, T2, 6 * HOUR)).toBe(false);
  });
});

describe('clearBlocklist (/router blocklist clear)', () => {
  it('clears one ref or everything, including Tier-2 streaks', () => {
    const cache: Cache = {};
    recordBlocklistFailure(cache, OR, AGENTIC, 0);
    recordBlocklistFailure(cache, 'openrouter/b:free', GUARDRAIL, 0);
    recordBlocklistFailure(cache, T2, UNKNOWN_400, 0);
    expect(clearBlocklist(cache, OR)).toBe(1);
    expect(isBlocked(cache, OR, 1)).toBe(false);
    expect(isBlocked(cache, 'openrouter/b:free', 1)).toBe(true);
    expect(clearBlocklist(cache)).toBe(1);
    expect(cache.model_blocklist).toEqual({});
    expect(cache.model_failure_streaks).toEqual({});
  });
});
