// Spike step 6: hand-off between route() and the group provider's streamSimple,
// and session identity in both. Probe for docs/research/2026-11-06-virtual-model-spike.md; see README.md.
import { appendFileSync } from 'node:fs';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const PORT = Number(process.env.SPIKE_PORT ?? 8791);
const LOG = process.env.SPIKE7_LOG ?? `${process.env.SPIKE_OUT ?? '/tmp/vm-spike'}/r7.jsonl`;
const log = (o: unknown) => appendFileSync(LOG, JSON.stringify(o) + '\n');
const model = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'chat' as const, id, name: `spike ${id}`, reasoning: false, input: ['text' as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 4096, ...extra,
});
let factoryCalls = 0;

export default function (pi: ExtensionAPI) {
  factoryCalls++;
  const myCall = factoryCalls;
  let registry: any;
  let sessionId = '';
  pi.on('session_start', (_e, ctx) => {
    registry = ctx.modelRegistry;
    sessionId = ctx.sessionManager.getSessionId();
    log({ ev: 'session_start', factoryCall: myCall, sessionId });
  });

  pi.registerProvider('spike', {
    name: 'Spike fake', baseUrl: `http://127.0.0.1:${PORT}/v1`, apiKey: 'spike-key',
    api: 'openai-completions', models: [model('spike-c')],
  });
  pi.registerProvider('grp', {
    name: 'Spike group', api: 'spike-group', apiKey: 'unused', baseUrl: 'http://unused.invalid',
    models: [model('code', { api: 'spike-group' })],
    streamSimple: (m: any, context: any, options: any) => {
      log({ ev: 'group.streamSimple', factoryCall: myCall, optSessionId: options?.sessionId ?? null,
            modelId: m.id, optKeys: Object.keys(options ?? {}) });
      const proxy = createAssistantMessageEventStream();
      const inner = registry.streamSimple(registry.find('spike', 'spike-c'), context, options);
      void (async () => { for await (const ev of inner) proxy.push(ev); })();
      return proxy;
    },
  } as any);
  pi.registerVirtualModel<{ n: number }>({
    provider: 'spike', id: 'v7', name: 'V7', thinkingLevels: ['off'],
    route(request, ctx) {
      log({ ev: 'route', factoryCall: myCall, reason: request.reason,
            ctxSessionId: ctx.sessionManager.getSessionId(), reqKeys: Object.keys(request) });
      return { model: ctx.modelRegistry.find('grp', 'code')!, thinkingLevel: 'off', state: { n: (request.state?.n ?? 0) + 1 } };
    },
  });
}
