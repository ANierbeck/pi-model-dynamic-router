// test/discovery-key-security.test.ts
// Regression tests for the auth.json plaintext-key leak: discoverKeys() must
// never copy a raw secret from ~/.pi/agent/auth.json into cfg.providers[...].keys,
// since that cfg object can be written back to the tracked router-config.json
// (see update_model_metrics in index.ts). Only reference markers (resolved on
// demand via resolveKeyValue()) may be stored there.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { DiscoveryManager } from '../src/discovery.ts';
import type { Config, Cache } from '../src/types.ts';

function freshCfg(): Config {
  return { providers: {}, model_groups: {}, model_metrics: {} };
}

function freshCache(): Cache {
  return {};
}

describe('DiscoveryManager key security (auth.json)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('discoverKeys() never stores the raw auth.json secret in cfg.providers', () => {
    vi.spyOn(DiscoveryManager.prototype, 'loadAuth').mockReturnValue({
      mistral: { key: 'sk-real-secret-value' },
    });

    const cfg = freshCfg();
    const dm = new DiscoveryManager(cfg, freshCache());
    dm.discoverKeys();

    const mistralKeys = cfg.providers?.mistral?.keys ?? [];
    expect(mistralKeys.length).toBeGreaterThan(0);
    for (const k of mistralKeys) {
      expect(k.key).not.toBe('sk-real-secret-value');
      expect(k.key).not.toContain('sk-real-secret-value');
    }
    // The auth.json-sourced entry must be a resolvable reference marker.
    const authJsonEntry = mistralKeys.find((k) => k.label === 'auth.json');
    expect(authJsonEntry?.key).toBe('__auth_json__:mistral');
  });

  it('resolveKeyValue() resolves the __auth_json__ marker back to the real secret', () => {
    vi.spyOn(DiscoveryManager.prototype, 'loadAuth').mockReturnValue({
      mistral: { key: 'sk-real-secret-value' },
    });

    const dm = new DiscoveryManager(freshCfg(), freshCache());
    expect(dm.resolveKeyValue('__auth_json__:mistral')).toBe('sk-real-secret-value');
  });

  it('resolveKeyValue() resolves the __oauth__ marker via the access token field', () => {
    vi.spyOn(DiscoveryManager.prototype, 'loadAuth').mockReturnValue({
      anthropic: { type: 'oauth', access: 'oauth-access-token', refresh: 'r' },
    });

    const dm = new DiscoveryManager(freshCfg(), freshCache());
    expect(dm.resolveKeyValue('__oauth__:anthropic')).toBe('oauth-access-token');
  });

  it('resolveKeyValue() falls back to the marker itself when auth.json has no matching entry', () => {
    vi.spyOn(DiscoveryManager.prototype, 'loadAuth').mockReturnValue({});

    const dm = new DiscoveryManager(freshCfg(), freshCache());
    expect(dm.resolveKeyValue('__auth_json__:mistral')).toBe('__auth_json__:mistral');
  });

  it('a cfg mutated by discoverKeys() is safe to JSON.stringify and persist to disk', () => {
    vi.spyOn(DiscoveryManager.prototype, 'loadAuth').mockReturnValue({
      mistral: { key: 'sk-real-secret-value' },
      anthropic: { type: 'oauth', access: 'oauth-access-token', refresh: 'r' },
    });

    const cfg = freshCfg();
    const dm = new DiscoveryManager(cfg, freshCache());
    dm.discoverKeys();

    // Simulate exactly what index.ts's update_model_metrics tool does with cfg.
    const serialized = JSON.stringify(cfg, null, 2);
    expect(serialized).not.toContain('sk-real-secret-value');
    expect(serialized).not.toContain('oauth-access-token');
  });
});
