// The classifier configuration block (docs/plans/2026-11-14-config-surface-and-ui.md,
// Phase 1). Classifier keys used to sit on the `dynamic` model group
// (`classifier_cloud_chain`, `classifier_model`, …) and `classifier_log` at the
// top level. They now live in one `classifier` block: `classifier.local`,
// `classifier.cloud`, `classifier.log`. The loader reads the old names for one
// release with a warning (plan decision 2), replacing the 2.0 "no read alias"
// rule of 2026-10-25 for these keys. Unknown keys inside the block are reported
// (decision 4: a typo must not be silently ignored).

import { describe, it, expect, vi } from 'vitest';
import { CONFIG_KEYS, configKey, unknownClassifierKeys } from '../src/config-keys.ts';
import { useConfigLayers } from './helpers/config-layer.ts';

vi.mock('../src/logger.ts', async (orig) => {
  const actual = await orig<typeof import('../src/logger.ts')>();
  return { ...actual, warnLog: vi.fn() };
});

const layers = useConfigLayers('classifier-block');
const { loadWithProjectLayer, loadShipped, warnings } = layers;

describe('the shipped config uses the classifier block', () => {
  it('sets the cloud chain and the log in the block, not on the dynamic group', () => {
    const { config } = loadShipped();
    expect(config.classifier?.cloud?.enabled).toBe(true);
    expect(config.classifier?.log?.store_text).toBe('none');
    expect(config.model_groups.dynamic as Record<string, unknown>).not.toHaveProperty(
      'classifier_cloud_chain'
    );
    expect(config as Record<string, unknown>).not.toHaveProperty('classifier_log');
  });

  it('ships no model name in the block (AGENTS §9)', () => {
    const { config } = loadShipped();
    expect(config.classifier?.local?.model).toBeUndefined();
    expect(config.classifier?.cloud?.model).toBeUndefined();
    expect(config.classifier?.cloud?.candidates ?? []).toEqual([]);
  });
});

describe('a layer that still uses the pre-2.0 classifier keys (read for one release)', () => {
  it('translates the dynamic-group cloud switch, with a warning that names the new path', () => {
    const { config } = loadWithProjectLayer({
      model_groups: { dynamic: { classifier_cloud_chain: false } },
    });
    expect(config.classifier?.cloud?.enabled).toBe(false);
    const w = warnings().filter((m) => m.includes('classifier_cloud_chain'));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('classifier.cloud.enabled');
    expect(
      (config.model_groups.dynamic as Record<string, unknown>).classifier_cloud_chain
    ).toBeUndefined();
  });

  it('translates the oldest name (classifier_cloud_fallback) to the same path', () => {
    const { config } = loadWithProjectLayer({
      model_groups: { dynamic: { classifier_cloud_fallback: false } },
    });
    expect(config.classifier?.cloud?.enabled).toBe(false);
    expect(warnings().some((m) => m.includes('classifier_cloud_fallback'))).toBe(true);
  });

  it('moves the top-level classifier_log block to classifier.log', () => {
    const { config } = loadWithProjectLayer({
      classifier_log: { enabled: true, store_text: 'snippet' },
    });
    expect(config.classifier?.log?.store_text).toBe('snippet');
    expect(config).not.toHaveProperty('classifier_log');
    expect(warnings().some((m) => m.includes('classifier.log'))).toBe(true);
  });

  it('moves the dynamic-group pins to classifier.local and classifier.cloud', () => {
    const { config } = loadWithProjectLayer({
      model_groups: {
        dynamic: {
          classifier_model: 'ollama/qwen-test:1b',
          classifier_fallback: 'ollama/other-test:1b',
          classifier_cloud_model: 'claude-bridge/x-test',
          classifier_cloud_candidates: ['claude-bridge/y-test'],
        },
      },
    });
    expect(config.classifier?.local).toEqual({
      model: 'ollama/qwen-test:1b',
      fallback: 'ollama/other-test:1b',
    });
    expect(config.classifier?.cloud?.model).toBe('claude-bridge/x-test');
    expect(config.classifier?.cloud?.candidates).toEqual(['claude-bridge/y-test']);
  });

  it('keeps the new key when a layer has both, and still warns about the old one', () => {
    const { config } = loadWithProjectLayer({
      classifier: { cloud: { enabled: false } },
      model_groups: { dynamic: { classifier_cloud_chain: true } },
    });
    expect(config.classifier?.cloud?.enabled).toBe(false);
    expect(warnings().some((m) => m.includes('classifier_cloud_chain'))).toBe(true);
  });

  it('does not translate the key on another group: only the dynamic group read it', () => {
    const { config } = loadWithProjectLayer({
      model_groups: { simple: { classifier_cloud_chain: true } },
    });
    expect(config.classifier?.cloud?.enabled).toBe(true); // shipped value, untouched
    const w = warnings().filter((m) => m.includes('classifier_cloud_chain'));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('ignored');
  });
});

describe('unknown keys inside the classifier block are reported', () => {
  it('warns about a typo and names the closest known path', () => {
    loadWithProjectLayer({ classifier: { cloud: { enable: true } } });
    const w = warnings().filter((m) => m.includes('classifier.cloud.enable'));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('classifier.cloud.enabled');
  });

  it('does not apply an unknown key: it is absent from the effective config', () => {
    const { config } = loadWithProjectLayer({ classifier: { cloud: { enable: false } } });
    expect(config.classifier?.cloud).not.toHaveProperty('enable');
    expect(config.classifier?.cloud?.enabled).toBe(true);
  });
});

describe('the key table (src/config-keys.ts)', () => {
  it('has one entry per path and one legacy name per key', () => {
    const paths = CONFIG_KEYS.map((k) => k.path);
    expect(new Set(paths).size).toBe(paths.length);
    const legacy = CONFIG_KEYS.flatMap((k) => k.legacy ?? []);
    expect(new Set(legacy).size).toBe(legacy.length);
  });

  it('marks the switch as classifier.cloud.enabled and lists its legacy names', () => {
    const spec = configKey('classifier.cloud.enabled');
    expect(spec?.kind).toBe('boolean');
    expect(spec?.legacy).toEqual(
      expect.arrayContaining(['classifier_cloud_chain', 'classifier_cloud_fallback'])
    );
  });

  it('recognises known and unknown classifier paths', () => {
    expect(unknownClassifierKeys({ cloud: { enabled: true }, log: { keep: 3 } })).toEqual([]);
    expect(unknownClassifierKeys({ cloud: { enable: true } })).toEqual(['cloud.enable']);
  });
});
