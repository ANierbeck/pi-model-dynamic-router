// test/config-excludes-guardrail-blocked.test.ts
// Guards the static blocklist in router-config.json's exclude.models.
//
// Live evidence 2026-09-26 (router.log): OpenRouter answers some free-tier
// models with PERMANENT structural failures for this setup —
//   403 "only available on agentic harnesses" (OpenRouter gates the model's
//       only endpoints behind recognized agentic-harness apps; pi's requests
//       never pass that gate), and
//   404 "free-model-training-violation" (the user's workspace guardrails —
//       a deliberate data policy — exclude the endpoint).
// Neither ever heals by retrying: the two thinkingmachines models alone
// burned ~750 candidate attempts in a single evening. The exclude.models
// list in the bundled router-config.json drops them from every group's
// candidate list BEFORE per-group filtering (see src/exclude.ts).
//
// Deliberately NOT on the list: models whose failures were only transient
// rate limits (openrouter/qwen/qwen3.8-27b:free, google/gemma-4-26b-a4b-it:free,
// cohere/north-mini-code:free) — those work again after the reset window and
// must keep their eligibility.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isExcluded, type ExcludeContext } from '../src/exclude.js';
import type { Config, Cache } from '../src/types.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoCfg = JSON.parse(
  readFileSync(join(repoRoot, 'router-config.json'), 'utf-8')
) as Config;

function repoCtx(): ExcludeContext {
  const cache: Cache = { available_models: [] };
  return { rules: repoCfg.exclude!, cfg: repoCfg, cache };
}

// Every ref that showed ONLY permanent structural failures (403 agentic
// harness gate / 404 guardrail data policy) in the 2026-09-26 logs.
const PERMANENTLY_BLOCKED = [
  'openrouter/thinkingmachines/inkling:free',
  'openrouter/thinkingmachines/inkling-small:free',
  'openrouter/liquid/lfm-2.5-2.6b:free',
  'openrouter/nvidia/nemotron-3.5-lightning:free',
  'openrouter/nvidia/nemotron-3.5-content-safety:free',
  'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
  'openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
  'openrouter/poolside/laguna-s-2.1:free',
  'openrouter/poolside/laguna-xs-2.1:free',
  'openrouter/z-ai/glm-5.2:free',
  'openrouter/minimax/minimax-m2.7:free',
  'openrouter/minimax/minimax-m3:free',
  'openrouter/deepseek/deepseek-v4-flash-0731:free',
];

describe('router-config.json static blocklist (guardrail-blocked models, live incident 2026-09-26)', () => {
  it('declares the exclude.models list at all', () => {
    expect(repoCfg.exclude?.models).toBeTruthy();
    expect(Array.isArray(repoCfg.exclude?.models)).toBe(true);
  });

  it('excludes every permanently guardrail-blocked ref', () => {
    const ctx = repoCtx();
    for (const ref of PERMANENTLY_BLOCKED) {
      expect(isExcluded(ref, ctx), ref).toBe(true);
    }
  });

  it('keeps transient rate-limit victims eligible (no over-blocking)', () => {
    const ctx = repoCtx();
    const transient = [
      'openrouter/qwen/qwen3.8-27b:free', // rate limit only — healthy after reset
      'openrouter/google/gemma-4-26b-a4b-it:free',
      'openrouter/cohere/north-mini-code:free',
      'openrouter/stealth/space-bunny-alpha', // answered successfully 2026-09-26
      'mistral/mistral-medium-3', // paid, working
    ];
    for (const ref of transient) {
      expect(isExcluded(ref, ctx), ref).toBe(false);
    }
  });
});

describe('bundled blocklist survives a user exclude.models override (ADR-0009)', () => {
  it('keeps every bundled ref excluded after merging a user config with its own exclude.models', async () => {
    const { deepMergeConfig } = await import('../src/config-loader.js');
    // Shape of the owner's ~/.pi/agent/router-config.user.json on 2026-09-26.
    const merged = deepMergeConfig(repoCfg, {
      exclude: {
        paid_models_from: ['openrouter'],
        models: ['*fable*', '*opus*', '*nemotron-3*', 'deepseek-v4-flash-0731'],
      },
    });
    const ctx: ExcludeContext = { rules: merged.exclude!, cfg: merged, cache: { available_models: [] } };
    for (const ref of PERMANENTLY_BLOCKED) {
      expect(isExcluded(ref, ctx), ref).toBe(true);
    }
    expect(isExcluded('claude-bridge/claude-fable-5', ctx)).toBe(true);
  });
});
