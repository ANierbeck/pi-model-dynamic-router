// Shared fixture for tests that drive applyGroupFilters with capability
// profiles: fresh module state per test (the metrics mirror of the capability
// profiles is replace-on-write, so "no data anywhere" cannot be staged in a
// shared module), a config whose model_groups the test supplies, and the
// metrics cache seeded with the profiles.

import { vi } from 'vitest';

export interface FilterFixture {
  routing: typeof import('../../src/routing.js');
  metrics: typeof import('../../src/metrics.js');
  dyn: typeof import('../../src/dynamic-config.js');
  cfg: any;
}

export async function freshCapabilityFilters(
  profiles: Record<string, any>,
  groups: Record<string, any>,
  base: Record<string, any> = {}
): Promise<FilterFixture> {
  vi.resetModules();
  const metrics = await import('../../src/metrics.js');
  const routing = await import('../../src/routing.js');
  const dyn = await import('../../src/dynamic-config.js');
  const cfg = { model_groups: {}, ...base, model_groups: groups };
  metrics.setConfig(cfg as any);
  metrics.setCache({ available_models: [], capability_profiles: profiles } as any);
  metrics.setModelRegistry({ find: () => undefined } as any);
  return { routing, metrics, dyn, cfg };
}
