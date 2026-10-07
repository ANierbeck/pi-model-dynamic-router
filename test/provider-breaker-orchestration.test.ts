// test/provider-breaker-orchestration.test.ts
// Phase 2 of the provider circuit breaker plan
// (docs/plans/2026-10-06-provider-circuit-breaker.md): driveStream feeds
// provider-level evidence to the breaker for CLOUD providers too (D1/D2),
// skips the tripped provider's remaining candidates within the SAME walk
// (D3, the intra-walk short-circuit) and never dead-ends when every
// candidate sits behind an open breaker (D4 — a forced half-open probe of
// the soonest-expiring breaker instead of "all candidates failed").
//
// The four cases are the plan's Phase 2 red-first list, verbatim:
//   1. 4 models of provider X return empty → the third failure trips, the
//      4th is skipped in the same walk, a provider Y candidate still answers;
//   2. ALL candidates belong to a tripped provider → forced half-open probe
//      instead of "all candidates failed";
//   3. 400/422 errors from 3 models do NOT trip;
//   4. a rate-limit-shaped empty response (parsed reset time) does NOT trip.

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

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function drainStream(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

/**
 * Boots the extension in an isolated tmp project (own router-config.json,
 * no-op scan cache, stubbed model registry) and hands the caller the
 * defaultExport plus the captured session_start handler wiring. Mirrors the
 * harness of test/provider-watchdog-integration.test.ts.
 */
async function withIsolatedRouter(
  configOverride: Record<string, unknown>,
  models: unknown[],
  fn: (helpers: {
    groupStream: (model: any, context: any, options: any) => AsyncIterable<AssistantMessageEvent>;
    streamSimple: ReturnType<typeof vi.fn>;
  }) => Promise<void>
): Promise<void> {
  const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-breaker-orch-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  writeNoOpScanCache(scanCachePath);
  try {
    vi.resetModules();
    const mod = await import('../index.ts');
    const defaultExport: any = mod.default;
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
    const streamSimple = vi.fn();
    const modelRegistry = {
      getAvailable: () => models,
      find: (provider: string, id: string) =>
        models.find((m: any) => m.provider === provider && m.id === id) ?? null,
      getApiKeyForProvider: async () => 'k',
      runtime: { streamSimple },
    };
    const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
    await onHandlers['session_start']?.({}, ctx);
    await flushBackgroundScan();

    await fn({
      groupStream: (model: any, context: any, options: any) =>
        defaultExport.groupStream(model, context, options) as AsyncIterable<AssistantMessageEvent>,
      streamSimple,
    });
  } finally {
    cwdSpy.mockRestore();
    removeNoOpScanCache(scanCachePath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Model stub for the registry: cloud provider, large context, paid pricing. */
function cloudModel(provider: string, id: string) {
  return {
    provider,
    id,
    api: 'openai-completions',
    contextWindow: 1_000_000,
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
  };
}

const BASE_CONFIG = {
  free_models: [],
  rate_limit_wait_max_ms: 0,
  model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
};

/** Streams: empty (stopReason stop, 0 chars), error event, success. */
const emptyStream = () =>
  (async function* () {
    yield { type: 'done' };
  })();
const errorStream = (message: string) =>
  (async function* () {
    yield { type: 'error', error: { errorMessage: message } };
  })();
const successStream = (text: string) =>
  (async function* () {
    yield { type: 'text_delta', delta: text };
    yield { type: 'done' };
  })();

function streamText(events: AssistantMessageEvent[]): string {
  return events.filter((e: any) => e.type === 'text_delta').map((e: any) => e.delta ?? '').join('');
}

/** Full text of the terminal error event(s): the failure-line block (content) plus the short message. */
function streamErrorText(events: AssistantMessageEvent[]): string {
  return events
    .filter((e: any) => e.type === 'error')
    .map((e: any) => {
      const content = Array.isArray(e.error?.content)
        ? e.error.content.map((c: any) => String(c?.text ?? '')).join('')
        : '';
      return `${content}\n${String(e.error?.errorMessage ?? '')}`;
    })
    .join('\n');
}

describe('driveStream: cloud provider breaker wiring (plan Phase 2)', () => {
  it(
    'case 1 — four empty responses of one cloud provider: the third trips, the fourth is skipped in the same walk, a spare provider answers',
    async () => {
      await withIsolatedRouter(
        {
          ...BASE_CONFIG,
          gdpval_builtin: { 'x-1': 1000, 'x-2': 990, 'x-3': 980, 'x-4': 970, 'y-1': 900 },
        },
        [
          cloudModel('wedge-provider', 'x-1'),
          cloudModel('wedge-provider', 'x-2'),
          cloudModel('wedge-provider', 'x-3'),
          cloudModel('wedge-provider', 'x-4'),
          cloudModel('spare-provider', 'y-1'),
        ],
        async ({ groupStream, streamSimple }) => {
          streamSimple.mockImplementation((model: any) => {
            if (model.provider === 'wedge-provider') return emptyStream();
            return successStream('spare provider answered');
          });

          const events = await drainStream(
            await Promise.resolve(groupStream({ provider: 'standard', id: 'standard' }, { messages: [{ role: 'user', content: 'do the thing' }] }, {}))
          );
          const text = streamText(events);

          expect(text).toContain('spare provider answered');
          // D3: the fourth candidate of the tripped provider never reached
          // the provider — skipped within the same walk.
          const attempted = streamSimple.mock.calls.map((c: any[]) => c[0].id);
          expect(attempted).toEqual(['x-1', 'x-2', 'x-3', 'y-1']);
          // Narration fires exactly once per open (D6).
          expect(text).toContain('wedge-provider looks wedged');
          expect(countOccurrences(text, 'looks wedged')).toBe(1);
        }
      );
    },
    30_000
  );

  it(
    'case 2 — every candidate sits behind the open breaker: forced half-open probe answers instead of "all candidates failed"',
    async () => {
      await withIsolatedRouter(
        {
          ...BASE_CONFIG,
          gdpval_builtin: { 'x-1': 1000, 'x-2': 990, 'x-3': 980, 'x-4': 970 },
        },
        [
          cloudModel('wedge-provider', 'x-1'),
          cloudModel('wedge-provider', 'x-2'),
          cloudModel('wedge-provider', 'x-3'),
          cloudModel('wedge-provider', 'x-4'),
        ],
        async ({ groupStream, streamSimple }) => {
          let x1Calls = 0;
          streamSimple.mockImplementation((model: any) => {
            if (model.id === 'x-1') {
              x1Calls++;
              // The wedge cleared by the time the forced probe re-attempts
              // the highest-ranked candidate.
              if (x1Calls === 2) return successStream('probe recovered');
            }
            return emptyStream();
          });

          const events = await drainStream(
            await Promise.resolve(groupStream({ provider: 'standard', id: 'standard' }, { messages: [{ role: 'user', content: 'do the thing' }] }, {}))
          );
          const text = streamText(events);

          // D4: the probe was attempted (x-1 twice) and its answer won —
          // no terminal "all candidates failed" error event.
          expect(x1Calls).toBe(2);
          expect(text).toContain('probe recovered');
          expect(text).toContain('probing wedged provider');
          expect(streamErrorText(events)).not.toContain('candidate(s) failed');
        }
      );
    },
    30_000
  );

  it(
    'case 2b — a failed forced probe is labeled "probing wedged provider" in the error aggregation',
    async () => {
      await withIsolatedRouter(
        {
          ...BASE_CONFIG,
          gdpval_builtin: { 'x-1': 1000, 'x-2': 990, 'x-3': 980, 'x-4': 970 },
        },
        [
          cloudModel('wedge-provider', 'x-1'),
          cloudModel('wedge-provider', 'x-2'),
          cloudModel('wedge-provider', 'x-3'),
          cloudModel('wedge-provider', 'x-4'),
        ],
        async ({ groupStream, streamSimple }) => {
          streamSimple.mockImplementation(() => emptyStream());

          const events = await drainStream(
            await Promise.resolve(groupStream({ provider: 'standard', id: 'standard' }, { messages: [{ role: 'user', content: 'do the thing' }] }, {}))
          );
          const text = streamText(events);

          // The probe ran (x-1 attempted twice) and its failure is labeled
          // as the forced half-open probe in the terminal error aggregation.
          expect(streamSimple.mock.calls.filter((c: any[]) => c[0].id === 'x-1')).toHaveLength(2);
          expect(text).toContain('probing wedged provider');
          const errText = streamErrorText(events);
          expect(errText).toContain('candidate(s) failed');
          expect(errText).toContain('probing wedged provider');
        }
      );
    },
    30_000
  );

  it(
    'case 3 — 400/422/404 errors from three models of one provider do NOT trip the breaker',
    async () => {
      await withIsolatedRouter(
        {
          ...BASE_CONFIG,
          gdpval_builtin: { 'x-1': 1000, 'x-2': 990, 'x-3': 980, 'y-1': 900 },
        },
        [
          cloudModel('wedge-provider', 'x-1'),
          cloudModel('wedge-provider', 'x-2'),
          cloudModel('wedge-provider', 'x-3'),
          cloudModel('spare-provider', 'y-1'),
        ],
        async ({ groupStream, streamSimple }) => {
          const errors: Record<string, string> = {
            'x-1': '400 {"message":"Reasoning prompt mode is not enabled for this model"}',
            'x-2': '422 status code (no body)',
            'x-3': '404 model not found',
          };
          streamSimple.mockImplementation((model: any) => {
            if (errors[model.id]) return errorStream(errors[model.id]);
            return successStream('spare provider answered');
          });

          const events = await drainStream(
            await Promise.resolve(groupStream({ provider: 'standard', id: 'standard' }, { messages: [{ role: 'user', content: 'do the thing' }] }, {}))
          );
          const text = streamText(events);

          expect(text).toContain('spare provider answered');
          // Per-model request/shape errors are NOT provider evidence: all
          // three candidates were attempted, nothing was skipped, no
          // narration.
          const attempted = streamSimple.mock.calls.map((c: any[]) => c[0].id);
          expect(attempted).toEqual(['x-1', 'x-2', 'x-3', 'y-1']);
          expect(text).not.toContain('looks wedged');
        }
      );
    },
    30_000
  );

  it(
    'case 4 — a rate-limit-shaped failure with a parsed reset time does NOT trip the breaker',
    async () => {
      await withIsolatedRouter(
        {
          ...BASE_CONFIG,
          gdpval_builtin: { 'x-1': 1000, 'x-2': 990, 'x-3': 980, 'y-1': 900 },
        },
        [
          cloudModel('wedge-provider', 'x-1'),
          cloudModel('wedge-provider', 'x-2'),
          cloudModel('wedge-provider', 'x-3'),
          cloudModel('spare-provider', 'y-1'),
        ],
        async ({ groupStream, streamSimple }) => {
          streamSimple.mockImplementation((model: any) => {
            if (model.provider === 'wedge-provider') {
              // Rate-limit wording WITH a parseable reset time — the
              // rate-limit path owns these; a subscription window running
              // out is not a wedge (plan D1).
              return errorStream('429 Too Many Requests — rate limit reached, resets 23:59');
            }
            return successStream('spare provider answered');
          });

          const events = await drainStream(
            await Promise.resolve(groupStream({ provider: 'standard', id: 'standard' }, { messages: [{ role: 'user', content: 'do the thing' }] }, {}))
          );
          const text = streamText(events);

          expect(text).toContain('spare provider answered');
          const attempted = streamSimple.mock.calls.map((c: any[]) => c[0].id);
          expect(attempted).toEqual(['x-1', 'x-2', 'x-3', 'y-1']);
          expect(text).not.toContain('looks wedged');
        }
      );
    },
    30_000
  );
});
