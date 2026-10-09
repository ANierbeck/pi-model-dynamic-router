// test/classifier-laya-config.test.ts

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../src/types.ts';
import { deepMergeConfig, validateClassifierLaya } from '../src/config-loader.ts';

describe('classifier-laya-config', () => {
  const base = JSON.parse(
    readFileSync(join(__dirname, '..', 'router-config.json'), 'utf-8')
  ) as Config;

  describe('shipped default', () => {
    it('stage is inactive (enabled:false) when the user does not configure it', () => {
      // the shipped router-config.json now ships a default block that is disabled
      expect(base.classifier_laya?.enabled).toBe(false);
      expect(base.classifier_laya?.checkpoint).toBeUndefined();
    });

    it('the shipped config block is enabled:false and carries no checkpoint', () => {
      const withBlock = deepMergeConfig(base, {
        classifier_laya: { enabled: false },
      }) as Config;
      expect(withBlock.classifier_laya?.enabled).toBe(false);
      expect(withBlock.classifier_laya?.checkpoint).toBeUndefined();
    });
  });

  describe('validation (enabled:true requires a pinned checkpoint)', () => {
    it('throws a clear error when enabled:true but checkpoint is missing', () => {
      const cfg = deepMergeConfig(base, { classifier_laya: { enabled: true } }) as Config;
      expect(() => validateClassifierLaya(cfg)).toThrow(/checkpoint' is required when enabled:true/);
    });

    it('accepts enabled:true with a pinned checkpoint and applies defaults', () => {
      const cfg = deepMergeConfig(
        base,
        {
          classifier_laya: {
            enabled: true,
            checkpoint: 'aac6fef/laya-multilingual-mlx:f2b4faf51023039425946074e2cf1361d2db11d5',
          },
        }
      ) as Config;
      validateClassifierLaya(cfg);
      expect(cfg.classifier_laya?.enabled).toBe(true);
      expect(cfg.classifier_laya?.checkpoint).toBe(
        'aac6fef/laya-multilingual-mlx:f2b4faf51023039425946074e2cf1361d2db11d5'
      );
      expect(cfg.classifier_laya?.endpoint).toBe('http://127.0.0.1:8089');
      expect(cfg.classifier_laya?.timeout_ms).toBe(1500);
      expect(cfg.classifier_laya?.confidence_threshold).toBe(0.8);
      expect(cfg.classifier_laya?.mode).toBe('shadow');
    });

    it('respects user-provided endpoint / timeout / threshold / mode when enabled', () => {
      const cfg = deepMergeConfig(
        base,
        {
          classifier_laya: {
            enabled: true,
            checkpoint: 'x/y',
            endpoint: 'http://127.0.0.1:9999',
            timeout_ms: 3000,
            confidence_threshold: 0.9,
            mode: 'active',
          },
        }
      ) as Config;
      validateClassifierLaya(cfg);
      expect(cfg.classifier_laya?.endpoint).toBe('http://127.0.0.1:9999');
      expect(cfg.classifier_laya?.timeout_ms).toBe(3000);
      expect(cfg.classifier_laya?.confidence_threshold).toBe(0.9);
      expect(cfg.classifier_laya?.mode).toBe('active');
    });

    it('enabled:false keeps checkpoint absent and needs no defaults', () => {
      const cfg = deepMergeConfig(
        base,
        { classifier_laya: { enabled: false, checkpoint: 'x/y' } } as any
      ) as Config;
      validateClassifierLaya(cfg); // throws nothing
      expect(cfg.classifier_laya?.enabled).toBe(false);
    });
  });
});
