// A scan cache whose only (or listed) local models are made-up Ollama names.
// ADR-0025: the classifier derives its local chain from cache.available_models,
// so tests that exercise the mocked-Ollama path must supply a registry —
// there is no shipped default model to fall back on.
import type { Cache } from '../../src/types.ts';

export function localModelCache(...ids: string[]): Cache {
  const names = ids.length > 0 ? ids : ['foo:3b', 'bar:9b'];
  // capabilities.completion: the provisional (pre-probe) path only admits
  // models the scan has EXPLICITLY seen answering completions (review M7).
  return { available_models: names.map((id) => ({ id, provider: 'ollama', cost_per_m: 0, capabilities: { completion: true } })) } as Cache;
}
