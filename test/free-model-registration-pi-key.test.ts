/**
 * ADR-0022: free-model registration obtains the API key from Pi (the
 * injected resolveApiKey, wired to modelRegistry.getApiKeyForProvider) —
 * never from cfg.providers[].keys, never from auth.json, and never through
 * key rotation. A provider whose key pi cannot resolve is skipped, exactly
 * like a provider with an unresolvable key was before.
 */
import { describe, it, expect, vi } from 'vitest';
import { createFreeModelRegistration } from '../src/free-model-registration.ts';
import type { Config } from '../src/types.ts';

function baseRt(opts: { resolveApiKey: (p: string) => Promise<string | null> }) {
  const registerProvider = vi.fn();
  const rt = {
    cfg: {
      providers: {
        openrouter: {
          // cfg keys are DEAD under ADR-0022 — garbage here proves they are
          // never consulted.
          keys: [{ key: '__auth_json__:openrouter-prod' }],
          free_models: ['openrouter/test-vendor/fixture-model:free'],
        },
      },
    } as unknown as Config,
    pi: {
      registerProvider,
    },
    sessionCtx: {
      modelRegistry: {
        getRegisteredProviderIds: () => [] as string[],
        find: (p: string, m: string) => p === 'openrouter' && m === 'test-vendor/fixture-model:free',
      },
    },
    resolveApiKey: opts.resolveApiKey,
  };
  return { rt, registerProvider };
}

describe('free-model registration resolves keys via pi (ADR-0022)', () => {
  it('registers with the key from the injected pi resolver, ignoring cfg keys', async () => {
    const { rt, registerProvider } = baseRt({
      resolveApiKey: async () => 'sk-from-pi',
    });
    const { registerFreeModelOnDemand } = createFreeModelRegistration(rt as never);

    const ok = await registerFreeModelOnDemand('openrouter', 'test-vendor/fixture-model:free');
    expect(ok).toBe(true);
    expect(registerProvider).toHaveBeenCalledTimes(1);
    const [, opts] = registerProvider.mock.calls[0] as [string, { apiKey?: string }];
    expect(opts.apiKey).toBe('sk-from-pi');
  });

  it('skips the provider when pi cannot resolve a key (no registration, no throw)', async () => {
    const { rt, registerProvider } = baseRt({ resolveApiKey: async () => null });
    const { registerFreeModelOnDemand } = createFreeModelRegistration(rt as never);

    const ok = await registerFreeModelOnDemand('openrouter', 'test-vendor/fixture-model:free');
    expect(ok).toBe(false);
    expect(registerProvider).not.toHaveBeenCalled();
  });

  it('never overwrites a provider pi already knows (Ü1 invariant)', async () => {
    const { rt, registerProvider } = baseRt({ resolveApiKey: async () => 'sk-from-pi' });
    (rt.sessionCtx.modelRegistry as any).getRegisteredProviderIds = () => ['openrouter'];
    const { registerFreeModelOnDemand } = createFreeModelRegistration(rt as never);

    const ok = await registerFreeModelOnDemand('openrouter', 'test-vendor/fixture-model:free');
    expect(ok).toBe(false);
    expect(registerProvider).not.toHaveBeenCalled();
  });

  it('exposes an async interface (returns a Promise)', () => {
    const { rt } = baseRt({ resolveApiKey: async () => 'k' });
    const { registerFreeModelOnDemand } = createFreeModelRegistration(rt as never);
    const r = registerFreeModelOnDemand('openrouter', 'test-vendor/fixture-model:free');
    expect(r).toBeInstanceOf(Promise);
    // Don't leave an unhandled rejection behind.
    r.catch(() => false);
  });
});
