// test/consolidated-stream-error-pins.test.ts
// Consolidation of one-file-per-incident micro tests (suite hygiene round
// 2026-10-04): each former standalone file lives on as its own describe,
// named after the original file - failure output stays greppable. The
// tests themselves are UNCHANGED; hooks and fixtures moved verbatim.

import { describe, it, expect, vi } from 'vitest';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeNoOpScanCache,
  removeNoOpScanCache,
  flushBackgroundScan,
} from './helpers/noop-scan-cache.ts';
import { fileURLToPath } from 'node:url';
import { isExpectedTransientError } from '../src/stream-driver.ts';
import { isRetryableAssistantError } from '@earendil-works/pi-ai';

describe('422-client-error-not-rate-limit', () => {
  /**
   * End-to-end regression for the 2026-09-27 Mistral incident.
   *
   * Every router-scanned mistral/mistral-zai model answered with a bare
   * "422 status code (no body)" (request-shaped client error from the
   * OpenAI-compatible transport — Le Platform rejects pi-ai's payload for
   * these models). isPaidCloudRateLimitFailure blanket-escalated provider_error
   * on paid cloud models into the hard-cooldown ladder, so each failing
   * attempt put the model on a 24h cooldown with a "likely rate limit
   * (resets ...)" narration. Within minutes the whole mistral block was
   * locked out and the chain hopped to unrelated models — the "constant
   * model hopping" symptom.
   *
   * The detection fix gates provider_error on the error TEXT: a bare 422
   * (no HTTP 429/402, no rate-limit wording) now records only the SHORT
   * soft backoff and narrates a plain provider error — no "likely rate
   * limit", no reset time, no hard cooldown. Unit coverage of the gate
   * lives in test/detection.test.ts; this file pins the full driveStream
   * behavior with the exact production error text.
   */

  const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
  const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

  async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
    const events: AssistantMessageEvent[] = [];
    for await (const ev of stream) events.push(ev);
    return events;
  }

  async function withIsolatedRouter(
    configOverride: Record<string, unknown>,
    fn: (defaultExport: any, tmpDir: string) => Promise<void>
  ) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-422-soft-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    const dynBak = `${dynamicConfigPath}.422-soft-bak`;
    const cacheBak = `${scanCachePath}.422-soft-bak`;
    const hadDyn = fs.existsSync(dynamicConfigPath);
    const hadCache = fs.existsSync(scanCachePath);
    if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
    if (hadCache) fs.renameSync(scanCachePath, cacheBak);

    writeNoOpScanCache(scanCachePath);

    try {
      vi.resetModules();
      const mod = await import('../index.ts');
      await fn(mod.default as any, tmpDir);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
      removeNoOpScanCache(scanCachePath);
      if (hadCache) fs.renameSync(cacheBak, scanCachePath);
    }
  }

  describe('driveStream: bare 422 on a paid cloud model is a soft failure, not a rate limit', () => {
    it('production text "422 status code (no body)": soft 30s backoff, plain provider-error wording, collapse force-retry still works', async () => {
      await withIsolatedRouter(
        {
          free_models: [],
          providers: { openrouter: { free_models: [] } },
          rate_limit_wait_max_ms: 0,
          model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
          gdpval_builtin: { 'paid-model': 1000 },
        },
        async (defaultExport, tmpDir) => {
          const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
          const pi: any = {
            registerTool: vi.fn(),
            registerCommand: vi.fn(),
            registerProvider: vi.fn(),
            setModel: vi.fn(async () => true),
            on: vi.fn((event: string, handler: any) => {
              onHandlers[event] = handler;
            }),
          };
          defaultExport(pi);

          // PAID cloud model (no ':free' suffix, not ollama/lm-studio) failing
          // with the exact production error text from the 2026-09-27 incident.
          const paidModel = {
            provider: 'paid-cloud-provider',
            id: 'paid-model',
            api: 'openai-completions',
            contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
          };
          const modelsByRef: Record<string, any> = {
            'paid-cloud-provider/paid-model': paidModel,
          };
          const streamSimple = vi.fn(() => {
            return (async function* () {
              yield {
                type: 'error',
                error: { errorMessage: '422 status code (no body)' },
              };
            })();
          });
          const modelRegistry = {
            getAvailable: () => [paidModel],
            find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
            getApiKeyForProvider: async () => null,
            runtime: { streamSimple },
          };
          const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
          await onHandlers['session_start']?.({}, ctx);
          await flushBackgroundScan();

          const groupModel = { provider: 'standard', id: 'standard' };
          const context: any = { messages: [{ role: 'user', content: 'do the thing' }] };

          const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));
          const routerInfoText = events
            .filter((e: any) => e.type === 'text_delta')
            .map((e: any) => e.delta ?? '')
            .join('');

          // The failure is narrated as a plain provider error with its detail …
          expect(routerInfoText).toContain('provider error: 422 status code (no body)');
          // … NOT as a rate limit: no hard-cooldown framing, no reset time.
          expect(routerInfoText).not.toContain('likely rate limit');
          expect(routerInfoText).not.toMatch(/\(resets .+\)/);
          // Only the SHORT soft backoff was recorded, so the single-pass
          // cooldown-collapse force-retries within this call (original attempt
          // + force-retry) instead of waiting out a hard ladder tier.
          expect(streamSimple).toHaveBeenCalledTimes(2);
          expect(routerInfoText).toMatch(/All models in cooldown[^\n]*\(shortest cooldown, 30s\)/);
        }
      );
    }, 30000);
  });
});


describe('abort-not-provider-error', () => {
  /**
   * Regression test for roborev job 345 (HIGH finding).
   *
   * pi-ai's AssistantMessageEvent contract has a stream terminate with
   * `{type:'error', reason:'aborted'|'error', error}` for BOTH a genuine
   * provider fault AND a user/agent-initiated cancellation (e.g. Ctrl-C
   * mid-generation) — the underlying provider's stream() implementation sets
   * `stopReason: signal?.aborted ? "aborted" : "error"` itself.
   *
   * Before this fix, consumeWithDetection's error-event handling only checked
   * the error text for rate-limit/overflow patterns and otherwise fell through
   * to `providerErrorDetected = true` — including for a plain user abort. On a
   * paid cloud model that got escalated to a HARD cooldown + key rotation with
   * a "likely rate limit" message, even though nothing was wrong with the
   * provider; the user simply cancelled.
   *
   * Fix: an error event with `reason === 'aborted'` is forwarded to the caller
   * as-is (preserving the real `stopReason: 'aborted'` message pi-ai's own
   * abort handling expects) and short-circuits driveStream with no cooldown
   * recorded against the model and no further candidates tried.
   */

  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
  const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

  async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
    const events: AssistantMessageEvent[] = [];
    for await (const ev of stream) events.push(ev);
    return events;
  }

  async function withIsolatedRouter(
    configOverride: Record<string, unknown>,
    fn: (defaultExport: any, tmpDir: string) => Promise<void>
  ) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-abort-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    const dynBak = `${dynamicConfigPath}.abort-bak`;
    const cacheBak = `${scanCachePath}.abort-bak`;
    const hadDyn = fs.existsSync(dynamicConfigPath);
    const hadCache = fs.existsSync(scanCachePath);
    if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
    if (hadCache) fs.renameSync(scanCachePath, cacheBak);

    writeNoOpScanCache(scanCachePath);

    try {
      vi.resetModules();
      const mod = await import('../index.ts');
      await fn(mod.default as any, tmpDir);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
      removeNoOpScanCache(scanCachePath);
      if (hadCache) fs.renameSync(cacheBak, scanCachePath);
    }
  }

  describe('driveStream: user-abort error events', () => {
    it('forwards the real aborted event and does not escalate a paid cloud model to a rate-limit cooldown', async () => {
      await withIsolatedRouter(
        {
          free_models: [],
          providers: { openrouter: { free_models: [] } },
          model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
          gdpval_builtin: { 'paid-model': 1000 },
        },
        async (defaultExport, tmpDir) => {
          const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
          const pi: any = {
            registerTool: vi.fn(),
            registerCommand: vi.fn(),
            registerProvider: vi.fn(),
            setModel: vi.fn(async () => true),
            on: vi.fn((event: string, handler: any) => {
              onHandlers[event] = handler;
            }),
          };
          defaultExport(pi);

          const paidModel = {
            provider: 'paid-cloud-provider',
            id: 'paid-model',
            api: 'openai-completions',
            contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
          };
          const modelsByRef: Record<string, any> = {
            'paid-cloud-provider/paid-model': paidModel,
          };
          // Exact shape a real provider produces on a user/agent-initiated
          // cancellation (e.g. Ctrl-C): stopReason 'aborted', not 'error'.
          const streamSimple = vi.fn(() => {
            return (async function* () {
              yield {
                type: 'error',
                reason: 'aborted',
                error: {
                  role: 'assistant',
                  content: [],
                  stopReason: 'aborted',
                  errorMessage: undefined,
                },
              };
            })();
          });
          const modelRegistry = {
            getAvailable: () => [paidModel],
            find: (provider: string, modelId: string) =>
              modelsByRef[`${provider}/${modelId}`] ?? null,
            getApiKeyForProvider: async () => null,
            runtime: { streamSimple },
          };
          const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
          await onHandlers['session_start']?.({}, ctx);
          await flushBackgroundScan();

          const groupModel = { provider: 'standard', id: 'standard' };
          const context: any = { messages: [{ role: 'user', content: 'do the thing' }] };

          const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

          // The real aborted event must reach the caller, not a synthesized
          // "provider_error"/"rate limit" message.
          const errEvent = events.find((e: any) => e.type === 'error') as any;
          expect(errEvent).toBeDefined();
          expect(errEvent.reason).toBe('aborted');
          expect(errEvent.error.stopReason).toBe('aborted');

          // Must NOT contain any rate-limit/provider-error framing — that would
          // mean the abort got misclassified and escalated.
          const allEventText = JSON.stringify(events);
          expect(allEventText).not.toContain('likely rate limit');
          expect(allEventText).not.toContain('provider_error');

          // Only one candidate exists; the router must not have tried it again
          // (which would happen if the abort were treated as a soft/hard
          // failure worth a fallback retry).
          expect(streamSimple).toHaveBeenCalledTimes(1);
        }
      );
    }, 30000);
  });
});


describe('abort-text-not-rate-limit', () => {
  /**
   * Regression test for F10 (2026-09-02 architecture review).
   *
   * roborev job 345 fixed the case where pi-ai reports a user/agent-initiated
   * cancellation with the STRUCTURED signal `{type:'error', reason:'aborted'}`
   * (see test/abort-not-provider-error.test.ts). But a cascade-induced abort
   * can also surface with NO structured `reason:'aborted'` field at all — only
   * free text inside the error event's message. Observed in production:
   * claude-bridge serializes its own AbortError (triggered when a parent
   * subagent fanout crashed Ollama and the cascade tore down an in-flight
   * pi-claude/claude-sonnet-5 call) as `errorMessage: "This operation was
   * aborted"`, with `event.reason` left unset/'error'.
   *
   * Before this fix, that text fell through to the providerErrorDetected
   * branch, got classified as `reason: 'provider_error'`, and
   * isPaidCloudRateLimitFailure treated that as rate-limit-shaped for any paid
   * cloud model — applying a 2-hour hard cooldown + key rotation to a model
   * that was never actually rate-limited. In production this locked Sonnet out
   * of the tactical/strategic groups for 2 hours after every subagent-fanout
   * crash, routing every subsequent turn to the cheapest free-tier fallback
   * model instead.
   *
   * Fix: detection.ts's isAbortLikeText() recognizes this free-text pattern and
   * index.ts's consumeWithDetection treats it exactly like a structured
   * reason:'aborted' event — forwarded as-is, no cooldown recorded, no
   * candidate retry.
   */

  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
  const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

  async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
    const events: AssistantMessageEvent[] = [];
    for await (const ev of stream) events.push(ev);
    return events;
  }

  async function withIsolatedRouter(
    configOverride: Record<string, unknown>,
    fn: (defaultExport: any, tmpDir: string) => Promise<void>
  ) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-abort-text-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    const dynBak = `${dynamicConfigPath}.abort-text-bak`;
    const cacheBak = `${scanCachePath}.abort-text-bak`;
    const hadDyn = fs.existsSync(dynamicConfigPath);
    const hadCache = fs.existsSync(scanCachePath);
    if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
    if (hadCache) fs.renameSync(scanCachePath, cacheBak);

    writeNoOpScanCache(scanCachePath);

    try {
      vi.resetModules();
      const mod = await import('../index.ts');
      await fn(mod.default as any, tmpDir);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
      removeNoOpScanCache(scanCachePath);
      if (hadCache) fs.renameSync(cacheBak, scanCachePath);
    }
  }

  describe('driveStream: free-text abort inside an error event (not reason:"aborted")', () => {
    it('is treated as an abort, not a paid-cloud rate limit — no hard cooldown, no retry', async () => {
      await withIsolatedRouter(
        {
          free_models: [],
          providers: { openrouter: { free_models: [] } },
          model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
          gdpval_builtin: { 'claude-sonnet-5': 1603 },
        },
        async (defaultExport, tmpDir) => {
          const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
          const pi: any = {
            registerTool: vi.fn(),
            registerCommand: vi.fn(),
            registerProvider: vi.fn(),
            setModel: vi.fn(async () => true),
            on: vi.fn((event: string, handler: any) => {
              onHandlers[event] = handler;
            }),
          };
          defaultExport(pi);

          // Mirrors the production pi-claude case: a paid cloud model (no
          // :free tag, not ollama/lm-studio), whose provider (e.g.
          // claude-bridge) reports a cascade-induced abort as free text,
          // WITHOUT the structured reason:'aborted' field.
          const paidModel = {
            provider: 'pi-claude',
            id: 'claude-sonnet-5',
            api: 'claude-bridge',
            contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
          };
          const modelsByRef: Record<string, any> = {
            'pi-claude/claude-sonnet-5': paidModel,
          };
          const streamSimple = vi.fn(() => {
            return (async function* () {
              yield {
                type: 'error',
                error: { errorMessage: 'This operation was aborted' },
              };
            })();
          });
          const modelRegistry = {
            getAvailable: () => [paidModel],
            find: (provider: string, modelId: string) =>
              modelsByRef[`${provider}/${modelId}`] ?? null,
            getApiKeyForProvider: async () => null,
            runtime: { streamSimple },
          };
          const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
          await onHandlers['session_start']?.({}, ctx);
          await flushBackgroundScan();

          const groupModel = { provider: 'standard', id: 'standard' };
          const context: any = { messages: [{ role: 'user', content: 'do the thing' }] };

          const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

          // Must be treated as an abort: reason:'aborted' forwarded to the
          // caller, exactly like the structured-signal case.
          const errEvent = events.find((e: any) => e.type === 'error') as any;
          expect(errEvent).toBeDefined();
          expect(errEvent.reason).toBe('aborted');

          // Must NOT contain any rate-limit/provider-error framing — that
          // would mean the text-based abort got misclassified as
          // provider_error and escalated to a hard cooldown (the F10 bug).
          const allEventText = JSON.stringify(events);
          expect(allEventText).not.toContain('likely rate limit');
          expect(allEventText).not.toContain('provider_error');

          // Only one candidate exists; the router must not retry it (which
          // would happen if the text-abort were treated as a soft/hard
          // failure worth a fallback attempt).
          expect(streamSimple).toHaveBeenCalledTimes(1);
        }
      );
    }, 30000);
  });
});


describe('blocklist-drivestream', () => {
  // test/blocklist-drivestream.test.ts
  // End-to-end check for ADR-0008 Tier 1: a provider_error with a known-permanent
  // OpenRouter signature blocks the model for the following requests.

  const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
  const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

  async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
    const events: AssistantMessageEvent[] = [];
    for await (const ev of stream) events.push(ev);
    return events;
  }

  async function withIsolatedRouter(
    configOverride: Record<string, unknown>,
    fn: (defaultExport: any, tmpDir: string) => Promise<void>
  ) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-blocklist-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    const dynBak = `${dynamicConfigPath}.blocklist-bak`;
    const cacheBak = `${scanCachePath}.blocklist-bak`;
    const hadDyn = fs.existsSync(dynamicConfigPath);
    const hadCache = fs.existsSync(scanCachePath);
    if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
    if (hadCache) fs.renameSync(scanCachePath, cacheBak);

    writeNoOpScanCache(scanCachePath);

    try {
      vi.resetModules();
      const mod = await import('../index.ts');
      await fn(mod.default as any, tmpDir);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
      removeNoOpScanCache(scanCachePath);
      if (hadCache) fs.renameSync(cacheBak, scanCachePath);
    }
  }

  describe('driveStream: learned blocklist (ADR-0008, Tier 1)', () => {
    it('blocks a model after a permanent 403, skips it on the next request and persists the block', async () => {
      await withIsolatedRouter(
        {
          free_models: [],
          providers: { openrouter: { free_models: [] } },
          model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
          gdpval_builtin: { 'gated-model': 1000, 'healthy-model': 900 },
        },
        async (defaultExport, tmpDir) => {
          const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
          const pi: any = {
            registerTool: vi.fn(),
            registerCommand: vi.fn(),
            registerProvider: vi.fn(),
            setModel: vi.fn(async () => true),
            on: vi.fn((event: string, handler: any) => {
              onHandlers[event] = handler;
            }),
          };
          defaultExport(pi);

          // Not on the bundled static exclude list, so only the learned block can remove it.
          const gated = {
            provider: 'openrouter',
            id: 'test-vendor/gated-model:free',
            api: 'openai-completions',
            contextWindow: 1_000_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          };
          const healthy = {
            provider: 'healthy-provider',
            id: 'healthy-model',
            api: 'openai-completions',
            contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
          };
          const byRef: Record<string, any> = {
            'openrouter/test-vendor/gated-model:free': gated,
            'healthy-provider/healthy-model': healthy,
          };
          const streamSimple = vi.fn((model: any) => {
            if (model.id === gated.id) {
              return (async function* () {
                yield {
                  type: 'error',
                  error: {
                    errorMessage:
                      '403: {"message":"test-vendor/gated-model:free is only available on agentic harnesses. Try plugging it into a coding agent or productivity app listed on https://openrouter.ai/apps","code":403}',
                  },
                };
              })();
            }
            return (async function* () {
              yield { type: 'text_delta', delta: 'served by the healthy fallback' };
              yield { type: 'done' };
            })();
          });
          const modelRegistry = {
            getAvailable: () => [gated, healthy],
            find: (provider: string, modelId: string) => byRef[`${provider}/${modelId}`] ?? null,
            getApiKeyForProvider: async (provider: string) => (provider === 'openrouter' ? 'sk-or-test' : null),
            runtime: { streamSimple },
          };
          const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
          await onHandlers['session_start']?.({}, ctx);
          await flushBackgroundScan();

          const groupModel = { provider: 'standard', id: 'standard' };
          const context: any = { messages: [{ role: 'user', content: 'do the thing' }] };

          const first = await drainStream(defaultExport.groupStream(groupModel, context, {}));
          expect(first.filter((e: any) => e.type === 'text_delta').map((e: any) => e.delta).join('')).toContain(
            'served by the healthy fallback'
          );
          expect(streamSimple.mock.calls.map((c: any[]) => c[0].id)).toContain(gated.id);

          const persisted = JSON.parse(fs.readFileSync(scanCachePath, 'utf-8'));
          expect(persisted.model_blocklist?.['openrouter/test-vendor/gated-model:free']).toMatchObject({
            reason: 'agentic-harness-gate',
            code: 403,
            occurrences: 1,
          });

          streamSimple.mockClear();
          await drainStream(defaultExport.groupStream(groupModel, context, {}));
          const secondCalls = streamSimple.mock.calls.map((c: any[]) => c[0].id);
          expect(secondCalls).not.toContain(gated.id);
          expect(secondCalls).toContain('healthy-model');
        }
      );
    }, 30000);
  });
});


describe('claude-bridge-empty-response-narration', () => {
  // test/claude-bridge-empty-response-narration.test.ts
  // Regression test for a 2026-10-03 live finding: claude-bridge sometimes
  // answers with an EMPTY response (stopReason 'stop', 0 chars) — no error
  // text, no 429, and no reset time. The router narrated:
  //
  //   "> [router] claude-bridge/claude-opus-5-5 — empty response (likely
  //    rate limit) (resets 10/3/2026, 12:23:53 PM), trying anthropic/…"
  //
  // Two guesses presented as facts: nothing points at a rate limit, and the
  // "resets" time is fabricated — the bridge never sent one, so the router
  // rendered its OWN backoff end as if the provider had announced a reset.
  // A first fix narrated "likely subscription spend limit" instead — also a
  // guess, disproved the same day: the same model streamed full answers
  // minutes before and after the empty turns, so no limit was exhausted.
  // The bridge reports no cause, so the router must not invent one.
  //
  // Honest behaviour (fixed):
  //   - bridge refs are narrated as "empty response (no content, no error
  //     reported)" — no cause claimed
  //   - a reset time is only shown when the provider actually sent one;
  //     the router's own cooldown is narrated as "backing off until …".


  const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
  const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

  async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
    const events: AssistantMessageEvent[] = [];
    for await (const ev of stream) events.push(ev);
    return events;
  }

  async function withIsolatedRouter(
    configOverride: Record<string, unknown>,
    fn: (defaultExport: any, tmpDir: string) => Promise<void>
  ) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-bridge-empty-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    const dynBak = `${dynamicConfigPath}.bridge-empty-bak`;
    const cacheBak = `${scanCachePath}.bridge-empty-bak`;
    const hadDyn = fs.existsSync(dynamicConfigPath);
    const hadCache = fs.existsSync(scanCachePath);
    if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
    if (hadCache) fs.renameSync(scanCachePath, cacheBak);

    writeNoOpScanCache(scanCachePath);

    try {
      vi.resetModules();
      const mod = await import('../index.ts');
      await fn(mod.default as any, tmpDir);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
      removeNoOpScanCache(scanCachePath);
      if (hadCache) fs.renameSync(cacheBak, scanCachePath);
    }
  }

  describe('claude-bridge empty response narration (no invented cause)', () => {
    it('narrates the empty response honestly: no claimed cause, no fabricated reset time — for ANY provider, not just the bridge', async () => {
      await withIsolatedRouter(
        {
          free_models: [],
          providers: {},
          model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
          gdpval_builtin: { 'claude-opus-5-5': 1000, 'next-model': 900 },
        },
        async (defaultExport) => {
          const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
          const pi: any = {
            registerTool: vi.fn(),
            registerCommand: vi.fn(),
            registerProvider: vi.fn(),
            setModel: vi.fn(async () => true),
            on: vi.fn((event: string, handler: any) => {
              onHandlers[event] = handler;
            }),
          };
          defaultExport(pi);

          // The exact live signature: bridge answers 'stop' with ZERO
          // content — no error event, no reset time.
          const bridgeModel = {
            provider: 'claude-bridge',
            id: 'claude-opus-5-5',
            api: 'anthropic',
            contextWindow: 1_000_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          };
          const nextModel = {
            provider: 'healthy-provider',
            id: 'next-model',
            api: 'openai-completions',
            contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
          };
          const modelsByRef: Record<string, any> = {
            'claude-bridge/claude-opus-5-5': bridgeModel,
            'healthy-provider/next-model': nextModel,
          };
          const streamSimple = vi.fn((model: any) => {
            if (model.provider === 'claude-bridge') {
              return (async function* () {
                yield { type: 'done' };
              })();
            }
            return (async function* () {
              yield { type: 'text_delta', delta: 'served by the next model' };
              yield { type: 'done' };
            })();
          });
          const modelRegistry = {
            getAvailable: () => [bridgeModel, nextModel],
            find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
            getApiKeyForProvider: async () => null,
            runtime: { streamSimple },
          };
          const ctx: any = { modelRegistry, cwd: os.tmpdir(), ui: { setFooter: vi.fn() } };
          await onHandlers['session_start']?.({}, ctx);
          await flushBackgroundScan();

          const groupModel = { provider: 'standard', id: 'standard' };
          const context: any = { messages: [{ role: 'user', content: 'write the mailinglist text' }] };
          const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

          const text = events
            .filter((e: any) => e.type === 'text_delta')
            .map((e: any) => e.delta ?? '')
            .join('');

          // The cascade survived via the next model.
          expect(text).toContain('served by the next model');

          // Honest narration: the observable fact, no claimed cause …
          expect(text).toContain('claude-bridge/claude-opus-5-5 — empty response (no content, no error reported)');
          expect(text).not.toContain('(likely rate limit)');
          expect(text).not.toContain('spend limit');
          // emptyResponseLabel() is branch-free since the honesty fix: the same
          // observable-only wording applies to every provider ref, because an
          // empty response carries no evidence of a rate limit on any of them.
          // … and no fabricated provider reset — only our own backoff, worded as such.
          expect(text).not.toMatch(/\(resets .+\)/);
          expect(text).toMatch(/\(backing off [0-9hms ]+, until \d{2}:\d{2}\)/);
        }
      );
    }, 30000);
  });
});


describe('context-overflow', () => {
  /**
   * Regression test: when a conversation grew under a large-context model
   * (e.g. Gemini 2.5 Pro @ 1M tokens) and the user switches to a Dynamic
   * group, every candidate's context window is smaller than the accumulated
   * conversation. driveStream skips all of them BEFORE any request reaches a
   * provider — so no provider ever returns an overflow error, so Pi's native
   * compaction never fires, so the conversation never shrinks, so the session
   * freezes in an infinite skip loop on every turn.
   *
   * Fix: when ALL candidates fail ONLY because of context-window size, emit a
   * native-style overflow error (matching the Anthropic "prompt is too long"
   * pattern that @earendil-works/pi-ai/utils/overflow recognises). Pi detects
   * it and runs its own compaction with an appropriate model.
   *
   * The overflow short-circuit only fires once the fallback-group cascade is
   * exhausted: groups are filtered by min_gdpval/cost tier, not by context
   * window, so a lower-priority fallback group can legitimately contain a
   * model with more room than the current group's candidates.
   *
   * This test sets up a group whose only candidate has a small context window,
   * feeds it a conversation larger than that window, and asserts:
   *   1. The emitted error message contains the overflow pattern
   *      ("prompt is too long").
   *   2. The emitted AssistantMessage carries stopReason "error" + errorMessage
   *      (the fields Pi's isContextOverflow() inspects).
   *   3. No fallback cascade was walked (none is configured in this test).
   *
   * A third test (below) verifies the cascade actually gets first refusal when
   * one IS configured and contains a model with enough context.
   */

  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
  const dynamicConfigBackupPath = `${dynamicConfigPath}.overflow-test-bak`;
  const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

  async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
    const events: AssistantMessageEvent[] = [];
    for await (const ev of stream) events.push(ev);
    return events;
  }

  describe('driveStream: context overflow triggers native compaction signal', () => {
    it('emits a native-style overflow error when all candidates skip on context window', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-overflow-'));
      fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.pi', 'router-config.json'),
        JSON.stringify({
          free_models: [],
          rate_limit_wait_max_ms: 0,
          model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        })
      );
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      if (fs.existsSync(dynamicConfigPath)) fs.renameSync(dynamicConfigPath, dynamicConfigBackupPath);

      writeNoOpScanCache(scanCachePath); // make unawaited session_start scan() a no-op (root cause of the "No available models" CI flake)
      try {
        vi.resetModules();
        const mod = await import('../index.ts');
        const defaultExport = mod.default as any;

        const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
        const pi: any = {
          registerTool: vi.fn(),
          registerCommand: vi.fn(),
          registerProvider: vi.fn(),
          setModel: vi.fn(async () => true),
          on: vi.fn((event: string, handler: any) => {
            onHandlers[event] = handler;
          }),
        };
        defaultExport(pi);

        // One candidate with a small context window (8K). The conversation
        // below is ~30K tokens — well over 8K, so driveStream's context-window
        // guard skips it immediately.
        const smallCtxModel = {
          provider: 'small-ctx-provider',
          id: 'claude-sonnet-4-6',
          api: 'small-api',
          contextWindow: 8_000,
          cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        };
        const modelRegistry = {
          getAvailable: () => [smallCtxModel],
          find: () => smallCtxModel,
          getApiKeyForProvider: async () => null,
          runtime: { streamSimple: () => (async function* () {})() },
        };
        const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        // Build a ~30K-token conversation (120K chars / 4).
        const bigMessage = 'x '.repeat(60_000);
        const groupModel = { provider: 'standard', id: 'standard' };
        const context: any = {
          messages: [{ role: 'user', content: bigMessage }],
        };

        const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

        // Find the terminal error event.
        const errEvent = events.find((e: any) => e.type === 'error') as any;
        expect(errEvent).toBeDefined();
        const error = errEvent.error;

        // Must carry the fields Pi's isContextOverflow() checks.
        expect(error.stopReason).toBe('error');
        expect(typeof error.errorMessage).toBe('string');
        // Must match the Anthropic overflow pattern.
        expect(error.errorMessage).toMatch(/prompt is too long/i);
        expect(error.errorMessage).toContain('30000');

        // Regression: Pi's agent-session.js only runs isContextOverflow() at
        // all if `assistantMessage.provider === this.model.provider &&
        // assistantMessage.model === this.model.id` (the "sameModel" gate,
        // meant to ignore a stale overflow from a model the user has since
        // switched away from). This synthetic message must therefore be
        // stamped with the SAME provider/id as the group model Pi passed into
        // groupStream — otherwise the errorMessage above never even gets
        // inspected and auto-compaction silently never fires, no matter how
        // well "prompt is too long" matches.
        expect(error.provider).toBe(groupModel.provider);
        expect(error.model).toBe(groupModel.id);

        // Must NOT have walked the fallback cascade (no other groups configured
        // anyway, but the info line would appear if it tried).
        const allText = events
          .map((e: any) => (e.type === 'text_delta' ? e.delta ?? '' : ''))
          .join('');
        expect(allText).not.toMatch(/trying \w+/i);
      } finally {
        cwdSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        removeNoOpScanCache(scanCachePath);

        if (fs.existsSync(dynamicConfigBackupPath)) fs.renameSync(dynamicConfigBackupPath, dynamicConfigPath);
      }
    });

    it('walks the normal fallback cascade when candidates fail for non-overflow reasons', async () => {
      // Sanity: the overflow short-circuit must NOT fire when candidates fail
      // for other reasons (e.g. "not registered"). Otherwise we'd hide real
      // errors behind a compaction trigger.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-no-overflow-'));
      fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.pi', 'router-config.json'),
        JSON.stringify({
          free_models: [],
          // phantom-provider is deliberately find()=null ("available but not
          // registered"). The bundled router-config.json leaks max_cost:5.0
          // into this group; an unknown-cost pay_per_token model would be dropped
          // at the filter stage and never reach driveStream's "not registered"
          // skip path this test exercises. billing:subscription marks it as a
          // sunk-cost provider so applyGroupFilters keeps it (mirrors a real
          // subscription model the registry has temporarily lost).
          providers: { 'phantom-provider': { billing: 'subscription' } },
          rate_limit_wait_max_ms: 0,
          model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        })
      );
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      if (fs.existsSync(dynamicConfigPath)) fs.renameSync(dynamicConfigPath, dynamicConfigBackupPath);

      writeNoOpScanCache(scanCachePath); // make unawaited session_start scan() a no-op (root cause of the "No available models" CI flake)
      try {
        vi.resetModules();
        const mod = await import('../index.ts');
        const defaultExport = mod.default as any;

        const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
        const pi: any = {
          registerTool: vi.fn(),
          registerCommand: vi.fn(),
          registerProvider: vi.fn(),
          setModel: vi.fn(async () => true),
          on: vi.fn((event: string, handler: any) => {
            onHandlers[event] = handler;
          }),
        };
        defaultExport(pi);

        // Candidate is "available" but find() returns null — tryStream skips
        // with "not registered", NOT a context-window skip.
        const phantomModel = {
          provider: 'phantom-provider',
          id: 'claude-sonnet-4-6',
          api: 'phantom-api',
          contextWindow: 1_000_000,
          cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        };
        const modelRegistry = {
          getAvailable: () => [phantomModel],
          find: () => null,
          getApiKeyForProvider: async () => null,
          runtime: { streamSimple: () => (async function* () {})() },
        };
        const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        const groupModel = { provider: 'standard', id: 'standard' };
        const context: any = { messages: [{ role: 'user', content: 'hello' }] };

        const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));
        const errEvent = events.find((e: any) => e.type === 'error') as any;
        const error = errEvent.error;

        // Must be the normal "All N candidates failed" error, NOT the overflow
        // signal. errorMessage is now populated (fixes pi-ai's "Summarization
        // failed: Unknown error"), but must stay a generic, non-overflow,
        // non-retryable string — not the overflow-pattern text checked below,
        // and not something that would make pi-ai's retryAssistantCall re-run
        // this already-exhausted cascade.
        expect(error.errorMessage).toBeTruthy();
        expect(error.errorMessage).not.toMatch(/prompt is too long/i);
        const text = Array.isArray(error.content)
          ? error.content.map((c: any) => c.text ?? '').join('')
          : '';
        expect(text).toContain('All');
        expect(text).toContain('failed');
        expect(text).not.toMatch(/prompt is too long/i);
      } finally {
        cwdSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        removeNoOpScanCache(scanCachePath);

        if (fs.existsSync(dynamicConfigBackupPath)) fs.renameSync(dynamicConfigBackupPath, dynamicConfigPath);
      }
    });

    it('tries a configured fallback group BEFORE emitting the overflow signal, and succeeds if it has enough context', async () => {
      // Groups are filtered by min_gdpval/cost tier, not by context window, so
      // a lower-priority fallback group can legitimately contain a
      // large-context model that the current group's (small-context) candidate
      // list doesn't have. The overflow short-circuit must not preempt that —
      // it may only fire once the cascade itself is exhausted.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-overflow-cascade-'));
      fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.pi', 'router-config.json'),
        JSON.stringify({
          free_models: [],
          model_groups: {
            standard: { fallback_groups: ['big'] },
            big: { fallback_groups: [] },
          },
        })
      );
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      if (fs.existsSync(dynamicConfigPath)) fs.renameSync(dynamicConfigPath, dynamicConfigBackupPath);

      writeNoOpScanCache(scanCachePath); // make unawaited session_start scan() a no-op (root cause of the "No available models" CI flake)
      try {
        vi.resetModules();
        const mod = await import('../index.ts');
        const defaultExport = mod.default as any;

        const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
        const pi: any = {
          registerTool: vi.fn(),
          registerCommand: vi.fn(),
          registerProvider: vi.fn(),
          setModel: vi.fn(async () => true),
          on: vi.fn((event: string, handler: any) => {
            onHandlers[event] = handler;
          }),
        };
        defaultExport(pi);

        // 'standard' group's only candidate is too small for the conversation.
        // 'big' group's only candidate has plenty of room.
        const smallCtxModel = {
          provider: 'small-ctx-provider',
          id: 'small-model',
          api: 'small-api',
          contextWindow: 8_000,
          cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        };
        const bigCtxModel = {
          provider: 'big-ctx-provider',
          id: 'big-model',
          api: 'big-api',
          contextWindow: 1_000_000,
          cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        };
        const modelsByRef: Record<string, any> = {
          'small-ctx-provider/small-model': smallCtxModel,
          'big-ctx-provider/big-model': bigCtxModel,
        };
        const streamSimple = vi.fn((model: any) => {
          if (model.id === 'big-model') {
            return (async function* () {
              yield { type: 'text_delta', delta: 'served by the big-context fallback' };
              yield { type: 'done' };
            })();
          }
          return (async function* () {})();
        });
        const modelRegistry = {
          getAvailable: () => [smallCtxModel, bigCtxModel],
          find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
          getApiKeyForProvider: async () => null,
          runtime: { streamSimple },
        };
        const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        // ~30K-token conversation — over the small model's 8K window, well under
        // the big model's 1M window.
        const bigMessage = 'x '.repeat(60_000);
        const groupModel = { provider: 'standard', id: 'standard' };
        const context: any = { messages: [{ role: 'user', content: bigMessage }] };

        const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

        // Must NOT have emitted the synthetic overflow signal — the cascade
        // found a model with enough room.
        const errEvent = events.find((e: any) => e.type === 'error') as any;
        expect(errEvent).toBeUndefined();

        const text = events
          .filter((e: any) => e.type === 'text_delta')
          .map((e: any) => e.delta ?? '')
          .join('');
        expect(text).toContain('served by the big-context fallback');
        expect(streamSimple).toHaveBeenCalled();
      } finally {
        cwdSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        removeNoOpScanCache(scanCachePath);

        if (fs.existsSync(dynamicConfigBackupPath)) fs.renameSync(dynamicConfigBackupPath, dynamicConfigPath);
      }
    });
  });
});


describe('cooldown-collapse', () => {
  /**
   * Regression test: when EVERY candidate in a group is in cooldown (total
   * cooldown collapse), driveStream must NOT hard-fail with a generic "All N
   * candidates failed" error that surfaces as Pi's opaque "Unknown error".
   * Instead it picks the candidate with the shortest remaining cooldown and
   * retries it anyway — the cooldown is a router-internal heuristic, not a
   * hard provider-side limit.
   *
   * Without this, a long session where transient failures cool down every
   * model simultaneously freezes until the longest cooldown expires, even
   * though the shortest-cooldown model would likely have recovered.
   *
   * Strategy: a single candidate that THROWS on its first attempt (setting a
   * cooldown), then SUCCEEDS on the force-retry. We verify:
   *   1. The collapse handler fires ("All models in cooldown, retrying ...").
   *   2. The force-retry actually calls tryStream (bypasses isLimited()).
   *   3. The recovered output reaches the stream.
   *
   * Isolation: the router reads its scan cache from
   * <extDir>/.cache/scan-cache.json (extDir = repo root during tests). Previous
   * test runs persist real free-tier models there, which would leak into
   * allDiscoveredRefs() and pollute the candidate list. Move it aside, and
   * override free_models + providers.openrouter.free_models to [] so the
   * candidate pool is exactly our single mocked model.
   */

  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
  const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

  async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
    const events: AssistantMessageEvent[] = [];
    for await (const ev of stream) events.push(ev);
    return events;
  }

  function allText(events: AssistantMessageEvent[]): string {
    return events
      .map((e: any) => {
        if (e.type === 'error') {
          const content = e.error?.content;
          return Array.isArray(content) ? content.map((c: any) => c.text ?? '').join('\n') : '';
        }
        if (e.type === 'text_delta') return e.delta ?? '';
        return '';
      })
      .join('\n');
  }

  describe('driveStream: total cooldown collapse', () => {
    // The core fix: single-pass collapse. When a live failure puts all candidates
    // in cooldown, the collapse handler fires IMMEDIATELY within the same pass
    // (not only on the next driveStream call). This prevents the "all N
    // candidates failed" hard-fail when the last candidate is tried live and
    // its own failure adds it to the cooldown list.
    it('single-pass: live-failure cooldown collapse recovers within the same call', async () => {
      // Single candidate that throws (soft failure → cooldown). With single-pass
      // collapse, driveStream detects the cooldown within the same pass and
      // force-retries — so streamSimple call 2 (the in-pass force-retry)
      // succeeds. We track call count to flip behaviour deterministically.
      let calls = 0;
      const streamSimple = vi.fn((model: any) => {
        calls++;
        return (async function* () {
          if (calls === 1) {
            // First call: fail → soft failure → cooldown.
            throw new Error('first attempt fails');
          }
          // Call 2: the in-pass collapse force-retry succeeds.
          yield { type: "text_delta", delta: `recovered after ${calls} calls` };
          yield { type: 'done' };
        })();
      });

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-cooldown-spp-'));
      fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.pi', 'router-config.json'),
        JSON.stringify({
          free_models: [],
          providers: { openrouter: { free_models: [] } },
          rate_limit_wait_max_ms: 0,
          model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        })
      );
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
      const dynBak = `${dynamicConfigPath}.spp-bak`;
      const cacheBak = `${scanCachePath}.spp-bak`;
      const hadDyn = fs.existsSync(dynamicConfigPath);
      const hadCache = fs.existsSync(scanCachePath);
      if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
      if (hadCache) fs.renameSync(scanCachePath, cacheBak);
      writeNoOpScanCache(scanCachePath);

      try {
        vi.resetModules();
        const mod = await import('../index.ts');
        const defaultExport = mod.default as any;
        const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
        const pi: any = {
          registerTool: vi.fn(), registerCommand: vi.fn(), registerProvider: vi.fn(),
          setModel: vi.fn(async () => true),
          on: vi.fn((event: string, handler: any) => { onHandlers[event] = handler; }),
        };
        defaultExport(pi);
        const modelRegistry = {
          getAvailable: () => [{ provider: 'prov', id: 'm', api: 'phantom', contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } }],
          find: () => ({ provider: 'prov', id: 'm', api: 'phantom', contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } }),
          getApiKeyForProvider: async () => null,
          runtime: { streamSimple },
        };
        const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        // Single-pass recovery: the candidate throws → cooldown → collapse fires
        // within the same pass → force-retry succeeds (call 2).
        const events1 = await drainStream(
          defaultExport.groupStream({ provider: 'standard', id: 'standard' }, { messages: [{ role: 'user', content: 'go' }] }, {})
        );
        const text1 = allText(events1);
        expect(text1).toMatch(/All models in cooldown, retrying/i);
        expect(text1).toMatch(/shortest cooldown/i);
        expect(text1).toContain('recovered after 2 calls');
        expect(streamSimple).toHaveBeenCalledTimes(2);
      } finally {
        cwdSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
        if (hadCache) fs.renameSync(cacheBak, scanCachePath);
        removeNoOpScanCache(scanCachePath);
      }
    });

    // Regression: verify single-pass collapse fires within ONE driveStream call when
    // the live-failed candidate puts itself into cooldown. This is the exact bug
    // that caused "all 18 candidates failed" hard-fails in the user's session — the
    // last candidate was tried live, failed, recorded a cooldown, but the strict
    // equality (cooldownSkips === allErrors.length) failed, so the safety net
    // never fired. With the fix (candidates.every(isLimited)), the collapse fires
    // immediately and force-retries the shortest-cooldown candidate in the same pass.
    // This test (single-pass) is covered by 'single-pass: live-failure...' above.
    //
    // The multi-call path (second call sees cooldown from first and recovers via
    // collapse) is covered by the original 'force-retry that fails with provider_error'
    // test below, which sets up a session and makes two calls. Both tests together
    // give full coverage of the collapse fix without the complexity of a combined test.

    it('force-retry that fails with provider_error shows the provider-error wording, not the generic empty-response one (roborev job 342 LOW)', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-cooldown-collapse-pe-'));
      fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.pi', 'router-config.json'),
        JSON.stringify({
          free_models: [],
          providers: { openrouter: { free_models: [] } },
          rate_limit_wait_max_ms: 0,
          model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        })
      );
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
      const dynBak = `${dynamicConfigPath}.collapse-pe-bak`;
      const cacheBak = `${scanCachePath}.collapse-pe-bak`;
      const hadDyn = fs.existsSync(dynamicConfigPath);
      const hadCache = fs.existsSync(scanCachePath);
      if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
      if (hadCache) fs.renameSync(scanCachePath, cacheBak);

      writeNoOpScanCache(scanCachePath);

      try {
        vi.resetModules();
        const mod = await import('../index.ts');
        const defaultExport = mod.default as any;

        const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
        const pi: any = {
          registerTool: vi.fn(),
          registerCommand: vi.fn(),
          registerProvider: vi.fn(),
          setModel: vi.fn(async () => true),
          on: vi.fn((event: string, handler: any) => {
            onHandlers[event] = handler;
          }),
        };
        defaultExport(pi);

        // Single, PAID cloud candidate (no ':free' suffix, not ollama/lm-studio)
        // so recordStreamFailure's hard-cooldown branch applies. First attempt
        // throws (cooldown set); the force-retry then fails with an
        // unrecognized finish_reason (provider_error), not a plain
        // empty/timeout failure.
        let calls = 0;
        const streamSimple = vi.fn(() => {
          calls++;
          return (async function* () {
            if (calls === 1) {
              throw new Error('first attempt fails');
            }
            yield {
              type: 'error',
              // Rate-limit-shaped (HTTP 429): since the 2026-09-27 422 fix a
              // bare provider_error stays soft and the collapse force-retry
              // pushes no hard-cooldown line at all — the wording this test
              // pins only fires for rate-limit-shaped failures.
              error: { errorMessage: '429 too many requests' },
            };
          })();
        });
        const modelRegistry = {
          getAvailable: () => [{ provider: 'paid-cloud-provider', id: 'paid-model', api: 'openai-completions', contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } }],
          find: () => ({ provider: 'paid-cloud-provider', id: 'paid-model', api: 'openai-completions', contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } }),
          getApiKeyForProvider: async () => null,
          runtime: { streamSimple },
        };
        const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        // First call: throws -> soft failure -> cooldown set -> single-pass
        // collapse fires (the live failure put the only candidate into cooldown)
        // -> force-retry path fails with provider_error.
        const events1 = await drainStream(
          defaultExport.groupStream({ provider: 'standard', id: 'standard' }, { messages: [{ role: 'user', content: 'go' }] }, {})
        );
        const text1 = allText(events1);

        expect(text1).toMatch(/All models in cooldown, retrying/i);
        // Must show the provider-error-specific wording (with the real detail
        // text). With single-pass collapse (the live failure puts the only
        // candidate into cooldown within the same pass), the original attempt
        // throws -> 'empty response' and the force-retry then yields the error
        // event -> 'provider error'; both lines appear, but the provider-error
        // wording is the one that proves the error-event path was recognized
        // rather than falling through to the generic empty-response reason.
        expect(text1).toContain('provider error: 429 too many requests (likely rate limit)');
      } finally {
        cwdSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
        removeNoOpScanCache(scanCachePath);
        if (hadCache) fs.renameSync(cacheBak, scanCachePath);
      }
    });
  });
});


describe('is-expected-transient-error', () => {
  describe('isExpectedTransientError', () => {
    it('recognizes "no api provider registered"', () => {
      expect(isExpectedTransientError('Error: no API provider registered for mistral')).toBe(true);
    });

    it('delegates rate-limit/spend-limit detection to the shared RATE_LIMIT_PATTERNS table', () => {
      // Patterns only present in the unified table (src/detection.ts), not in
      // the old 6-pattern local list this function used to hardcode.
      expect(isExpectedTransientError('Claude five_hour rate limit hit')).toBe(true);
      expect(isExpectedTransientError('You have exceeded your quota')).toBe(true);
      expect(isExpectedTransientError('rate_limit_exceeded')).toBe(true);
      expect(isExpectedTransientError('the provider is overloaded')).toBe(true);
    });

    it('returns false for an unrelated error', () => {
      expect(isExpectedTransientError('TypeError: cannot read property of undefined')).toBe(false);
    });
  });
});


describe('provider-error-detection', () => {
  /**
   * Integration test: when a provider ends its stream with an unrecognized
   * finish_reason (which pi-ai turns into a generic error event like
   * `{type:'error', error:{errorMessage:'Provider finish_reason: error'}}`),
   * consumeWithDetection must treat that as a soft failure — not silently
   * report success just because content streamed first.
   *
   * Root cause this guards against: before the fix, consumeWithDetection only
   * recognized rate-limit and overflow text patterns. A free OpenRouter model
   * (observed in practice: minimax/minimax-m3:free, cohere/north-mini-code:free,
   * thinkingmachines/inkling:free) that streams partial content and then errors
   * with "Provider finish_reason: <unknown>" fell through every detection branch
   * to the final `return { ok: true }` — the router recorded a successful turn,
   * no cooldown got registered, and the same broken model got picked again next
   * turn. The visible symptom was pi becoming unresponsive while the router
   * silently churned on the same broken model.
   *
   * Fix: any error event that isn't a recognized rate-limit or overflow now
   * sets a generic providerErrorDetected flag. consumeWithDetection returns
   * `{ ok: false, reason: 'provider_error', detail: <errorMessage> }`, and
   * driveStream records a soft failure so the next candidate gets tried.
   */

  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
  const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

  async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
    const events: AssistantMessageEvent[] = [];
    for await (const ev of stream) events.push(ev);
    return events;
  }

  async function withIsolatedRouter(
    configOverride: Record<string, unknown>,
    fn: (defaultExport: any, tmpDir: string) => Promise<void>
  ) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-provider-err-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    const dynBak = `${dynamicConfigPath}.provider-err-bak`;
    const cacheBak = `${scanCachePath}.provider-err-bak`;
    const hadDyn = fs.existsSync(dynamicConfigPath);
    const hadCache = fs.existsSync(scanCachePath);
    if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
    if (hadCache) fs.renameSync(scanCachePath, cacheBak);

    writeNoOpScanCache(scanCachePath);

    try {
      vi.resetModules();
      const mod = await import('../index.ts');
      await fn(mod.default as any, tmpDir);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
      removeNoOpScanCache(scanCachePath);
      if (hadCache) fs.renameSync(cacheBak, scanCachePath);
    }
  }

  describe('driveStream: mid-stream provider error (unrecognized finish_reason)', () => {
    it('a model that streams content then errors with an unrecognized finish_reason fails over to the next candidate', async () => {
      await withIsolatedRouter(
        {
          free_models: [],
          providers: { openrouter: { free_models: [] } },
          model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
          // Broken model ranks first so the router picks it; healthy fallback
          // ranks second and must take over after the soft failure.
          gdpval_builtin: {
            'err-finish-model': 1000,
            'healthy-model': 900,
          },
        },
        async (defaultExport, tmpDir) => {
          const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
          const pi: any = {
            registerTool: vi.fn(),
            registerCommand: vi.fn(),
            registerProvider: vi.fn(),
            setModel: vi.fn(async () => true),
            on: vi.fn((event: string, handler: any) => {
              onHandlers[event] = handler;
            }),
          };
          defaultExport(pi);

          const errModel = {
            provider: 'err-provider',
            id: 'err-finish-model',
            api: 'openai-completions',
            contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
          };
          const healthyModel = {
            provider: 'healthy-provider',
            id: 'healthy-model',
            api: 'openai-completions',
            contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
          };
          const modelsByRef: Record<string, any> = {
            'err-provider/err-finish-model': errModel,
            'healthy-provider/healthy-model': healthyModel,
          };
          const streamSimple = vi.fn((model: any) => {
            if (model.id === 'err-finish-model') {
              // Stream partial content, then end with an unrecognized
              // finish_reason that pi-ai maps to an error event. This is the
              // exact shape observed in the wild with free OpenRouter models
              // (minimax-m3, north-mini-code, inkling) — the model streams a
              // few tokens, then the provider's finish_reason="error" (or any
              // value pi-ai doesn't recognize) is converted into:
              //   { type: 'error', error: { errorMessage: 'Provider finish_reason: <reason>' } }
              // Without the fix, the router would treat this as a successful
              // turn because hadContent was already true.
              return (async function* () {
                yield { type: 'text_delta', delta: 'partial answer ' };
                yield {
                  type: 'error',
                  error: { errorMessage: 'Provider finish_reason: error' },
                };
              })();
            }
            if (model.id === 'healthy-model') {
              return (async function* () {
                yield { type: 'text_delta', delta: 'served by the healthy fallback' };
                yield { type: 'done' };
              })();
            }
            return (async function* () {})();
          });
          const modelRegistry = {
            getAvailable: () => [errModel, healthyModel],
            find: (provider: string, modelId: string) =>
              modelsByRef[`${provider}/${modelId}`] ?? null,
            getApiKeyForProvider: async () => null,
            runtime: { streamSimple },
          };
          const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
          await onHandlers['session_start']?.({}, ctx);
          await flushBackgroundScan();

          const groupModel = { provider: 'standard', id: 'standard' };
          const context: any = { messages: [{ role: 'user', content: 'do the thing' }] };

          const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

          // The healthy fallback's content must have made it through — proves
          // the broken model was detected and the cascade fell over instead of
          // returning "ok: true" on the partial stream.
          const text = events
            .filter((e: any) => e.type === 'text_delta')
            .map((e: any) => e.delta ?? '')
            .join('');
          expect(text).toContain('served by the healthy fallback');

          // The error event from the broken model must NOT have been forwarded
          // to the user — consumeWithDetection explicitly drops error events so
          // the cascade can try the next candidate without surfacing the raw
          // provider text.
          const errEvent = events.find((e: any) => e.type === 'error') as any;
          expect(errEvent).toBeUndefined();

          // The broken model must have actually been called (sanity check —
          // otherwise the test would pass trivially with the healthy model
          // ranked first).
          const calledIds = streamSimple.mock.calls.map((c: any[]) => c[0].id);
          expect(calledIds).toContain('err-finish-model');
        }
      );
    }, 30000);
  });
});


describe('provider-error-paid-cloud-cooldown', () => {
  /**
   * Regression test for roborev job 339 (LOW finding), revised 2026-09-27.
   *
   * driveStream's provider_error branch (unrecognized finish_reason from a
   * mid-stream error event, see test/provider-error-detection.test.ts) applies
   * to any candidate. A PAID cloud model hitting provider_error originally
   * fell through to the soft-backoff branch meant for local/free models; the
   * roborev-339 fix routed it into the hard-cooldown path ("likely rate
   * limit" + key rotation) for EVERY provider_error.
   *
   * The 2026-09-27 Mistral incident showed the flip side: every scanned
   * mistral/mistral-zai model answered with a bare "422 status code (no
   * body)" — a request-shaped client error, not a rate limit — and the
   * blanket escalation put each of them on a 24h hard cooldown, the direct
   * cause of the constant model hopping. isPaidCloudRateLimitFailure now
   * gates provider_error on the error TEXT (HTTP 429/402 or rate-limit
   * wording), so both halves of the original behavior stay pinned here:
   *
   *  - a bare/unrecognized provider error keeps the SOFT-backoff wording
   *    ("provider error: <detail>", no rate-limit framing, no reset time),
   *  - a provider error carrying HTTP 429 keeps the hard-cooldown treatment
   *    ("likely rate limit" + "(resets ...)" + key rotation) that the
   *    original test asserted.
   *
   * The wording is a direct, observable proxy for which escalation branch ran.
   */

  const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
  const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

  async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
    const events: AssistantMessageEvent[] = [];
    for await (const ev of stream) events.push(ev);
    return events;
  }

  async function withIsolatedRouter(
    configOverride: Record<string, unknown>,
    fn: (defaultExport: any, tmpDir: string) => Promise<void>
  ) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-paid-provider-err-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    const dynBak = `${dynamicConfigPath}.paid-provider-err-bak`;
    const cacheBak = `${scanCachePath}.paid-provider-err-bak`;
    const hadDyn = fs.existsSync(dynamicConfigPath);
    const hadCache = fs.existsSync(scanCachePath);
    if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
    if (hadCache) fs.renameSync(scanCachePath, cacheBak);

    writeNoOpScanCache(scanCachePath);

    try {
      vi.resetModules();
      const mod = await import('../index.ts');
      await fn(mod.default as any, tmpDir);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
      removeNoOpScanCache(scanCachePath);
      if (hadCache) fs.renameSync(cacheBak, scanCachePath);
    }
  }

  describe('driveStream: provider_error on a paid cloud model', () => {
    // Single PAID cloud candidate (no ':free' suffix, not ollama/lm-studio)
    // failing mid-stream with a provider_error whose TEXT decides which
    // escalation branch runs. Returns the joined router-info text so each
    // test below can pin the observable wording of its branch.
    async function runProviderErrorScenario(errorMessage: string): Promise<string> {
      let routerInfoText = '';
      await withIsolatedRouter(
        {
          free_models: [],
          providers: { openrouter: { free_models: [] } },
          rate_limit_wait_max_ms: 0,
          model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
          gdpval_builtin: { 'paid-model': 1000 },
        },
        async (defaultExport, tmpDir) => {
          const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
          const pi: any = {
            registerTool: vi.fn(),
            registerCommand: vi.fn(),
            registerProvider: vi.fn(),
            setModel: vi.fn(async () => true),
            on: vi.fn((event: string, handler: any) => {
              onHandlers[event] = handler;
            }),
          };
          defaultExport(pi);

          const paidModel = {
            provider: 'paid-cloud-provider',
            id: 'paid-model',
            api: 'openai-completions',
            contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
          };
          const modelsByRef: Record<string, any> = {
            'paid-cloud-provider/paid-model': paidModel,
          };
          const streamSimple = vi.fn(() => {
            return (async function* () {
              yield {
                type: 'error',
                error: { errorMessage },
              };
            })();
          });
          const modelRegistry = {
            getAvailable: () => [paidModel],
            find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
            getApiKeyForProvider: async () => null,
            runtime: { streamSimple },
          };
          const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
          await onHandlers['session_start']?.({}, ctx);
          await flushBackgroundScan();

          const groupModel = { provider: 'standard', id: 'standard' };
          const context: any = { messages: [{ role: 'user', content: 'do the thing' }] };
          const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));
          routerInfoText = events
            .filter((e: any) => e.type === 'text_delta')
            .map((e: any) => e.delta ?? '')
            .join('');
        }
      );
      return routerInfoText;
    }

    it('bare/unrecognized provider error → soft-backoff wording, no hard-cooldown framing', async () => {
      const text = await runProviderErrorScenario('Provider finish_reason: error');
      // Soft branch: the plain provider-error detail is shown ...
      expect(text).toContain('provider error: Provider finish_reason: error');
      // ... WITHOUT the hard-cooldown framing and without a reset time.
      expect(text).not.toContain('likely rate limit');
      expect(text).not.toMatch(/\(resets .+\)/);
    });

    it('provider error carrying HTTP 429 → hard-cooldown ("likely rate limit") treatment', async () => {
      const text = await runProviderErrorScenario('429 too many requests');
      expect(text).toContain('likely rate limit');
      // No provider-announced reset time in the raw text — the router's own
      // cooldown end is shown, worded as OUR backoff (not a fabricated
      // provider "resets", 2026-10-03 honesty fix).
      expect(text).toMatch(/\(backing off [0-9hms ]+, until \d{2}:\d{2}\)/);
    });
  });
});


describe('reasoning-timeout', () => {
  /**
   * Regression test: reasoning models (those advertising a `reasoning`/
   * `thinking` capability) get a longer first-token timeout than instant chat
   * models. Without this, an overloaded reasoning provider (e.g. Mistral
   * serving glm-5-2) gets aborted mid-thought by the 30s empty-response
   * timeout, producing a false "empty response" and a soft-failure cooldown.
   * The router then re-picks the same model on the next turn (it's still the
   * best-ranked) and the timeout fires again — a silent infinite loop that
   * looks like "model never succeeds" even though the model was just slow.
   *
   * This test sets up one reasoning and one non-reasoning model, streams a
   * first token AFTER the short (non-reasoning) timeout would have fired but
   * BEFORE the long (reasoning) timeout, and asserts:
   *   1. The reasoning model's stream completes successfully (not aborted).
   *   2. The non-reasoning model's stream, given the same delay, would be
   *      aborted (sanity — proves the shorter timeout still applies).
   *
   * To keep the test fast, both timeouts are scaled down via a tiny config
   * override (empty_response_timeout_ms: 100, reasoning_*: 5000). The delay
   * of 500ms is > 100ms (short timeout fires) but < 5000ms (long doesn't).
   */

  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
  const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

  async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
    const events: AssistantMessageEvent[] = [];
    for await (const ev of stream) events.push(ev);
    return events;
  }

  function textDeltaText(events: AssistantMessageEvent[]): string {
    return events
      .filter((e: any) => e.type === 'text_delta')
      .map((e: any) => e.delta ?? '')
      .join('');
  }

  describe('driveStream: reasoning models get a longer first-token timeout', () => {
    it('a reasoning model emitting its first token after the short timeout still succeeds', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-reasoning-timeout-'));
      fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.pi', 'router-config.json'),
        JSON.stringify({
          free_models: [],
          providers: { openrouter: { free_models: [] } },
          // Scale timeouts down so the test is fast. Short = 100ms, long = 5000ms.
          empty_response_timeout_ms: 100,
          reasoning_empty_response_timeout_ms: 5000,
          rate_limit_wait_max_ms: 0,
          model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        })
      );
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
      const dynBak = `${dynamicConfigPath}.reasoning-bak`;
      const cacheBak = `${scanCachePath}.reasoning-bak`;
      const hadDyn = fs.existsSync(dynamicConfigPath);
      const hadCache = fs.existsSync(scanCachePath);
      if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
      if (hadCache) fs.renameSync(scanCachePath, cacheBak);

      writeNoOpScanCache(scanCachePath); // make unawaited session_start scan() a no-op (root cause of the "No available models" CI flake)

      try {
        vi.resetModules();
        const mod = await import('../index.ts');
        const defaultExport = mod.default as any;

        const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
        const pi: any = {
          registerTool: vi.fn(),
          registerCommand: vi.fn(),
          registerProvider: vi.fn(),
          setModel: vi.fn(async () => true),
          on: vi.fn((event: string, handler: any) => {
            onHandlers[event] = handler;
          }),
        };
        defaultExport(pi);

        // A reasoning model. It waits 500ms before emitting its first token —
        // longer than the short (100ms) timeout, shorter than the long (5000ms)
        // one. If the wrong timeout is used, this stream is aborted as an
        // "empty response" and the test fails.
        const reasoningModel = {
          provider: 'mistral-zai',
          id: 'glm-5-2',
          api: 'openai-completions',
          contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
          reasoning: true, // pi-ai's Model.reasoning is a boolean, not a ThinkingLevel string
        };
        const streamSimple = vi.fn((model: any) => {
          return (async function* () {
            await new Promise((r) => setTimeout(r, 500));
            yield { type: 'text_delta', delta: `thought for a while, then answered` };
            yield { type: 'done' };
          })();
        });
        const modelRegistry = {
          getAvailable: () => [reasoningModel],
          find: () => reasoningModel,
          getApiKeyForProvider: async () => 'fake-key',
          runtime: { streamSimple },
        };
        const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        const events = await drainStream(
          defaultExport.groupStream(
            { provider: 'standard', id: 'standard' },
            { messages: [{ role: 'user', content: 'think hard' }] },
            {}
          )
        );

        // The reasoning model must NOT have been aborted by the short timeout.
        expect(textDeltaText(events)).toContain('thought for a while, then answered');
        expect(streamSimple).toHaveBeenCalledTimes(1);
      } finally {
        cwdSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
        removeNoOpScanCache(scanCachePath);

        if (hadCache) fs.renameSync(cacheBak, scanCachePath);
      }
    });

    it('a non-reasoning model emitting its first token after the short timeout is aborted', async () => {
      // Sanity: the short timeout must still apply to non-reasoning models.
      // Otherwise we've just made every model wait forever.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-non-reasoning-timeout-'));
      fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.pi', 'router-config.json'),
        JSON.stringify({
          free_models: [],
          providers: { openrouter: { free_models: [] } },
          empty_response_timeout_ms: 100,
          reasoning_empty_response_timeout_ms: 5000,
          rate_limit_wait_max_ms: 0,
          model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        })
      );
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
      const dynBak = `${dynamicConfigPath}.non-reasoning-bak`;
      const cacheBak = `${scanCachePath}.non-reasoning-bak`;
      const hadDyn = fs.existsSync(dynamicConfigPath);
      const hadCache = fs.existsSync(scanCachePath);
      if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
      if (hadCache) fs.renameSync(scanCachePath, cacheBak);

      try {
        vi.resetModules();
        const mod = await import('../index.ts');
        const defaultExport = mod.default as any;

        const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
        const pi: any = {
          registerTool: vi.fn(),
          registerCommand: vi.fn(),
          registerProvider: vi.fn(),
          setModel: vi.fn(async () => true),
          on: vi.fn((event: string, handler: any) => {
            onHandlers[event] = handler;
          }),
        };
        defaultExport(pi);

        // A NON-reasoning model (no `reasoning`/`thinking` field). Same 500ms
        // delay before first token. The short (100ms) timeout must fire and
        // abort this stream as an empty response.
        const chatModel = {
          // Agent-capable family (the 2026-09-27 capability tier filters
          // mistral-small-* out of every group; this test is about the
          // NON-reasoning first-token timeout, and the fixture stays
          // non-reasoning — no `reasoning`/`thinking` field — so the intent
          // is preserved).
          provider: 'mistral',
          id: 'mistral-medium-3-5',
          api: 'openai-completions',
          contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        };
        const streamSimple = vi.fn((model: any) => {
          return (async function* () {
            await new Promise((r) => setTimeout(r, 500));
            yield { type: 'text_delta', delta: `should never reach here` };
            yield { type: 'done' };
          })();
        });
        const modelRegistry = {
          getAvailable: () => [chatModel],
          find: () => chatModel,
          getApiKeyForProvider: async () => 'fake-key',
          runtime: { streamSimple },
        };
        const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        const events = await drainStream(
          defaultExport.groupStream(
            { provider: 'standard', id: 'standard' },
            { messages: [{ role: 'user', content: 'hi' }] },
            {}
          )
        );

        // The non-reasoning model's late first token must have been detected as
        // a soft failure (empty_timeout). consumeWithDetection doesn't hard-abort
        // the stream (iterPromise keeps running in the background), so a late
        // token CAN leak into the proxy — but the overall stream must end in an
        // error event, not a clean completion, because driveStream records a
        // soft failure and has no other candidate to fall back to (single-candidate
        // group, no fallback). So: assert an error event was emitted.
        const hasError = events.some((e: any) => e.type === 'error');
        expect(hasError).toBe(true);
      } finally {
        cwdSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
        if (hadCache) fs.renameSync(cacheBak, scanCachePath);
      }
    });
  });
});


describe('repetition-loop-detection', () => {
  /**
   * Integration test: the router must detect when a model gets stuck
   * regenerating the same phrase over and over (observed with devstral
   * variants) and treat it as a soft failure, so the group falls over to
   * the next candidate instead of letting the loop burn the whole context
   * window and then retrying the same unhealthy model on the next turn.
   */

  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
  const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

  async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
    const events: AssistantMessageEvent[] = [];
    for await (const ev of stream) events.push(ev);
    return events;
  }

  async function withIsolatedRouter(
    configOverride: Record<string, unknown>,
    fn: (defaultExport: any, tmpDir: string) => Promise<void>
  ) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-repetition-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    const dynBak = `${dynamicConfigPath}.repetition-bak`;
    const cacheBak = `${scanCachePath}.repetition-bak`;
    const hadDyn = fs.existsSync(dynamicConfigPath);
    const hadCache = fs.existsSync(scanCachePath);
    if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
    if (hadCache) fs.renameSync(scanCachePath, cacheBak);

    writeNoOpScanCache(scanCachePath); // make unawaited session_start scan() a no-op (root cause of the "No available models" CI flake)

    try {
      vi.resetModules();
      const mod = await import('../index.ts');
      await fn(mod.default as any, tmpDir);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
      removeNoOpScanCache(scanCachePath);

      if (hadCache) fs.renameSync(cacheBak, scanCachePath);
    }
  }

  describe('driveStream: repetition loop detection', () => {
    it('aborts a looping model and falls over to the next candidate', async () => {
      await withIsolatedRouter(
        {
          free_models: [],
          providers: { openrouter: { free_models: [] } },
          model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
          // Force a deterministic ranking: loopy-model has higher GDPval so
          // it ranks first, healthy-model second. The router must detect the
          // loop and switch to healthy-model instead of letting loopy-model
          // burn the whole context window.
          gdpval_builtin: {
            'loopy-model': 1000,
            'healthy-model': 900,
          },
        },
        async (defaultExport, tmpDir) => {
          const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
          const pi: any = {
            registerTool: vi.fn(),
            registerCommand: vi.fn(),
            registerProvider: vi.fn(),
            setModel: vi.fn(async () => true),
            on: vi.fn((event: string, handler: any) => {
              onHandlers[event] = handler;
            }),
          };
          defaultExport(pi);

          // Two models: loopy-model repeats the same phrase, healthy-model
          // returns a unique response. The router must detect the loop and
          // switch to healthy-model.
          const loopyModel = {
            provider: 'loopy-provider',
            id: 'loopy-model',
            api: 'loopy-api',
            contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
          };
          const healthyModel = {
            provider: 'healthy-provider',
            id: 'healthy-model',
            api: 'healthy-api',
            contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
          };
          const modelsByRef: Record<string, any> = {
            'loopy-provider/loopy-model': loopyModel,
            'healthy-provider/healthy-model': healthyModel,
          };
          const streamSimple = vi.fn((model: any) => {
            if (model.id === 'loopy-model') {
              // Simulate a degenerate repetition loop: the same sentence
              // repeated many times. The detector should catch this and
              // abort the stream before it burns the whole context window.
              const sentence = 'Ich möchte jetzt die Datei bearbeiten und speichern. ';
              return (async function* () {
                for (let i = 0; i < 10; i++) {
                  yield { type: 'text_delta', delta: sentence };
                }
                yield { type: 'done' };
              })();
            }
            if (model.id === 'healthy-model') {
              return (async function* () {
                yield { type: 'text_delta', delta: 'served by the healthy fallback' };
                yield { type: 'done' };
              })();
            }
            return (async function* () {})();
          });
          const modelRegistry = {
            getAvailable: () => [loopyModel, healthyModel],
            find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
            getApiKeyForProvider: async () => null,
            runtime: { streamSimple },
          };
          const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
          await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

          const groupModel = { provider: 'standard', id: 'standard' };
          const context: any = { messages: [{ role: 'user', content: 'edit the file' }] };

          const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

          // Must NOT have emitted an error — the cascade found a healthy model.
          const errEvent = events.find((e: any) => e.type === 'error') as any;
          expect(errEvent).toBeUndefined();

          const text = events
            .filter((e: any) => e.type === 'text_delta')
            .map((e: any) => e.delta ?? '')
            .join('');
          expect(text).toContain('served by the healthy fallback');
          expect(streamSimple).toHaveBeenCalled();
        }
      );
    });
  });
});


describe('reset-msg-fallback', () => {
  /**
   * Regression test: the "(resets HH:MM:SS)" suffix on a rate-limit router-info
   * message previously only appeared when parseResetAtMs successfully parsed a
   * reset time out of THIS specific failure's raw text. Many real rate-limit
   * messages (e.g. "Warning: [rate-limit] Claude five_hour rate limit hit" with
   * no date/time appended) carry no parseable reset time at all — the user was
   * left with a generic "rate limit/spend limit reached" message and no
   * indication of when the model would be available again, even though the
   * router itself set a concrete cooldown via the escalating backoff. Now
   * formatResetMsg falls back to the router's own computed cooldown_until so a
   * wall-clock time is always shown (unless the ref was key-rotated, in which
   * case no cooldown was applied to it at all).
   */

  const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
  const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

  async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
    const events: AssistantMessageEvent[] = [];
    for await (const ev of stream) events.push(ev);
    return events;
  }

  async function withIsolatedRouter(
    configOverride: Record<string, unknown>,
    fn: (defaultExport: any, tmpDir: string) => Promise<void>
  ) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-reset-msg-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    const dynBak = `${dynamicConfigPath}.reset-msg-bak`;
    const cacheBak = `${scanCachePath}.reset-msg-bak`;
    const hadDyn = fs.existsSync(dynamicConfigPath);
    const hadCache = fs.existsSync(scanCachePath);
    if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
    if (hadCache) fs.renameSync(scanCachePath, cacheBak);

    writeNoOpScanCache(scanCachePath);

    try {
      vi.resetModules();
      const mod = await import('../index.ts');
      await fn(mod.default as any, tmpDir);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
      removeNoOpScanCache(scanCachePath);
      if (hadCache) fs.renameSync(cacheBak, scanCachePath);
    }
  }

  describe('driveStream: rate-limit reset-time messaging fallback', () => {
    it('shows a computed "(resets ...)" wall-clock time even when the failure text has no parseable reset time', async () => {
      await withIsolatedRouter(
        {
          free_models: [],
          providers: { openrouter: { free_models: [] } },
          rate_limit_wait_max_ms: 0,
          model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
          gdpval_builtin: { 'rate-limited-model': 1000 },
        },
        async (defaultExport, tmpDir) => {
          const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
          const pi: any = {
            registerTool: vi.fn(),
            registerCommand: vi.fn(),
            registerProvider: vi.fn(),
            setModel: vi.fn(async () => true),
            on: vi.fn((event: string, handler: any) => {
              onHandlers[event] = handler;
            }),
          };
          defaultExport(pi);

          const model = {
            provider: 'some-provider',
            id: 'rate-limited-model',
            api: 'openai-completions',
            contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
          };
          const modelsByRef: Record<string, any> = {
            'some-provider/rate-limited-model': model,
          };
          const streamSimple = vi.fn(() => {
            return (async function* () {
              // No date/time appended — matches neither parseResetAtMs format.
              yield {
                type: 'error',
                error: { errorMessage: 'Warning: [rate-limit] Claude five_hour rate limit hit' },
              };
            })();
          });
          const modelRegistry = {
            getAvailable: () => [model],
            find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
            getApiKeyForProvider: async () => null,
            runtime: { streamSimple },
          };
          const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
          await onHandlers['session_start']?.({}, ctx);
          await flushBackgroundScan();

          const groupModel = { provider: 'standard', id: 'standard' };
          const context: any = { messages: [{ role: 'user', content: 'do the thing' }] };

          const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

          const routerInfoText = events
            .filter((e: any) => e.type === 'text_delta')
            .map((e: any) => e.delta ?? '')
            .join('');

          expect(routerInfoText).toContain('rate limit/spend limit reached');
          // The fallback: even with no parseable reset time in the raw text,
          // the router's own computed cooldown must still be surfaced as a
          // wall-clock time — worded as OUR backoff, not as a provider reset
          // the provider never announced (2026-10-03 honesty fix).
          expect(routerInfoText).toMatch(/\(backing off [0-9hms ]+, until \d{2}:\d{2}\)/);
        }
      );
    }, 30000);

    // roborev job 388 LOW: formatResetMsg is called from 3 separate sites with
    // independently-wired ref/rotated arguments; the rate_limit_exceeded branch
    // above only exercises one of them. This covers the isPaidCloudRateLimitFailure
    // soft-failure branch (a PAID cloud model hitting provider_error, escalated
    // to the hard-cooldown "likely rate limit" wording).
    it('also shows a computed "(backing off until ...)" time on the paid-cloud provider_error branch', async () => {
      await withIsolatedRouter(
        {
          free_models: [],
          providers: { openrouter: { free_models: [] } },
          rate_limit_wait_max_ms: 0,
          model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
          gdpval_builtin: { 'paid-model': 1000 },
        },
        async (defaultExport, tmpDir) => {
          const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
          const pi: any = {
            registerTool: vi.fn(),
            registerCommand: vi.fn(),
            registerProvider: vi.fn(),
            setModel: vi.fn(async () => true),
            on: vi.fn((event: string, handler: any) => {
              onHandlers[event] = handler;
            }),
          };
          defaultExport(pi);

          // No ":free" suffix and not ollama/lm-studio — a paid cloud model.
          const paidModel = {
            provider: 'paid-cloud-provider',
            id: 'paid-model',
            api: 'openai-completions',
            contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
          };
          const modelsByRef: Record<string, any> = {
            'paid-cloud-provider/paid-model': paidModel,
          };
          const streamSimple = vi.fn(() => {
            return (async function* () {
              yield {
                type: 'error',
                // Rate-limit-shaped provider error (HTTP 429, no parseable
                // reset time). Since the 2026-09-27 422 fix only such text
                // takes the hard-cooldown path; a bare provider_error stays
                // soft and would never reach the reset-message fallback this
                // test pins.
                error: { errorMessage: '429 too many requests' },
              };
            })();
          });
          const modelRegistry = {
            getAvailable: () => [paidModel],
            find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
            getApiKeyForProvider: async () => null,
            runtime: { streamSimple },
          };
          const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
          await onHandlers['session_start']?.({}, ctx);
          await flushBackgroundScan();

          const groupModel = { provider: 'standard', id: 'standard' };
          const context: any = { messages: [{ role: 'user', content: 'do the thing' }] };

          const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

          const routerInfoText = events
            .filter((e: any) => e.type === 'text_delta')
            .map((e: any) => e.delta ?? '')
            .join('');

          expect(routerInfoText).toContain('likely rate limit');
          expect(routerInfoText).toMatch(/\(backing off [0-9hms ]+, until \d{2}:\d{2}\)/);
        }
      );
    }, 30000);
  });
});


describe('skip-failure-malus', () => {
  /**
   * Regression test: a candidate that tryStream() skips (returns null instead
   * of throwing — e.g. "not registered in Pi's model registry", "no API key")
   * must still count as a failure.
   *
   * Bug: driveStream's `if (!target) { ...; continue; }` branch recorded the
   * skip reason for the error message but never called recordSoftFailure().
   * A structurally-broken candidate (never becomes usable mid-session) was
   * therefore retried from scratch on every single request forever — no
   * cooldown, no model-health malus. In one long-running session this produced
   * over a million identical "not registered" log lines in ~17h.
   *
   * This test reproduces the skip path (registry lists the model but find()
   * can't resolve it — the same inconsistency real free-tier models hit when
   * their provider has no active key) and asserts the second attempt is
   * short-circuited by the cooldown recorded on the first.
   *
   * A project-local override config (free_models: [], standard.fallback_groups:
   * []) isolates the group to exactly one candidate, so the assertion doesn't
   * depend on the router's real free-model list or fallback cascade depth.
   */

  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
  const dynamicConfigBackupPath = `${dynamicConfigPath}.skip-malus-test-bak`;
  const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

  async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
    const events: AssistantMessageEvent[] = [];
    for await (const ev of stream) events.push(ev);
    return events;
  }

  // Collects every bit of text the router pushed to the stream — the final
  // error event's content, plus any "> [router] ..." info lines pushed along
  // the way — so assertions aren't limited to whichever group ends the cascade.
  function allText(events: AssistantMessageEvent[]): string {
    return events
      .map((e: any) => {
        if (e.type === 'error') {
          const content = e.error?.content;
          return Array.isArray(content) ? content.map((c: any) => c.text ?? '').join('\n') : '';
        }
        if (e.type === 'text_delta') return e.delta ?? '';
        return '';
      })
      .join('\n');
  }

  describe('driveStream: skipped (not-thrown) candidates accrue a malus', () => {
    it('a second attempt on a structurally-unusable candidate is short-circuited by cooldown', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-skip-malus-'));
      fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.pi', 'router-config.json'),
        JSON.stringify({
          free_models: [],
          // phantom-provider is deliberately find()=null ("available but not
          // registered"). The bundled router-config.json leaks max_cost:5.0 into
          // this group; an unknown-cost pay_per_token model would be dropped at
          // the filter stage and never reach driveStream's "not registered" skip
          // path this test exercises. billing:subscription marks it as sunk-cost
          // so applyGroupFilters keeps it.
          providers: { 'phantom-provider': { billing: 'subscription' } },
          rate_limit_wait_max_ms: 0,
          model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        })
      );
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      if (fs.existsSync(dynamicConfigPath)) fs.renameSync(dynamicConfigPath, dynamicConfigBackupPath);

      writeNoOpScanCache(scanCachePath); // make unawaited session_start scan() a no-op (root cause of the "No available models" CI flake)
      try {
        vi.resetModules();
        const mod = await import('../index.ts');
        const defaultExport = mod.default as any;

        const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
        const pi: any = {
          registerTool: vi.fn(),
          registerCommand: vi.fn(),
          registerProvider: vi.fn(),
          setModel: vi.fn(async () => true),
          on: vi.fn((event: string, handler: any) => {
            onHandlers[event] = handler;
          }),
        };
        defaultExport(pi);

        // Listed as "available" (so it becomes a candidate) but unresolvable via
        // find() — the exact inconsistency tryStream's "not registered" guard
        // exists for.
        const phantomModel = { provider: 'phantom-provider', id: 'claude-sonnet-4-6', api: 'phantom-api' };
        const modelRegistry = {
          getAvailable: () => [phantomModel],
          find: () => null,
          getApiKeyForProvider: async () => null,
          runtime: { streamSimple: () => (async function* () {})() },
        };
        const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        const groupModel = { provider: 'standard', id: 'standard' };
        const context: any = { messages: [{ role: 'user', content: 'hello' }] };

        const events1 = await drainStream(defaultExport.groupStream(groupModel, context, {}));
        const text1 = allText(events1);
        expect(text1).toContain('not registered in Pi');

        // A second, independent turn. Without the fix, tryStream is re-entered
        // for the phantom ref every time — "not registered" would appear again
        // here too, forever. With the fix, the cooldown recorded on attempt 1
        // short-circuits attempt 2 via isLimited() before tryStream ever runs.
        // (A cooldown-skip deliberately does not call recordSoftFailure again —
        // that would double-count the same underlying failure — so the streak
        // itself stays at 1; the cooldown persisting is the actual proof here.)
        const events2 = await drainStream(defaultExport.groupStream(groupModel, context, {}));
        const text2 = allText(events2);
        expect(text2).toContain('still in cooldown');
        expect(text2).not.toContain('not registered in Pi');
      } finally {
        cwdSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        removeNoOpScanCache(scanCachePath);

        if (fs.existsSync(dynamicConfigBackupPath)) fs.renameSync(dynamicConfigBackupPath, dynamicConfigPath);
      }
    });
  });
});


describe('stall-timeout-detection', () => {
  /**
   * Integration test: the router must detect a mid-stream stall — a model that
   * emits some content, then goes silent forever (connection open, no error, no
   * close, no further events) — and treat it as a soft failure so the group
   * falls over to the next candidate, instead of hanging the whole session
   * indefinitely.
   *
   * Root cause this guards against: consumeWithDetection() used to clear the
   * timeout timer on the first content token and never re-arm it. A stream that
   * opened, emitted content, then went silent (observed with free/rate-limited
   * OpenRouter proxies like cohere/north-mini-code:free) left the for-await loop
   * blocked forever — no error, no timeout, no fallback. The user had to
   * hard-kill Pi to recover.
   *
   * Fix: the stall timer is now (re)armed on every received event, so both the
   * first-token window AND a mid-stream stall trip the same timer. A stall after
   * content is reported as `stall_timeout` (distinct from `empty_timeout`).
   */

  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
  const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

  async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
    const events: AssistantMessageEvent[] = [];
    for await (const ev of stream) events.push(ev);
    return events;
  }

  async function withIsolatedRouter(
    configOverride: Record<string, unknown>,
    fn: (defaultExport: any, tmpDir: string) => Promise<void>
  ) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-stall-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    const dynBak = `${dynamicConfigPath}.stall-bak`;
    const cacheBak = `${scanCachePath}.stall-bak`;
    const hadDyn = fs.existsSync(dynamicConfigPath);
    const hadCache = fs.existsSync(scanCachePath);
    if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
    if (hadCache) fs.renameSync(scanCachePath, cacheBak);

    writeNoOpScanCache(scanCachePath);

    try {
      vi.resetModules();
      const mod = await import('../index.ts');
      await fn(mod.default as any, tmpDir);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
      removeNoOpScanCache(scanCachePath);
      if (hadCache) fs.renameSync(cacheBak, scanCachePath);
    }
  }

  describe('driveStream: mid-stream stall detection', () => {
    it('aborts a model that goes silent after emitting content and falls over to the next candidate', async () => {
      await withIsolatedRouter(
        {
          free_models: [],
          providers: { openrouter: { free_models: [] } },
          model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
          // Deterministic ranking: stalling-model ranks first, healthy-model
          // second. The router must detect the stall and switch.
          gdpval_builtin: {
            'stalling-model': 1000,
            'healthy-model': 900,
          },
          // Short timeouts so the test resolves quickly. The stall is simulated
          // by a stream that emits one token then never yields again (and never
          // closes). BOTH the first-token window and the mid-stream inactivity
          // window must be short here — the re-armed inactivity timer fires within
          // the stall window after the stream goes silent.
          empty_response_timeout_ms: 300,
          reasoning_empty_response_timeout_ms: 300,
          stall_timeout_ms: 300,
        },
        async (defaultExport, tmpDir) => {
          const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
          const pi: any = {
            registerTool: vi.fn(),
            registerCommand: vi.fn(),
            registerProvider: vi.fn(),
            setModel: vi.fn(async () => true),
            on: vi.fn((event: string, handler: any) => {
              onHandlers[event] = handler;
            }),
          };
          defaultExport(pi);

          const stallingModel = {
            provider: 'stalling-provider',
            id: 'stalling-model',
            api: 'stalling-api',
            contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
          };
          const healthyModel = {
            provider: 'healthy-provider',
            id: 'healthy-model',
            api: 'healthy-api',
            contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
          };
          const modelsByRef: Record<string, any> = {
            'stalling-provider/stalling-model': stallingModel,
            'healthy-provider/healthy-model': healthyModel,
          };
          const streamSimple = vi.fn((model: any) => {
            if (model.id === 'stalling-model') {
              // Simulate a mid-stream stall: emit one content token, then go
              // silent forever. The connection never closes, no error is
              // emitted — the generator just blocks on a promise that never
              // resolves. Without the re-armed stall timer, the for-await loop
              // would block indefinitely.
              return (async function* () {
                yield { type: 'text_delta', delta: 'starting...' };
                // Hang forever — never yields again, never returns.
                await new Promise(() => {}); // never resolves
              })();
            }
            if (model.id === 'healthy-model') {
              return (async function* () {
                yield { type: 'text_delta', delta: 'served by the healthy fallback' };
                yield { type: 'done' };
              })();
            }
            return (async function* () {})();
          });
          const modelRegistry = {
            getAvailable: () => [stallingModel, healthyModel],
            find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
            getApiKeyForProvider: async () => null,
            runtime: { streamSimple },
          };
          const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
          await onHandlers['session_start']?.({}, ctx);
          await flushBackgroundScan();

          const groupModel = { provider: 'standard', id: 'standard' };
          const context: any = { messages: [{ role: 'user', content: 'edit the file' }] };

          // Must resolve (not hang). If the stall timer isn't re-armed, this
          // await never returns and the test times out.
          const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

          // Must NOT have emitted a hard error — the cascade found a healthy model.
          const errEvent = events.find((e: any) => e.type === 'error') as any;
          expect(errEvent).toBeUndefined();

          // The healthy fallback's content must have made it through.
          const text = events
            .filter((e: any) => e.type === 'text_delta')
            .map((e: any) => e.delta ?? '')
            .join('');
          expect(text).toContain('served by the healthy fallback');
          expect(streamSimple).toHaveBeenCalled();
        }
      );
    }, 30000);
  });
});


describe('summarization-error-message', () => {
  /**
   * Regression test for the "Summarization failed: Unknown error" bug.
   *
   * pi-coding-agent's compaction/branch-summary path calls
   * `getSummarizationFailure(response, label)`, which reads *only*
   * `response.errorMessage` (never `content[0].text`):
   *
   *   return `${label} failed: ${response.errorMessage || "Unknown error"}`;
   *
   * Before this fix, driveStream's "all candidates failed" / "dynamic routing
   * failed" / catch-all error paths called `pushStreamError(proxy, detailText)`
   * without a third `errorMessage` argument, so `buildErrorAssistantMessage`
   * omitted the field entirely and the user always saw "Unknown error" even
   * though the router had a detailed, multi-line failure reason.
   *
   * The fix must NOT simply echo the raw failureList into errorMessage: pi-ai's
   * `isRetryableAssistantError` (used by `retryAssistantCall`, the wrapper
   * compaction/branch-summary calls use) treats any errorMessage matching its
   * RETRYABLE_PROVIDER_ERROR_PATTERN (timeout, rate.?limit, network.?error,
   * 5xx, ...) as transient and re-invokes the *entire* candidate cascade up to
   * maxRetries times. Since real failureList text routinely contains those
   * exact words (rate_limit_exceeded, empty_timeout, stall_timeout), echoing it
   * verbatim would turn an already multi-minute fallback cascade into a
   * multi-attempt retry storm — the likely cause of "pi hangs in working mode,
   * user has to Ctrl-C" reports during compaction.
   *
   * This test asserts both properties: errorMessage is non-empty (fixes
   * "Unknown error"), and it is classified as non-retryable by pi-ai's own
   * classifier (guards against the retry-storm regression).
   */

  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
  const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

  async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
    const events: AssistantMessageEvent[] = [];
    for await (const ev of stream) events.push(ev);
    return events;
  }

  async function withIsolatedRouter(
    configOverride: Record<string, unknown>,
    fn: (defaultExport: any, tmpDir: string) => Promise<void>
  ) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-summ-err-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    const dynBak = `${dynamicConfigPath}.summ-err-bak`;
    const cacheBak = `${scanCachePath}.summ-err-bak`;
    const hadDyn = fs.existsSync(dynamicConfigPath);
    const hadCache = fs.existsSync(scanCachePath);
    if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
    if (hadCache) fs.renameSync(scanCachePath, cacheBak);

    writeNoOpScanCache(scanCachePath);

    try {
      vi.resetModules();
      const mod = await import('../index.ts');
      await fn(mod.default as any, tmpDir);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
      removeNoOpScanCache(scanCachePath);
      if (hadCache) fs.renameSync(cacheBak, scanCachePath);
    }
  }

  describe('driveStream: all-candidates-failed errorMessage', () => {
    it('populates a non-empty, non-retryable errorMessage instead of leaving it undefined', async () => {
      await withIsolatedRouter(
        {
          free_models: [],
          providers: { openrouter: { free_models: [] } },
          rate_limit_wait_max_ms: 0,
          model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
          gdpval_builtin: { 'broken-model': 1000 },
        },
        async (defaultExport, tmpDir) => {
          const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
          const pi: any = {
            registerTool: vi.fn(),
            registerCommand: vi.fn(),
            registerProvider: vi.fn(),
            setModel: vi.fn(async () => true),
            on: vi.fn((event: string, handler: any) => {
              onHandlers[event] = handler;
            }),
          };
          defaultExport(pi);

          const brokenModel = {
            provider: 'broken-provider',
            id: 'broken-model',
            api: 'openai-completions',
            contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
          };
          const modelsByRef: Record<string, any> = {
            'broken-provider/broken-model': brokenModel,
          };
          // Fails immediately with a raw provider error whose text contains
          // classic RETRYABLE_PROVIDER_ERROR_PATTERN trigger words
          // (rate_limit_exceeded contains "rate limit", the reason itself is
          // literally a timeout) — this is exactly the kind of text that must
          // NOT leak verbatim into the final errorMessage.
          const streamSimple = vi.fn(() => {
            return (async function* () {
              yield {
                type: 'error',
                error: { errorMessage: 'Provider finish_reason: error (rate_limit_exceeded, timeout)' },
              };
            })();
          });
          const modelRegistry = {
            getAvailable: () => [brokenModel],
            find: (provider: string, modelId: string) =>
              modelsByRef[`${provider}/${modelId}`] ?? null,
            getApiKeyForProvider: async () => null,
            runtime: { streamSimple },
          };
          const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
          await onHandlers['session_start']?.({}, ctx);
          await flushBackgroundScan();

          const groupModel = { provider: 'standard', id: 'standard' };
          const context: any = { messages: [{ role: 'user', content: 'do the thing' }] };

          const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

          const errEvent = events.find((e: any) => e.type === 'error') as any;
          expect(errEvent).toBeDefined();
          const message = errEvent.error;

          // Fixes "Summarization failed: Unknown error" — getSummarizationFailure()
          // reads exactly this field.
          expect(message.errorMessage).toBeTruthy();
          expect(message.errorMessage).not.toBe('Unknown error');

          // Guards against the retry-storm regression: pi-ai's own classifier must
          // NOT consider this errorMessage transient, or compaction/branch-summary
          // callers would re-run the whole (already-exhausted) candidate cascade
          // up to maxRetries times instead of failing fast.
          expect(isRetryableAssistantError(message)).toBe(false);

          // The full diagnostic detail (including the trigger words) must still be
          // visible somewhere for debugging — in the chat-visible text, not thrown away.
          expect(message.content[0].text).toContain('rate_limit_exceeded');
        }
      );
    }, 30000);
  });
});


describe('truncated-length', () => {
  /**
   * Integration test: the router must detect a stream that ends with
   * stopReason 'length' (max output tokens hit — the answer is truncated and
   * the task is incomplete) and treat it as a soft failure so the group falls
   * over to the next candidate, instead of reporting success.
   *
   * Root cause this guards against: consumeWithDetection() used to classify
   * EVERY cleanly-ending stream with content as { ok: true } — the `done`
   * event's `reason` field ('stop' | 'length' | 'toolUse') was never inspected.
   * A model that hits max_tokens mid-task (observed with
   * mistral/mistral-small-latest, 2026-09-27: "it just stops, says nothing
   * more, never finishes the task") therefore recorded a SUCCESS: no cooldown,
   * no soft-failure accumulation, no fallback to the next candidate — and the
   * same broken model was picked again on the next turn.
   *
   * Fix: the done event is now intercepted; reason 'length' is classified as a
   * new soft failure `truncated_length` (narration + recordSoftFailure + next
   * candidate), and every terminal stopReason is logged to router.log so the
   * "lazy 'stop'" variant of the failure remains diagnosable.
   */

  const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
  const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

  async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
    const events: AssistantMessageEvent[] = [];
    for await (const ev of stream) events.push(ev);
    return events;
  }

  async function withIsolatedRouter(
    configOverride: Record<string, unknown>,
    fn: (defaultExport: any, tmpDir: string) => Promise<void>
  ) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-trunc-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    const dynBak = `${dynamicConfigPath}.trunc-bak`;
    const cacheBak = `${scanCachePath}.trunc-bak`;
    const hadDyn = fs.existsSync(dynamicConfigPath);
    const hadCache = fs.existsSync(scanCachePath);
    if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
    if (hadCache) fs.renameSync(scanCachePath, cacheBak);

    writeNoOpScanCache(scanCachePath);

    try {
      vi.resetModules();
      const mod = await import('../index.ts');
      await fn(mod.default as any, tmpDir);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
      removeNoOpScanCache(scanCachePath);
      if (hadCache) fs.renameSync(cacheBak, scanCachePath);
    }
  }

  describe('driveStream: stopReason length interception', () => {
    it('treats a stream ending with done.reason "length" as truncated_length and falls over to the next candidate', async () => {
      await withIsolatedRouter(
        {
          free_models: [],
          providers: { openrouter: { free_models: [] } },
          model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
          // Deterministic ranking: truncating-model ranks first, healthy-model
          // second — same convention as the stall test (higher gdpval first).
          gdpval_builtin: {
            'truncating-model': 1000,
            'healthy-model': 900,
          },
          // Short first-token window so the test resolves quickly. The stall
          // window is irrelevant here: the truncated stream ends CLEANLY (no
          // stall), so only the empty-response window bounds a hang if the
          // interception were broken and the stream never yielded content.
          empty_response_timeout_ms: 300,
          reasoning_empty_response_timeout_ms: 300,
          stall_timeout_ms: 5000,
        },
        async (defaultExport) => {
          const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
          const pi: any = {
            registerTool: vi.fn(),
            registerCommand: vi.fn(),
            registerProvider: vi.fn(),
            setModel: vi.fn(async () => true),
            on: vi.fn((event: string, handler: any) => {
              onHandlers[event] = handler;
            }),
          };
          defaultExport(pi);

          const truncatingModel = {
            provider: 'truncating-provider',
            id: 'truncating-model',
            api: 'truncating-api',
            contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
          };
          const healthyModel = {
            provider: 'healthy-provider',
            id: 'healthy-model',
            api: 'healthy-api',
            contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
          };
          const modelsByRef: Record<string, any> = {
            'truncating-provider/truncating-model': truncatingModel,
            'healthy-provider/healthy-model': healthyModel,
          };
          const streamSimple = vi.fn((model: any) => {
            if (model.id === 'truncating-model') {
              // Simulate max_tokens truncation: content streams, then the
              // stream ends cleanly with done.reason === 'length'. No error,
              // no stall — the pre-fix watcher classified this as success.
              return (async function* () {
                yield { type: 'text_delta', delta: 'Half a sentence, cut off mid-' };
                yield { type: 'done', reason: 'length' };
              })();
            }
            if (model.id === 'healthy-model') {
              return (async function* () {
                yield { type: 'text_delta', delta: 'served by the healthy fallback' };
                yield { type: 'done', reason: 'stop' };
              })();
            }
            return (async function* () {})();
          });
          const modelRegistry = {
            getAvailable: () => [truncatingModel, healthyModel],
            find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
            getApiKeyForProvider: async () => null,
            runtime: { streamSimple },
          };
          const ctx: any = { modelRegistry, cwd: os.tmpdir(), ui: { setFooter: vi.fn() } };
          await onHandlers['session_start']?.({}, ctx);
          await flushBackgroundScan();

          const groupModel = { provider: 'standard', id: 'standard' };
          const context: any = { messages: [{ role: 'user', content: 'edit the file' }] };

          const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

          // Must NOT have emitted a hard error — the cascade found a healthy model.
          const errEvent = events.find((e: any) => e.type === 'error') as any;
          expect(errEvent).toBeUndefined();

          // The healthy fallback's content must have made it through.
          const text = events
            .filter((e: any) => e.type === 'text_delta')
            .map((e: any) => e.delta ?? '')
            .join('');
          expect(text).toContain('served by the healthy fallback');

          // The router must have narrated the truncation (not silently succeeded).
          expect(text).toContain('output truncated at max tokens');

          // Both candidates were actually streamed: the truncating one first,
          // then the healthy one — proving the fallback path fired.
          expect(streamSimple).toHaveBeenCalledTimes(2);
        }
      );
    }, 30000);

    it('does NOT flag a stream ending with done.reason "stop" — normal completion stays a success', async () => {
      await withIsolatedRouter(
        {
          free_models: [],
          providers: { openrouter: { free_models: [] } },
          model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
          gdpval_builtin: {
            'normal-model': 1000,
            'unused-model': 900,
          },
          empty_response_timeout_ms: 300,
          reasoning_empty_response_timeout_ms: 300,
          stall_timeout_ms: 5000,
        },
        async (defaultExport) => {
          const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
          const pi: any = {
            registerTool: vi.fn(),
            registerCommand: vi.fn(),
            registerProvider: vi.fn(),
            setModel: vi.fn(async () => true),
            on: vi.fn((event: string, handler: any) => {
              onHandlers[event] = handler;
            }),
          };
          defaultExport(pi);

          const normalModel = {
            provider: 'normal-provider',
            id: 'normal-model',
            api: 'normal-api',
            contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
          };
          const modelsByRef: Record<string, any> = {
            'normal-provider/normal-model': normalModel,
          };
          const streamSimple = vi.fn((model: any) => {
            if (model.id === 'normal-model') {
              return (async function* () {
                yield { type: 'text_delta', delta: 'complete answer' };
                yield { type: 'done', reason: 'stop' };
              })();
            }
            return (async function* () {})();
          });
          const modelRegistry = {
            getAvailable: () => [normalModel],
            find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
            getApiKeyForProvider: async () => null,
            runtime: { streamSimple },
          };
          const ctx: any = { modelRegistry, cwd: os.tmpdir(), ui: { setFooter: vi.fn() } };
          await onHandlers['session_start']?.({}, ctx);
          await flushBackgroundScan();

          const groupModel = { provider: 'standard', id: 'standard' };
          const context: any = { messages: [{ role: 'user', content: 'say something' }] };

          const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

          const errEvent = events.find((e: any) => e.type === 'error') as any;
          expect(errEvent).toBeUndefined();

          const text = events
            .filter((e: any) => e.type === 'text_delta')
            .map((e: any) => e.delta ?? '')
            .join('');
          expect(text).toContain('complete answer');

          // Exactly ONE stream: a normal 'stop' completion must not trigger
          // any fallback (no second candidate, no truncation narration).
          expect(streamSimple).toHaveBeenCalledTimes(1);
          expect(text).not.toContain('output truncated');
        }
      );
    }, 30000);
  });
});
