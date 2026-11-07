// Spike step 5(b): two layers. A virtual model routes to a group-like extension
// provider ("grp/code"), whose streamSimple forwards every event of an inner
// physical request (spike/spike-c). Probe for docs/research/2026-11-06-virtual-model-spike.md; see README.md.
import { appendFileSync } from 'node:fs';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const PORT = Number(process.env.SPIKE_PORT ?? 8791);
const LOG = process.env.SPIKE6_LOG ?? `${process.env.SPIKE_OUT ?? '/tmp/vm-spike'}/route6.jsonl`;
const model = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'chat' as const,
  id,
  name: `spike ${id}`,
  reasoning: false,
  input: ['text' as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4096,
  ...extra,
});

export default function (pi: ExtensionAPI) {
  let registry: any;
  pi.on('session_start', (_e, ctx) => {
    registry = ctx.modelRegistry;
  });

  pi.registerProvider('spike', {
    name: 'Spike fake',
    baseUrl: `http://127.0.0.1:${PORT}/v1`,
    apiKey: 'spike-key',
    api: 'openai-completions',
    models: [model('spike-c')],
  });

  pi.registerProvider('grp', {
    name: 'Spike group',
    api: 'spike-group',
    apiKey: 'unused',
    baseUrl: 'http://unused.invalid',
    models: [model('code', { api: 'spike-group' })],
    streamSimple: (_m: any, context: any, options: any) => {
      const proxy = createAssistantMessageEventStream();
      const inner = registry.streamSimple(registry.find('spike', 'spike-c'), context, options);
      void (async () => {
        for await (const ev of inner) proxy.push(ev);
      })();
      return proxy;
    },
  } as any);

  pi.registerVirtualModel<{ turns: number }>({
    provider: 'spike',
    id: 'vtwo',
    name: 'Spike V-Two',
    thinkingLevels: ['off'],
    route(request, ctx) {
      const found = ctx.modelRegistry.find('grp', 'code');
      if (!found) throw new Error('grp/code missing');
      appendFileSync(
        LOG,
        JSON.stringify({
          reason: request.reason,
          previous: request.previous
            ? `${request.previous.model.provider}/${request.previous.model.id}`
            : null,
          state: request.state ?? null,
        }) + '\n'
      );
      return {
        model: found,
        thinkingLevel: 'off',
        state: { turns: (request.state?.turns ?? 0) + (request.reason === 'user' ? 1 : 0) },
      };
    },
  });
}
