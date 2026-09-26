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
  clearBlock,
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

  it('does not block on transient or request-dependent failures', () => {
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
    expect(clearBlock(cache, OR)).toBe(true);
    expect(isBlocked(cache, OR, 1)).toBe(false);
    expect(clearBlock(cache, OR)).toBe(false);
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
