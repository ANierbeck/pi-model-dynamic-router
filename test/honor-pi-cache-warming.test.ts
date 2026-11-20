// test/honor-pi-cache-warming.test.ts
// docs/plans/2026-11-20-honor-pi-cache-warming.md, steps 1 and 2.
//
// Pi 1.6.0 keeps a session's prompt cache warm by replaying the last request
// with `maxTokens: 1`, `disableContinuation: true`, `maxRetries: 0`
// (pi-ai getCacheWarmingRequestOptions) — but only when the session model
// declares a prompt-cache lifetime and a price. Router group models declared
// neither, so Pi never warmed a router session, whatever the user configured.
//
// These tests drive the router through the entry Pi itself calls: the
// `streamSimple` of the registered group provider.

import { describe, it, expect, vi } from 'vitest';
import { makeObservableExtensionContext, startSession } from './helpers/extension-harness.ts';
import { doneEvent, errorEvent, paidCloudModel } from './helpers/stream-fixtures.ts';
import { withRouterEnv } from './helpers/router-env.ts';

vi.mock('../src/content-classifier.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/content-classifier.ts')>();
  return { ...actual, classifyPrompt: vi.fn(actual.classifyPrompt) };
});

const CONFIG = {
  free_models: [],
  providers: {},
  model_groups: {
    dynamic: { method: 'dynamic' },
    standard: {
      fallback_groups: [],
      min_gdpval: 0,
      exclude_models: ['paid-cloud-provider/side-*'],
    },
    // Two more models of the same provider that only this group uses: wedging
    // them opens the provider's breaker without putting a session's turn
    // model into a rate-limit cooldown.
    side: {
      fallback_groups: [],
      min_gdpval: 0,
      exclude_models: ['paid-cloud-provider/paid-model', 'paid-cloud-provider/other-model'],
    },
  },
  gdpval_builtin: { 'paid-model': 1000, 'other-model': 900, 'side-a': 500, 'side-b': 400 },
  // A session whose candidates all fail must terminate now, not wait out cooldowns.
  rate_limit_wait_max_ms: 0,
  // Two wedged models of one provider open its breaker (default: three).
  provider_breaker: { min_models: { cloud: 2 } },
};

const PROMPT_CACHE = { short: 300, long: 3600 };
const PAID_COST = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

/** The options Pi's CacheWarmer sends (getCacheWarmingRequestOptions) plus the group's virtual key. */
const warmOptions = (sessionId: string): any => ({
  sessionId,
  apiKey: 'router-virtual',
  maxTokens: 1,
  disableContinuation: true,
  maxRetries: 0,
});

interface Harness {
  onHandlers: Record<string, any>;
  registerProviderCalls: { name: string; opts: any }[];
  streamSimple: ReturnType<typeof vi.fn>;
  classifierCalls: () => number;
  /** Pi's entry into the router: the registered group provider's streamSimple. */
  entry: (group: string, context: any, options: any) => AsyncIterable<any> & { result(): any };
  /** The model config the router last registered for `group`'s own model id. */
  groupModel: (group: string) => any;
  registrationsOf: (group: string) => number;
  /** The registry model of the last real (non-warm) stream. */
  lastServed: () => any;
}

async function boot(
  fn: (h: Harness) => Promise<void>,
  modelOverrides: Record<string, unknown> = {}
): Promise<void> {
  const classifier = await import('../src/content-classifier.ts');
  await withRouterEnv(
    async (defaultExport, tmpDir) => {
      vi.mocked(classifier.classifyPrompt).mockClear();
      const { ctx: pi, onHandlers, registerProviderCalls } = makeObservableExtensionContext();
      defaultExport(pi);
      // Both candidates cache; which one serves is the router's choice, so the
      // assertions compare against the model that actually answered.
      const paidModel = paidCloudModel({
        promptCache: PROMPT_CACHE,
        cost: PAID_COST,
        ...modelOverrides,
      });
      const otherModel = paidCloudModel({
        id: 'other-model',
        promptCache: PROMPT_CACHE,
        ...modelOverrides,
      });
      const sideModels = ['side-a', 'side-b'].map((id) => paidCloudModel({ id }));
      // Session 'fails' cannot be served by anyone, a `cancelled` request is
      // aborted, session 'limiter' gets a 429 from every model, session
      // 'wedger' gets empty answers (breaker evidence, not a rate limit); a
      // warm with `failWarm` fails on its model. Everything else answers.
      const streamSimple = vi.fn((model: any, _ctx: any, options: any) =>
        (async function* () {
          if (options?.cancelled) {
            // A cancellation: no cooldown, no breaker evidence.
            yield errorEvent('aborted', 'Request was aborted');
            return;
          }
          if (options?.sessionId === 'wedger') {
            yield doneEvent();
            return;
          }
          if (options?.sessionId === 'limiter') {
            yield errorEvent('error', '429 rate limit exceeded');
            return;
          }
          if (options?.sessionId === 'fails' || options?.failWarm) {
            yield errorEvent('error', '500 internal server error');
            return;
          }
          yield { type: 'text_delta', delta: 'reply' };
          yield doneEvent({
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'reply' }],
              provider: model.provider,
              model: model.id,
              usage: { input: 0, output: 1, cacheRead: 100, cacheWrite: 0, total: 101 },
              stopReason: 'stop',
              timestamp: Date.now(),
            },
          });
        })()
      );
      const modelRegistry = {
        getAvailable: () => [paidModel, otherModel, ...sideModels],
        find: (_provider: string, id: string) =>
          sideModels.find((m) => m.id === id) ?? (id === 'other-model' ? otherModel : paidModel),
        getApiKeyForProvider: async () => null,
        getRegisteredProviderIds: () => [],
        runtime: { streamSimple },
      };
      await startSession(onHandlers, { modelRegistry, cwd: tmpDir });
      const lastRegistration = (group: string): any =>
        registerProviderCalls.filter((c) => c.name === group).at(-1)?.opts;
      await fn({
        onHandlers,
        registerProviderCalls,
        streamSimple,
        classifierCalls: () => vi.mocked(classifier.classifyPrompt).mock.calls.length,
        entry: (group, context, options) =>
          lastRegistration(group).streamSimple(
            { provider: group, id: group, api: `router-group-${group}` },
            context,
            options
          ),
        groupModel: (group) => lastRegistration(group)?.models.find((m: any) => m.id === group),
        registrationsOf: (group) => registerProviderCalls.filter((c) => c.name === group).length,
        lastServed: () => streamSimple.mock.calls.at(-1)?.[0],
      });
    },
    { config: CONFIG, disableNetwork: true }
  );
}

/**
 * runAsSubCall from the module graph the booted extension uses: withRouterEnv
 * re-imports the extension, so a static import would be another instance
 * with its own AsyncLocalStorage.
 */
async function runAsSubCall<T>(fn: () => Promise<T>): Promise<T> {
  const scope = await import('../src/subcall-scope.ts');
  return scope.runAsSubCall(fn);
}

const userTurn = (): any => ({ messages: [{ role: 'user', content: 'hello' }] });
const toolFollowUp = (): any => ({
  messages: [
    { role: 'user', content: 'please read the file and fix it' },
    { role: 'assistant', content: [{ type: 'text', text: 'reading' }] },
    { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'file body' }] },
  ],
});

async function drain(stream: AsyncIterable<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

const routerText = (events: any[]): string[] =>
  events
    .filter((e) => e.type === 'text_delta' && String(e.delta).includes('[router]'))
    .map((e) => String(e.delta));

describe('Pi cache-warm requests are served verbatim on the session’s turn model', () => {
  it('forwards the warm to the model that served the session’s last request, unchanged', async () => {
    await boot(async (h) => {
      await drain(h.entry('dynamic', userTurn(), { sessionId: 'S', apiKey: 'router-virtual' }));
      const servedId = h.streamSimple.mock.calls.at(-1)?.[0].id;
      const classified = h.classifierCalls();
      h.streamSimple.mockClear();

      const warm = h.entry('dynamic', userTurn(), warmOptions('S'));
      const events = await drain(warm);

      expect(h.streamSimple).toHaveBeenCalledTimes(1);
      const [model, , options] = h.streamSimple.mock.calls[0];
      expect(model.id).toBe(servedId);
      expect(options).toMatchObject({ maxTokens: 1, disableContinuation: true, maxRetries: 0 });
      // The group's virtual key must never reach the real provider.
      expect(options.apiKey).toBeUndefined();
      // No routing: no classification, no router narration in the stream.
      expect(h.classifierCalls()).toBe(classified);
      expect(routerText(events)).toEqual([]);
      const message = await warm.result();
      expect(message.stopReason).toBe('stop');
      expect(message.model).toBe(servedId);
    });
  }, 30000);

  it('a failing warm does not fall over to another candidate', async () => {
    await boot(async (h) => {
      await drain(h.entry('standard', userTurn(), { sessionId: 'S' }));
      h.streamSimple.mockClear();

      const warm = h.entry('standard', userTurn(), { ...warmOptions('S'), failWarm: true });
      await drain(warm);

      expect(h.streamSimple).toHaveBeenCalledTimes(1);
      expect((await warm.result()).stopReason).toBe('error');
    });
  }, 30000);

  it('a session that has not been served yet gets no warm at all', async () => {
    await boot(async (h) => {
      await drain(h.entry('standard', userTurn(), { sessionId: 'S' }));
      h.streamSimple.mockClear();

      const warm = h.entry('standard', userTurn(), warmOptions('other-session'));
      await drain(warm);

      expect(h.streamSimple).not.toHaveBeenCalled();
      expect((await warm.result()).stopReason).toBe('error');
    });
  }, 30000);

  it('a session whose last request failed gets no warm (nothing was cached)', async () => {
    await boot(async (h) => {
      await drain(h.entry('standard', userTurn(), { sessionId: 'fails' }));
      h.streamSimple.mockClear();

      const warm = h.entry('standard', userTurn(), warmOptions('fails'));
      await drain(warm);

      expect(h.streamSimple).not.toHaveBeenCalled();
      expect((await warm.result()).stopReason).toBe('error');
    });
  }, 30000);

  it('a rate-limited turn model is not warmed (no request into a known cooldown)', async () => {
    await boot(async (h) => {
      await drain(h.entry('standard', userTurn(), { sessionId: 'S' }));
      // Another session runs every candidate into a 429 cooldown.
      await drain(h.entry('standard', userTurn(), { sessionId: 'limiter' }));
      h.streamSimple.mockClear();

      const warm = h.entry('standard', userTurn(), warmOptions('S'));
      await drain(warm);

      expect(h.streamSimple).not.toHaveBeenCalled();
      expect((await warm.result()).stopReason).toBe('error');
    });
  }, 30000);

  it('a turn model behind an open breaker is not warmed', async () => {
    await boot(async (h) => {
      await drain(h.entry('standard', userTurn(), { sessionId: 'S' }));
      // Another session's empty answers on the provider's OTHER models wedge
      // it (breaker evidence) while the turn model itself stays out of any
      // cooldown — so only the breaker can keep this warm back.
      await drain(h.entry('side', userTurn(), { sessionId: 'wedger' }));
      const wedged = h.streamSimple.mock.calls.map((c) => c[0].id);
      expect(wedged).toEqual(expect.arrayContaining(['side-a', 'side-b']));
      h.streamSimple.mockClear();

      const warm = h.entry('standard', userTurn(), warmOptions('S'));
      await drain(warm);

      expect(h.streamSimple).not.toHaveBeenCalled();
      expect((await warm.result()).stopReason).toBe('error');
    });
  }, 30000);

  // Review finding (2026-11-20): delegation and bulk_read sub-calls stream
  // through a group provider inside the parent's session. They are the turn's
  // tool work, not a request of the session (the recordServedRef rule).
  it('an unsuccessful sub-call does not clear the session’s warm target', async () => {
    await boot(async (h) => {
      await drain(h.entry('standard', userTurn(), { sessionId: 'S' }));
      const sub = await runAsSubCall(async () => {
        const s = h.entry('standard', userTurn(), { sessionId: 'S', cancelled: true });
        await drain(s);
        return s.result();
      });
      expect(sub.stopReason).toBe('aborted');
      h.streamSimple.mockClear();

      await drain(h.entry('standard', userTurn(), warmOptions('S')));

      expect(h.streamSimple).toHaveBeenCalledTimes(1);
    });
  }, 30000);

  it('a request that only caps its output at one token is routed normally', async () => {
    await boot(async (h) => {
      const events = await drain(h.entry('standard', userTurn(), { sessionId: 'S', maxTokens: 1 }));
      expect(routerText(events).length).toBeGreaterThan(0);
    });
  }, 30000);
});

describe('the group model declares the served model’s cache economics', () => {
  it('declares no prompt-cache lifetime before anything was served', async () => {
    await boot(async (h) => {
      expect(h.groupModel('standard').promptCache).toBeUndefined();
    });
  }, 30000);

  it('after a served request it carries the served model’s promptCache and price', async () => {
    await boot(async (h) => {
      await drain(h.entry('standard', userTurn(), { sessionId: 'S' }));
      const declared = h.groupModel('standard');
      expect(declared.promptCache).toEqual(PROMPT_CACHE);
      expect(declared.cost).toEqual(h.lastServed().cost);
      expect(declared.cost.input).toBeGreaterThan(0);
    });
  }, 30000);

  it('declares on the group model Pi asked for (a dynamic group)', async () => {
    await boot(async (h) => {
      await drain(h.entry('dynamic', userTurn(), { sessionId: 'S' }));
      expect(h.groupModel('dynamic').promptCache).toEqual(PROMPT_CACHE);
    });
  }, 30000);

  it('re-registers only when the declared economics change', async () => {
    await boot(async (h) => {
      await drain(h.entry('standard', userTurn(), { sessionId: 'S' }));
      const after = h.registrationsOf('standard');
      await drain(h.entry('standard', userTurn(), { sessionId: 'S' }));
      expect(h.registrationsOf('standard')).toBe(after);
    });
  }, 30000);

  it('a sub-call declares nothing on the group it streamed through', async () => {
    await boot(async (h) => {
      // The parent's turn model is known; the sub-call must not stamp it on
      // the group the sub-call happened to use.
      await drain(h.entry('dynamic', userTurn(), { sessionId: 'S' }));
      await runAsSubCall(() => drain(h.entry('standard', userTurn(), { sessionId: 'S' })));
      expect(h.groupModel('standard').promptCache).toBeUndefined();
    });
  }, 30000);

  it('a failed request declares nothing', async () => {
    await boot(async (h) => {
      await drain(h.entry('standard', userTurn(), { sessionId: 'fails' }));
      expect(h.groupModel('standard').promptCache).toBeUndefined();
    });
  }, 30000);

  it('mirrors Pi’s replay gate: anthropic-messages with budget reasoning declares no lifetime', async () => {
    await boot(
      async (h) => {
        await drain(h.entry('standard', userTurn(), { sessionId: 'S', reasoning: 'high' }));
        const declared = h.groupModel('standard');
        expect(declared.promptCache).toBeUndefined();
        expect(declared.cost).toEqual(h.lastServed().cost);
      },
      { api: 'anthropic-messages' }
    );
  }, 30000);
});

describe('Pi’s entry runs in the request’s session scope', () => {
  // Boy-scout finding (2026-11-20): the static-group branch of the provider
  // entry called driveStream outside runInSession, so a static group's turn
  // model landed in the default session, not in the session Pi named.
  it('a static group’s turn model belongs to the session that was served', async () => {
    await boot(async (h) => {
      await drain(h.entry('standard', userTurn(), { sessionId: 'S' }));
      const before = h.classifierCalls();
      await drain(h.entry('dynamic', toolFollowUp(), { sessionId: 'S' }));
      expect(h.classifierCalls() - before).toBe(0);
    });
  }, 30000);
});
