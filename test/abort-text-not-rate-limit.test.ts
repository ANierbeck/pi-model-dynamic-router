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
import { describe, it, expect, vi } from 'vitest';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireRouterStateLock,
  releaseRouterStateLock,
  writeNoOpScanCache,
  removeNoOpScanCache,
  flushBackgroundScan,
} from './helpers/router-state-lock.ts';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dynamicConfigPath = path.join(repoRoot, 'router-config.dynamic.json');
const scanCachePath = path.join(repoRoot, '.cache', 'scan-cache.json');

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
  await acquireRouterStateLock();
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
    releaseRouterStateLock();
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
          contextWindow: 1_000_000,
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
  }, 15000);
});
