/**
 * ADR-0025 Phase B3 / ADR-0008: permanent OpenRouter gate failures are LEARNED,
 * not shipped.
 *
 * The shipped exclude.models list (14 concrete free-tier refs) existed because
 * of two permanent structural failures observed live on 2026-09-26:
 *   403 "only available on agentic harnesses"  (harness gate)
 *   404 guardrail / free-model-training-violation (workspace data policy)
 * Neither heals by retrying (two models alone burned ~750 candidate attempts
 * in one evening). The learned blocklist (src/model-blocklist.ts +
 * src/error-signatures.ts) classifies both as permanent and blocks on the
 * FIRST observation, so the list is redundant — this file carries the intent
 * of the retired test/config-excludes-guardrail-blocked.test.ts using failure
 * PATTERNS only (fixture model ids are fake). The exclude MACHINERY stays: the
 * user layer can still declare exclude.models.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { recordBlocklistFailure, isBlocked } from '../src/model-blocklist.ts';
import { isExcluded, type ExcludeContext } from '../src/exclude.ts';
import { deepMergeConfig } from '../src/config-loader.ts';
import { Router } from '../src/routing.ts';
import * as metricsModule from '../src/metrics.ts';
import type { Cache, Config } from '../src/types.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shipped = JSON.parse(readFileSync(path.join(REPO_ROOT, 'router-config.json'), 'utf-8')) as Config;

const GATED = 'openrouter/vendor/gated-1:free';
const SIBLING = 'openrouter/vendor/fine-1:free';

// Verbatim shapes of the 2026-09-26 router.log lines (model ids are fake).
const AGENTIC_403 =
  '403: {"message":"vendor/gated-1:free is only available on agentic harnesses. Try plugging it into a coding agent or productivity app listed on https://openrouter.ai/apps","code":403}';
const GUARDRAIL_404 =
  '404: {"message":"0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy. We removed them for the following reasons (an endpoint may have matched multiple reasons):\\nFree model training violation (guardrail): 1 endpoint excluded","code":404,"metadata":{"input_endpoint_count":1,"ineligibility_reasons":[{"reason":"free-model-training-violation-by-guardrail","endpoint_count":1}],"failed_routing_step":"Filter by Guardrails"}}';
const RATE_LIMIT_429 = '429 status code (no body)';

describe('shipped router-config.json ships no exclusion list', () => {
  it('exclude.models is empty (exclusions are a user-layer choice or learned)', () => {
    expect(shipped.exclude?.models ?? []).toEqual([]);
  });

  it('declares no concrete provider billing (the user layer owns it)', () => {
    expect(shipped.providers ?? {}).toEqual({});
  });
});

describe('learned blocklist replaces the shipped guardrail list', () => {
  it.each([
    ['403 agentic-harness gate', AGENTIC_403, 'agentic-harness-gate', 403],
    ['404 guardrail / free-model-training-violation', GUARDRAIL_404, 'workspace-guardrail', 404],
  ])('%s blocks the model on the FIRST failure', (_name, text, reason, code) => {
    const cache: Cache = {};
    const entry = recordBlocklistFailure(cache, GATED, text);
    expect(entry).toMatchObject({ reason, code, occurrences: 1 });
    expect(isBlocked(cache, GATED)).toBe(true);
  });

  it('a transient rate limit never blocks (no over-blocking)', () => {
    const cache: Cache = {};
    expect(recordBlocklistFailure(cache, SIBLING, RATE_LIMIT_429)).toBeNull();
    expect(isBlocked(cache, SIBLING)).toBe(false);
  });
});

describe('a blocked model burns no further attempts', () => {
  let cfg: Config;
  let cache: Cache;

  beforeEach(() => {
    cfg = {
      model_groups: {
        trivial: { description: 't', method: 'min_cost_if_all_priced', max_cost: 0, min_gdpval: 0, fallback_groups: [] },
      },
      providers: { openrouter: { billing: 'pay_per_token' } },
      model_metrics: {},
      gdpval_builtin: {},
    } as any;
    cache = {
      available_models: [
        { id: 'vendor/gated-1:free', provider: 'openrouter', cost_per_m: 0 },
        { id: 'vendor/fine-1:free', provider: 'openrouter', cost_per_m: 0 },
      ],
    } as any;
    metricsModule.setConfig(cfg);
    metricsModule.setCache(cache);
    metricsModule.setModelMap({}, []);
  });

  it.each([
    ['403 agentic-harness gate', AGENTIC_403],
    ['404 guardrail', GUARDRAIL_404],
  ])('%s: after one failure the group never offers the model again', (_name, text) => {
    const router = new Router(cfg, cache, new Map());
    expect(router.resolve('trivial')?.candidates).toContain(GATED);

    recordBlocklistFailure(cache, GATED, text);

    for (let i = 0; i < 5; i++) {
      const res = router.resolve('trivial');
      expect(res?.candidates).not.toContain(GATED);
      expect(res?.selected).toBe(SIBLING);
    }
  });
});

describe('the exclude machinery stays intact (ADR-0009 union merge)', () => {
  it('a user-layer exclude.models merged over the empty shipped list still excludes', () => {
    const merged = deepMergeConfig(shipped, { exclude: { models: ['openrouter/vendor/user-pick-1:free'] } } as any);
    const ctx: ExcludeContext = { rules: merged.exclude!, cfg: merged, cache: { available_models: [] } };
    expect(isExcluded('openrouter/vendor/user-pick-1:free', ctx)).toBe(true);
    expect(isExcluded('openrouter/vendor/other-1:free', ctx)).toBe(false);
  });
});
