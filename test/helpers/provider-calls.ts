/**
 * One `pi.registerProvider` call in the `{ name, opts }` shape the tests
 * read. The router registers its group providers as native pi-ai providers
 * (`registerProvider(provider)`, plan
 * docs/plans/2026-11-21-virtual-models-migration.md step 2) and every other
 * provider as `registerProvider(name, config)`. A native provider becomes
 * its id and a live view: `opts.models` reads `getModels()` on every access,
 * so a test sees what Pi's catalog sees at that moment.
 */
export interface ProviderCall {
  name: string;
  opts: any;
}

export function providerCall(nameOrProvider: any, config?: any): ProviderCall {
  if (typeof nameOrProvider === 'string') return { name: nameOrProvider, opts: config };
  const provider = nameOrProvider;
  return {
    name: provider.id,
    opts: {
      get models() {
        return provider.getModels();
      },
      streamSimple: provider.streamSimple,
      native: provider,
    },
  };
}

/** Every recorded call of a `vi.fn()` registerProvider, normalized. */
export function providerCalls(mock: { mock: { calls: any[][] } }): ProviderCall[] {
  return mock.mock.calls.map((call) => providerCall(call[0], call[1]));
}
