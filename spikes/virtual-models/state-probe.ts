// Spike step 5(a): does route() state stay separated for direct requests,
// fork and resume? Probe for docs/research/2026-11-06-virtual-model-spike.md; see README.md.
import { appendFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const PORT = Number(process.env.SPIKE_PORT ?? 8791);
const LOG = process.env.SPIKE5_LOG ?? `${process.env.SPIKE_OUT ?? '/tmp/vm-spike'}/route5.jsonl`;
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
    models: [model('spike-c')],
  });

  pi.registerVirtualModel<{ turns: number; last: string }>({
    provider: 'spike',
    id: 'vauto',
    name: 'Spike V-Auto',
    thinkingLevels: ['off'],
    route(request, ctx) {
      const before = request.state ?? null;
      const found = ctx.modelRegistry.find('spike', 'spike-c');
      if (!found) throw new Error('spike-c missing');
      let state: { turns: number; last: string } | undefined;
      if (request.reason === 'user') {
        state = { turns: (before?.turns ?? 0) + 1, last: 'user' };
      } else if (request.reason === 'direct') {
        // Documented: Pi ignores state returned for direct requests. Return a
        // poison value so any leak is visible in the next user turn.
        state = { turns: 999, last: 'direct' };
      }
      appendFileSync(
        LOG,
        JSON.stringify({
          reason: request.reason,
          stateIn: before,
          stateOut: state ?? 'kept',
          messages: request.messages.length,
        }) + '\n'
      );
      return { model: found, thinkingLevel: 'off', state };
    },
  });

  let directDone = false;
  pi.on('agent_end', async (_event, ctx) => {
    if (process.env.SPIKE_DIRECT_ONCE !== '1' || directDone) return;
    directDone = true;
    const target = ctx.modelRegistry.find('spike', 'vauto');
    if (!target) throw new Error('virtual model not found');
    const stream = ctx.modelRegistry.streamSimple(
      target,
      {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'direct probe' }], timestamp: Date.now() }],
      },
      {}
    );
    await stream.result();
    appendFileSync(LOG, JSON.stringify({ event: 'direct-finished' }) + '\n');
  });
}
