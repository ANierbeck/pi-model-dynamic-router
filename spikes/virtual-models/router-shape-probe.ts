// Router-shape probe for plan docs/plans/2026-11-21-virtual-models-migration.md
// step 1: the planned two-layer design in miniature, run against the
// installed Pi.
//
//   router/dynamic (Pi virtual model, the only selectable router model)
//     └─ route() ─▶ rgrp/<group> (native pi-ai Provider, hidden: filterModels → [])
//                     └─ streamSimple ─▶ spike/<physical> (fake-server.mjs)
//
// route() picks the group like the planned router: a pinned group from the
// branch state first, then `HINT: <group>` in the user's message, then a
// keyword "classifier"; continuation keeps the run group, retry leaves the
// failed group, direct (compaction summaries) uses a fixed group. The
// `pin_group` tool is the planned replacement of set_model_from_group: it pins
// a group in the branch state instead of switching the session model.
//
// Every decision is appended to $SPIKE_OUT/shape.jsonl. Not shipped, no
// credentials: the physical models live on 127.0.0.1.
import { appendFileSync } from 'node:fs';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const PORT = Number(process.env.SPIKE_PORT ?? 8791);
const LOG = `${process.env.SPIKE_OUT ?? '/tmp/vm-spike'}/shape.jsonl`;
const log = (row: Record<string, unknown>): void => {
  appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...row }) + '\n');
};

/** group → physical model on the fake server (the last id character picks its mode). */
const GROUPS: Record<string, string> = {
  planning: 'plan-c',
  code_complex: 'code-c',
  simple: 'small-c',
  overflow: 'code-j', // 400 context_length_exceeded
  stall: 'slow-d', // headers, then silence
  failing: '', // the group provider itself reports an error (router-built error)
  failing429: '', // the same, worded like a retryable rate limit
};
const DIRECT_GROUP = 'simple';

const chat = (provider: string, id: string, api: string, baseUrl: string): any => ({
  type: 'chat',
  id,
  name: `${provider} ${id}`,
  api,
  provider,
  baseUrl,
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4096,
});

interface ShapeState {
  pin: string | null;
  runGroup: string | null;
  turns: number;
}

function userText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    return typeof m.content === 'string'
      ? m.content
      : (m.content ?? []).map((c: any) => c?.text ?? '').join('');
  }
  return '';
}

function classify(text: string): string {
  const hint = /HINT:\s*(\w+)/.exec(text)?.[1];
  if (hint && hint in GROUPS) return hint;
  for (const g of ['overflow', 'stall', 'failing429', 'failing', 'planning'])
    if (text.includes(g)) return g;
  if (text.includes('code')) return 'code_complex';
  return 'simple';
}

export default function (pi: ExtensionAPI) {
  // Per extension instance (one per session runtime): pins the pin_group tool
  // set during a turn, keyed by session id, consumed by the next route().
  const pendingPins = new Map<string, string | null>();
  let registry: any;

  pi.registerProvider('spike', {
    name: 'Spike fake',
    baseUrl: `http://127.0.0.1:${PORT}/v1`,
    apiKey: 'spike-key',
    api: 'openai-completions',
    models: Object.values(GROUPS)
      .filter(Boolean)
      .map((id) => ({
        id,
        name: `spike ${id}`,
        reasoning: false,
        input: ['text' as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 4096,
      })),
  });

  const groupModels = Object.keys(GROUPS).map((g) =>
    chat('rgrp', g, 'router-group-shape', 'https://router.local')
  );
  const groupProvider: any = {
    id: 'rgrp',
    name: 'Router groups (hidden)',
    auth: {
      apiKey: {
        name: 'Router group',
        resolve: async () => ({ auth: {}, source: 'router' }),
      },
    },
    getModels: () => groupModels,
    // The hiding mechanism under test: complete catalog, nothing available.
    filterModels: () => (process.env.SPIKE_HIDE === '0' ? groupModels : []),
    stream: (m: any, c: any, o: any) => groupProvider.streamSimple(m, c, o),
    streamSimple: (model: any, context: any, options: any) => {
      const physical = GROUPS[model.id];
      log({ at: 'group-stream', group: model.id, physical: physical || '(error)' });
      const proxy = createAssistantMessageEventStream();
      if (!physical) {
        // A router-built error names the group model (stream-driver
        // buildErrorAssistantMessage with sourceModel).
        const message = {
          role: 'assistant',
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'error',
          errorMessage:
            model.id === 'failing429'
              ? '429 Too Many Requests: rate limit exceeded (spike)'
              : '[router] every candidate of the group failed (spike)',
          timestamp: Date.now(),
        };
        queueMicrotask(() => proxy.push({ type: 'error', reason: 'error', error: message } as any));
        return proxy;
      }
      const inner = registry.streamSimple(registry.find('spike', physical), context, options);
      void (async () => {
        try {
          for await (const ev of inner) proxy.push(ev);
        } catch (err) {
          log({ at: 'group-stream-threw', group: model.id, err: String(err) });
        }
      })();
      return proxy;
    },
  };
  pi.registerProvider(groupProvider);

  pi.registerVirtualModel<ShapeState>({
    provider: 'router',
    id: 'dynamic',
    name: 'Router (dynamic)',
    thinkingLevels: ['off', 'low', 'high'],
    contextWindow: 200_000,
    route(request, ctx) {
      const sid = ctx.sessionManager?.getSessionId?.();
      const before: ShapeState = request.state ?? { pin: null, runGroup: null, turns: 0 };
      let state: ShapeState | undefined;
      let group: string;
      const pending = sid !== undefined && pendingPins.has(sid) ? pendingPins.get(sid)! : undefined;
      if (sid !== undefined) pendingPins.delete(sid);
      const pin = pending !== undefined ? pending : before.pin;
      if (request.reason === 'direct') {
        group = DIRECT_GROUP;
      } else if (request.reason === 'retry') {
        const failedGroup =
          request.failed?.model.provider === 'rgrp' ? request.failed.model.id : before.runGroup;
        group = failedGroup === 'code_complex' ? 'simple' : 'code_complex';
        // A retry after an overflow compaction: stay off the overflow group.
      } else if (request.reason === 'continuation') {
        group = pin ?? before.runGroup ?? 'simple';
      } else {
        group = pin ?? classify(userText(request.messages as any[]));
      }
      if (request.reason === 'user') {
        state = { pin, runGroup: group, turns: before.turns + 1 };
      } else if (pending !== undefined) {
        state = { ...before, pin };
      }
      const target = ctx.modelRegistry.find('rgrp', group);
      log({
        at: 'route',
        sid,
        reason: request.reason,
        group,
        found: Boolean(target),
        stateIn: request.state ?? null,
        stateOut: state ?? 'kept',
        previous: request.previous
          ? `${request.previous.model.provider}/${request.previous.model.id}`
          : null,
        failed: request.failed
          ? `${request.failed.model.provider}/${request.failed.model.id}: ${request.failed.message.errorMessage ?? ''}`.slice(
              0,
              160
            )
          : null,
        ctxModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
      });
      if (!target) throw new Error(`rgrp/${group} not found`);
      return { model: target, thinkingLevel: 'off', state };
    },
  });

  pi.registerTool({
    name: 'pin_group',
    label: 'Pin group',
    description: 'Pin a router group for this session branch; "none" releases the pin.',
    parameters: Type.Object({ group: Type.String() }),
    async execute(_id: string, params: { group: string }, _s: unknown, _u: unknown, ctx: any) {
      const sid = ctx.sessionManager.getSessionId();
      pendingPins.set(sid, params.group === 'none' ? null : params.group);
      log({ at: 'pin-tool', sid, group: params.group });
      return { content: [{ type: 'text', text: `pinned ${params.group}` }], details: {} };
    },
  } as any);

  pi.on('session_start', async (event: any, ctx: any) => {
    registry = ctx.modelRegistry;
    const available = ctx.modelRegistry.getAvailable().map((m: any) => `${m.provider}/${m.id}`);
    log({
      at: 'session_start',
      reason: event.reason,
      sid: ctx.sessionManager.getSessionId(),
      hasUI: ctx.hasUI,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
      availableGroups: available.filter((r: string) => r.startsWith('rgrp/')),
      availableVirtual: available.filter((r: string) => r.startsWith('router/')),
    });
    // The router registers its group models again at session_start
    // (rt.registerGroupModels). Does that put the hidden models back into the
    // availability snapshot until the next refresh?
    if (process.env.SPIKE_REREGISTER === '1') {
      pi.registerProvider(groupProvider);
      const groupsNow = (): string[] =>
        ctx.modelRegistry
          .getAvailable()
          .map((m: any) => `${m.provider}/${m.id}`)
          .filter((r: string) => r.startsWith('rgrp/'));
      log({ at: 'after-reregister', tick: 0, availableGroups: groupsNow() });
      await new Promise((r) => setTimeout(r, 0));
      log({ at: 'after-reregister', tick: 1, availableGroups: groupsNow() });
    }
  });

  pi.on('turn_end', async (event: any, ctx: any) => {
    const m = event.message;
    log({
      at: 'turn_end',
      selection: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
      served: m ? `${m.provider}/${m.model}` : null,
      api: m?.api,
      stopReason: m?.stopReason,
    });
  });
}
