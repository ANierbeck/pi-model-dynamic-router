/**
 * OpenRouter's free-models-per-day cap is ACCOUNT-WIDE and resets at 00:00
 * UTC. The 429 body reads:
 *
 *   "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock
 *    1000 free model requests per day"
 *
 * Live finding 2026-10-03: the router treated it as an ordinary per-model
 * 429 with the escalating 60s backoff, so every later turn re-burned a
 * doomed attempt per :free candidate — 1475 router.log lines in one day,
 * 14 of that session's 23 recorded errors. The fix:
 *   1. detect the cap text (detection.ts) and forward it as `detail`,
 *   2. cool down ALL openrouter/*:free candidates until the next UTC
 *      midnight (one account-level event, not per-model failures),
 *   3. narrate it as the account-wide cap it is.
 *
 * Also pins the narration lookahead fix from the same finding: the
 * ", trying X …" suffix must not name candidates the pre-flight guards
 * (cooldown, wedge, ollama-down, context window) will silently skip —
 * the log said "trying ollama/mistral-nemo:latest" while the cascade
 * actually streamed mistral/zai-glm-5-3.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeNoOpScanCache,
  removeNoOpScanCache,
  flushBackgroundScan,
} from './helpers/noop-scan-cache.ts';

const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

async function drainStream(stream: any) {
  const events: any[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

async function withIsolatedRouter(
  configOverride: Record<string, unknown>,
  fn: (defaultExport: any, tmpDir: string) => Promise<void>
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-free-day-cap-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const dynBak = `${dynamicConfigPath}.freedaycap-bak`;
  const hadDyn = fs.existsSync(dynamicConfigPath);
  if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
  writeNoOpScanCache(scanCachePath);

  try {
    vi.resetModules();
    const mod = await import('../index.ts');
    await fn(mod.default as any, tmpDir);
  } finally {
    cwdSpy.mockRestore();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    removeNoOpScanCache(scanCachePath);
    if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
  }
}

const FREE_DAY_CAP_429 =
  'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day';

describe('detection: free-tier daily cap', () => {
  it('isFreeTierDailyCapText matches the OpenRouter free-models-per-day 429 body and rejects other 429s', async () => {
    const { isFreeTierDailyCapText } = await import('../src/detection.ts');
    expect(isFreeTierDailyCapText(FREE_DAY_CAP_429)).toBe(true);
    expect(isFreeTierDailyCapText('429: too many requests')).toBe(false);
    expect(isFreeTierDailyCapText('Rate limit exceeded: free-models-per-minute')).toBe(false);
    expect(isFreeTierDailyCapText('')).toBe(false);
  });

  it('nextUtcMidnightMs returns the strictly next 00:00 UTC', async () => {
    const { nextUtcMidnightMs } = await import('../src/detection.ts');
    expect(nextUtcMidnightMs(Date.UTC(2026, 9, 3, 20, 21, 0))).toBe(Date.UTC(2026, 9, 4, 0, 0, 0));
    // Exactly at midnight → the cap just reset; the NEXT midnight is +24h.
    expect(nextUtcMidnightMs(Date.UTC(2026, 9, 4, 0, 0, 0))).toBe(Date.UTC(2026, 9, 5, 0, 0, 0));
    expect(nextUtcMidnightMs(Date.UTC(2026, 9, 3, 23, 59, 59))).toBe(Date.UTC(2026, 9, 4, 0, 0, 0));
  });
});

describe('ollama-utils: sync availability peek', () => {
  // Order matters: the module-level negative-probe cache (15s TTL) is
  // shared between these tests, so the "daemon up" case must run BEFORE a
  // down-probe poisons the cache for the rest of the TTL window.
  it('isOllamaProbablyDown is false when the daemon answered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: [] }),
      text: async () => '',
    } as any)));
    try {
      const ollama = await import('../src/ollama-utils.ts');
      expect(await ollama.isOllamaAvailable()).toBe(true);
      expect(ollama.isOllamaProbablyDown()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('isOllamaProbablyDown reflects the last cached probe result without probing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED (mock)'); }));
    try {
      const ollama = await import('../src/ollama-utils.ts');
      expect(await ollama.isOllamaAvailable()).toBe(false);
      // The negative probe result is cached — the sync peek sees it without
      // paying another probe (that's the whole point: narration lookaheads
      // must not await).
      expect(ollama.isOllamaProbablyDown()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('driveStream: OpenRouter free-tier daily cap is account-wide', () => {
  it('one free-models-per-day 429 cools down ALL :free candidates and narrates the cap', async () => {
    await withIsolatedRouter(
      {
        free_models: [],
        rate_limit_wait_max_ms: 0,
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        gdpval_builtin: { 'free-a:free': 900, 'free-b:free': 800, 'paid-model': 700 },
        providers: {
          // TWO keys: through recordLimit, the key-rotation path would win
          // before any cooldown is set, silently skipping the account-wide
          // cap cooldown for the first refs (review P1 2026-10-04).
          openrouter: {
            keys: [{ key: 'test-key-1' }, { key: 'test-key-2' }],
            free_models: ['openrouter/free-a:free', 'openrouter/free-b:free'],
          },
          mistral: { free_models: ['mistral/paid-model'] },
        },
      },
      async (defaultExport, tmpDir) => {
        const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
        const pi: any = {
          registerTool: vi.fn(),
          registerCommand: vi.fn(),
          registerProvider: vi.fn(),
          setModel: vi.fn(async () => true),
          // COLLECT as arrays: index.ts registers several events (e.g.
          // session_shutdown) more than once; a last-one-wins map silently
          // dropped the save-flush handler (found while pinning the
          // exactly-one-session-error contract).
          on: vi.fn((event: string, handler: any) => {
            (onHandlers[event] ??= []).push(handler);
          }),
        };
        defaultExport(pi);

        const mk = (provider: string, id: string) => ({
          provider, id, api: 'openai-completions', contextWindow: 1_000_000,
          cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        });
        const freeA = mk('openrouter', 'free-a:free');
        const freeB = mk('openrouter', 'free-b:free');
        const paid = mk('mistral', 'paid-model');
        const modelsByRef: Record<string, any> = {
          'openrouter/free-a:free': freeA,
          'openrouter/free-b:free': freeB,
          'mistral/paid-model': paid,
        };
        const streamSimple = vi.fn((model: any) => {
          if (model.id === 'free-a:free') {
            return (async function* () {
              yield { type: 'error', error: { errorMessage: FREE_DAY_CAP_429 } };
            })();
          }
          if (model.id === 'free-b:free') {
            return (async function* () {
              // Must NEVER be reached: the account-wide cooldown must have
              // taken free-b out of the cascade before the loop reaches it.
              yield { type: 'text_delta', delta: 'WRONG: served by free-b' };
              yield { type: 'done' };
            })();
          }
          return (async function* () {
            yield { type: 'text_delta', delta: 'served by the paid model' };
            yield { type: 'done' };
          })();
        });
        const modelRegistry = {
          getAvailable: () => [freeA, freeB, paid],
          find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
          getApiKeyForProvider: async () => 'test-key',
          runtime: { streamSimple },
        };
        const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
        for (const h of onHandlers['session_start'] ?? []) await h({}, ctx);
        await flushBackgroundScan();

        const groupModel = { provider: 'standard', id: 'standard' };
        const context: any = { messages: [{ role: 'user', content: 'do the thing' }] };
        const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

        const narration = events
          .filter((e: any) => e.type === 'text_delta')
          .map((e: any) => e.delta ?? '')
          .join('');

        // The narration names the account-wide cap, not a per-model 429.
        expect(narration).toContain('free-tier daily request cap reached');
        // free-b was cooled down by the same account event — the suffix must
        // skip straight to the paid candidate.
        expect(narration).toContain('trying mistral/paid-model');
        expect(narration).not.toContain('trying openrouter/free-b:free');
        // The cascade never attempted free-b after the cap was recorded.
        const calledIds = streamSimple.mock.calls.map((c: any) => c[0]?.id);
        expect(calledIds).toContain('free-a:free');
        expect(calledIds).toContain('paid-model');
        expect(calledIds).not.toContain('free-b:free');
        // The turn still succeeds via the paid candidate.
        expect(narration).toContain('served by the paid model');
        // The cap is account-wide: no key rotation is narrated (rotation
        // would skip the cooldown AND exhaust an unexhausted key).
        expect(narration).not.toContain('key rotated');
        // Exactly ONE session error — for the ref that actually failed.
        // The cap branch must not record per-model errors for the siblings
        // (owner decision: one account-level event).
        for (const h of onHandlers['session_shutdown'] ?? []) await h({ reason: 'quit' });
        const projectState = JSON.parse(
          fs.readFileSync(path.join(tmpDir, '.pi', 'cache', 'router-state.json'), 'utf-8')
        );
        const capErrors = (projectState.session_errors ?? []).filter(
          (e: any) => e.reason === 'rate_limit_exceeded'
        );
        expect(capErrors).toHaveLength(1);
        expect(capErrors[0].ref).toBe('openrouter/free-a:free');
      }
    );
  }, 30000);
});

describe('driveStream: "trying X" narration lookahead', () => {
  it('suffix skips candidates the pre-flight context-window guard will skip', async () => {
    await withIsolatedRouter(
      {
        free_models: [],
        rate_limit_wait_max_ms: 0,
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        gdpval_builtin: { 'rl-model': 900, 'tiny-model': 800, 'ok-model': 700 },
        providers: {
          mistral: { free_models: ['mistral/rl-model', 'mistral/tiny-model', 'mistral/ok-model'] },
        },
      },
      async (defaultExport, tmpDir) => {
        const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
        const pi: any = {
          registerTool: vi.fn(),
          registerCommand: vi.fn(),
          registerProvider: vi.fn(),
          setModel: vi.fn(async () => true),
          // COLLECT as arrays: index.ts registers several events (e.g.
          // session_shutdown) more than once; a last-one-wins map silently
          // dropped the save-flush handler (found while pinning the
          // exactly-one-session-error contract).
          on: vi.fn((event: string, handler: any) => {
            (onHandlers[event] ??= []).push(handler);
          }),
        };
        defaultExport(pi);

        const mk = (id: string, contextWindow: number) => ({
          provider: 'mistral', id, api: 'openai-completions', contextWindow,
          cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        });
        // tiny-model's window (2) is below the estimated context of the
        // turn (≈3 tokens from 'do the thing', chars/4 estimate) → the
        // pre-flight guard skips it silently. Previously the failure suffix
        // announced "trying mistral/tiny-model" and then the cascade
        // streamed ok-model — narration named a ref never attempted.
        const rl = mk('rl-model', 1_000_000);
        const tiny = mk('tiny-model', 2);
        const ok = mk('ok-model', 1_000_000);
        const modelsByRef: Record<string, any> = {
          'mistral/rl-model': rl,
          'mistral/tiny-model': tiny,
          'mistral/ok-model': ok,
        };
        const streamSimple = vi.fn((model: any) => {
          if (model.id === 'rl-model') {
            return (async function* () {
              yield { type: 'error', error: { errorMessage: '429: too many requests' } };
            })();
          }
          return (async function* () {
            yield { type: 'text_delta', delta: 'served by ok-model' };
            yield { type: 'done' };
          })();
        });
        const modelRegistry = {
          getAvailable: () => [rl, tiny, ok],
          find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
          getApiKeyForProvider: async () => 'test-key',
          runtime: { streamSimple },
        };
        const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
        for (const h of onHandlers['session_start'] ?? []) await h({}, ctx);
        await flushBackgroundScan();

        const groupModel = { provider: 'standard', id: 'standard' };
        const context: any = { messages: [{ role: 'user', content: 'do the thing' }] };
        const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

        const narration = events
          .filter((e: any) => e.type === 'text_delta')
          .map((e: any) => e.delta ?? '')
          .join('');

        // The suffix names the ref the cascade REALLY attempts next.
        expect(narration).toContain('trying mistral/ok-model');
        expect(narration).not.toContain('trying mistral/tiny-model');
        const calledIds = streamSimple.mock.calls.map((c: any) => c[0]?.id);
        expect(calledIds).not.toContain('tiny-model');
        expect(narration).toContain('served by ok-model');
      }
    );
  }, 30000);
});
