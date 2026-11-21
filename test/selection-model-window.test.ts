// test/selection-model-window.test.ts
// Review 2026-11-21 of the virtual-models migration (Minor 1): Pi reads a
// virtual model's contextWindow once, at registerVirtualModel(). The
// extension registered router/dynamic before load() and
// registerGroupProviders(), so the config was unset and the dispatch
// group's spec did not exist yet — router/dynamic carried no window and Pi
// showed the limits as unknown until the first response.
import { describe, it, expect } from 'vitest';

import { makeExtensionContext } from './helpers/extension-harness.ts';
import { flushBackgroundScan } from './helpers/noop-scan-cache.ts';
import { withRouterEnv } from './helpers/router-env.ts';

describe('router/dynamic registration', () => {
  it('carries the dispatch group’s context window', async () => {
    let definition: any;
    await withRouterEnv(
      async (defaultExport) => {
        const { ctx: pi } = makeExtensionContext();
        defaultExport(pi);
        definition = pi.registerVirtualModel.mock.calls[0]?.[0];
        await flushBackgroundScan();
      },
      {
        config: { model_groups: { dynamic: { method: 'dynamic' } } },
        disableNetwork: true,
      }
    );
    expect(definition).toMatchObject({ provider: 'router', id: 'dynamic' });
    // virtualGroupContextWindow never goes below its 32k floor.
    expect(definition.contextWindow).toBeGreaterThanOrEqual(32_768);
  }, 30000);
});
