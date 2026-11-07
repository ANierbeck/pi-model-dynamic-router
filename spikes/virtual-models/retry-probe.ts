// Retry probe for the virtual-model spike (research note §1); see README.md.
// Registers a local fake provider plus a virtual model that logs every route()
// call, so we can see what Pi asks for and when.
import { appendFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const PORT = Number(process.env.SPIKE_PORT ?? 8791);
const LOG = `${process.env.SPIKE_OUT ?? '/tmp/vm-spike'}/routes.jsonl`;
const T0 = Date.now();

const model = (id: string) => ({
  type: 'chat' as const,
  id,
  name: `spike ${id}`,
  reasoning: false,
  input: ['text' as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4096,
});

export default function (pi: ExtensionAPI) {
  pi.registerProvider('spike', {
    name: 'Spike fake',
    baseUrl: `http://127.0.0.1:${PORT}/v1`,
    apiKey: 'spike-key',
    api: 'openai-completions',
    models: [
      model('spike-a'),
      model('spike-b'),
      model('spike-c'),
      model('spike-d'),
      model('spike-e'),
      model('spike-f'),
      model('spike-g'),
      model('spike-h'),
      { ...model('spike-i'), contextWindow: 2000, maxTokens: 512 },
      { ...model('spike-j'), contextWindow: 2000, maxTokens: 512 },
    ],
  });

  pi.registerVirtualModel({
    provider: 'spike',
    id: 'auto',
    name: 'Spike Auto',
    thinkingLevels: ['off'],
    route(request, ctx) {
      const first = (process.env.SPIKE_FIRST ?? 'spike-a').trim();
      const next = (process.env.SPIKE_NEXT ?? 'spike-c').trim();
      const previous = request.previous?.model?.id ?? null;
      const failed = request.failed
        ? {
            id: request.failed.model?.id ?? null,
            stopReason: request.failed.message?.stopReason ?? null,
            errorMessage: request.failed.message?.errorMessage ?? null,
          }
        : null;
      // user -> first; retry -> next (only once, then stay on next); continuation -> previous
      let target = first;
      if (request.reason === 'retry') target = request.state?.switched ? (previous ?? next) : next;
      else if (request.reason === 'continuation' && previous) target = previous;
      appendFileSync(
        LOG,
        JSON.stringify({
          t: Date.now() - T0,
          reason: request.reason,
          previous,
          failed,
          state: request.state ?? null,
          picked: target,
        }) + '\n'
      );
      const found = ctx.modelRegistry.find('spike', target);
      if (!found) throw new Error(`spike model ${target} missing`);
      return {
        model: found,
        thinkingLevel: 'off',
        state: { switched: Boolean(request.state?.switched) || request.reason === 'retry' },
      };
    },
  });
}
