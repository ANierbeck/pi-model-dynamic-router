// test/classifier-probe-this-binding.test.ts
// The probe's completeSimple seam, red-first (owner report 2026-11-17).
//
// Symptom in the sandbox container and on the host: every configured
// OpenRouter candidate failed the scan-time probe with
//
//   Cannot read properties of undefined (reading 'streamSimple')
//
// Root cause: pi 1.5.2's ModelRuntime.completeSimple is a METHOD that calls
// this.streamSimple. src/scan-runner.ts detached it (`const fn =
// runtime.completeSimple`) and called it bare, so `this` was undefined.
//
// What made it a real defect instead of noise: the probe recorded the thrown
// TypeError as a provider failure. 22 blocklist entries upstream carry the
// signature `x:cannot read properties of undefined (reading streamsimple)`,
// and all 15 OpenRouter models in the host cache sat at fails > 0 — a router
// bug punished the models, and 7-day blocks removed them from routing
// (routing.ts filters blocked refs).
//
// Pinned here:
//   1. the seam calls the method with the runtime as receiver;
//   2. a router-side error is logged and counts against nobody;
//   3. a plain thrown error (transport) still counts — the previous behaviour;
//   4. a provider error in the result still blocks — the blocklist is not
//      silently de-fanged by the fix.

import { describe, it, expect, vi } from 'vitest';
import {
  probeAndCache,
  isRouterSideError,
  type ProbeContext,
} from '../src/classifier-cloud-probe.js';
import { probeCompleteSimple } from '../src/scan-runner.js';
import { isUnhealthy } from '../src/model-health.js';
import * as metrics from '../src/metrics.js';
import type { Config, Cache } from '../src/types.ts';

const baseCfg: Config = {
  providers: { openrouter: { keys: [{ key: 'test-key' }] } },
  model_groups: {},
  model_metrics: {},
};

function okReply(category: string) {
  return {
    errorMessage: undefined,
    stopReason: 'stop',
    content: [
      { type: 'text', text: JSON.stringify({ category, reason: 'probe reply', confidence: 0.9 }) },
    ],
  };
}

function caseAwareReply(prompt: any) {
  const content: string = prompt?.messages?.[0]?.content ?? '';
  if (content.includes('What is in this file?')) return okReply('simple');
  if (content.includes('Fix the typo in line 3 of the parse function'))
    return okReply('code_simple');
  if (content.includes('Explain what a closure is briefly')) return okReply('simple');
  return okReply('standard');
}

function cacheWith(ref: string): Cache {
  const [provider, id] = ref.split('/');
  return {
    available_models: [{ id, provider, cost_per_m: 0 }],
    openrouter_pricing: { [ref]: { input: 0, output: 0 } },
  } as Cache;
}

function seed(cfg: Config, cache: Cache) {
  metrics.setConfig(cfg);
  metrics.setCache(cache);
}

describe('probeCompleteSimple — the detached-method defect', () => {
  it('calls completeSimple with the runtime as receiver, so this.streamSimple resolves', async () => {
    // Shaped like pi 1.5.2: completeSimple is a method on the runtime and
    // delegates to another method on the same object.
    const runtime = {
      streamSimple(model: any, prompt: any) {
        return { result: async () => caseAwareReply(prompt) };
      },
      async completeSimple(model: any, prompt: any, options?: any) {
        return this.streamSimple(model, prompt, options).result();
      },
    };
    const completeSimple = probeCompleteSimple({ runtime });
    expect(completeSimple).toBeTypeOf('function');

    const cache = cacheWith('openrouter/ok');
    seed(baseCfg, cache);
    const pctx: ProbeContext = {
      findModel: (ref) => ({ provider: ref.split('/')[0], id: ref.split('/')[1] }),
      completeSimple: completeSimple!,
      hasConfiguredAuth: () => true,
    };
    const logs: string[] = [];
    await probeAndCache(baseCfg, cache, pctx, (l) => logs.push(l));

    expect(logs.some((l) => l.includes('Cannot read properties'))).toBe(false);
    expect(cache.classifier_cloud_models).toEqual(['openrouter/ok']);
  });

  it('stays inert (undefined) when the host exposes no runtime or no method', () => {
    expect(probeCompleteSimple({} as any)).toBeUndefined();
    expect(probeCompleteSimple({ runtime: {} } as any)).toBeUndefined();
    expect(probeCompleteSimple(undefined as any)).toBeUndefined();
  });
});

describe('a router-side error is not evidence about the model', () => {
  it('classifies programming errors, but not transport errors', () => {
    expect(
      isRouterSideError(new TypeError("Cannot read properties of undefined (reading 'x')"))
    ).toBe(true);
    expect(isRouterSideError(new RangeError('out of range'))).toBe(true);
    expect(isRouterSideError(new ReferenceError('nope'))).toBe(true);
    // Transport / provider shapes stay countable.
    expect(isRouterSideError(new Error('socket hang up'))).toBe(false);
    expect(isRouterSideError(new Error('422'))).toBe(false);
  });

  it('a thrown TypeError neither blocks the model nor marks it unhealthy', async () => {
    const cache = cacheWith('openrouter/ok');
    seed(baseCfg, cache);
    const pctx: ProbeContext = {
      findModel: (ref) => ({ provider: ref.split('/')[0], id: ref.split('/')[1] }),
      completeSimple: vi.fn(async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'streamSimple')");
      }),
      hasConfiguredAuth: () => true,
    };
    const logs: string[] = [];
    await probeAndCache(baseCfg, cache, pctx, (l) => logs.push(l));

    expect(cache.model_blocklist?.['openrouter/ok']).toBeUndefined();
    expect(isUnhealthy(cache, 'openrouter/ok')).toBe(false);
    expect(logs.some((l) => l.includes('not counted against the model'))).toBe(true);
  });

  it('a plain thrown error still counts against the model (transport keeps its teeth)', async () => {
    const cache = cacheWith('openrouter/ok');
    seed(baseCfg, cache);
    const pctx: ProbeContext = {
      findModel: (ref) => ({ provider: ref.split('/')[0], id: ref.split('/')[1] }),
      completeSimple: vi.fn(async () => {
        throw new Error('socket hang up');
      }),
      hasConfiguredAuth: () => true,
    };
    await probeAndCache(baseCfg, cache, pctx, () => {});
    // A transport error is a fact about the model's reachability: it lands in
    // the health store (a 7-day block needs a retirement signature or 5
    // unknown-signature failures over an hour, so nothing blocks here).
    expect(cache.model_health?.['openrouter/ok']).toMatchObject({ fails: 1 });
  });

  it('a provider refusal in the result still blocks the model', async () => {
    const cache = cacheWith('openrouter/ok');
    seed(baseCfg, cache);
    const pctx: ProbeContext = {
      findModel: (ref) => ({ provider: ref.split('/')[0], id: ref.split('/')[1] }),
      completeSimple: vi.fn(async () => ({
        stopReason: 'error',
        errorMessage:
          '404: {"message":"0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy."}',
        content: [],
      })),
      hasConfiguredAuth: () => true,
    };
    await probeAndCache(baseCfg, cache, pctx, () => {});
    expect(cache.model_blocklist?.['openrouter/ok']).toMatchObject({
      reason: 'workspace-guardrail',
    });
  });
});
