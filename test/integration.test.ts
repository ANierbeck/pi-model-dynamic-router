// test/integration.test.ts
//
// The integration contract (docs/plans/2026-11-08-optional-integrations-config.md,
// Solution 1): one base config shape, one validator and one health registry
// for every optional external component (Laya today, CodexBar next), instead
// of a per-feature ad-hoc block and validator.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const warnings: string[] = [];
vi.mock('../src/logger.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/logger.ts')>()),
  warnLog: (msg: string): void => {
    warnings.push(msg);
  },
}));
import {
  type IntegrationSpec,
  validateIntegration,
  setIntegrationHealth,
  getIntegrationHealth,
  resetIntegrationHealth,
  type IntegrationHealth,
} from '../src/integration.ts';
import {
  UNAVAILABLE_TTL_MS,
  getLastProbeError,
  layaAvailabilityState,
  probeLaya,
  resetLayaAvailability,
} from '../src/laya-classifier.ts';

/** A minimal spec exercising the whole base contract. */
const baseSpec: IntegrationSpec = {
  name: 'probe',
  label: 'probe',
  modes: ['shadow', 'active'],
  defaultMode: 'shadow',
  defaultTimeoutMs: 1500,
  defaultEndpoint: 'http://127.0.0.1:9999',
};

/** The Laya-shaped extras: a required key plus a numeric fallback. */
const layaishSpec: IntegrationSpec = {
  ...baseSpec,
  name: 'layaish',
  label: 'layaish',
  extraKeys: ['checkpoint', 'confidence_threshold'],
  validateExtra: (block): string | undefined => {
    if (!block.checkpoint) return `'checkpoint' is required when enabled:true`;
    if (
      block.confidence_threshold != null &&
      (typeof block.confidence_threshold !== 'number' ||
        !(block.confidence_threshold >= 0) ||
        !(block.confidence_threshold <= 1))
    ) {
      block.confidence_threshold = 0.8;
    }
    return undefined;
  },
};

describe('validateIntegration (base contract)', () => {
  beforeEach(() => {
    warnings.length = 0;
  });

  it('leaves a disabled or absent block untouched (no defaults filled)', () => {
    const block: Record<string, unknown> = { enabled: false };
    validateIntegration(baseSpec, block);
    expect(block).toEqual({ enabled: false });
    validateIntegration(baseSpec, undefined as never);
  });

  it('fills the defaults on an enabled block: endpoint, timeout_ms, mode', () => {
    const block: Record<string, unknown> = { enabled: true };
    validateIntegration(baseSpec, block);
    expect(block.endpoint).toBe('http://127.0.0.1:9999');
    expect(block.timeout_ms).toBe(1500);
    expect(block.mode).toBe('shadow');
    expect(block.enabled).toBe(true);
  });

  it('accepts every loopback host and keeps a valid endpoint', () => {
    for (const endpoint of [
      'http://127.0.0.1:8089',
      'http://localhost:8089',
      'http://[::1]:8089',
      'https://127.0.0.1:8089',
    ]) {
      const block: Record<string, unknown> = { enabled: true, endpoint };
      validateIntegration(baseSpec, block);
      expect(block.enabled).toBe(true);
      expect(block.endpoint).toBe(endpoint);
    }
  });

  it('disables the integration on a non-loopback endpoint (prompts must not leave the machine)', () => {
    for (const endpoint of ['http://10.0.0.5:8089', 'http://example.com:8089']) {
      const block: Record<string, unknown> = { enabled: true, endpoint };
      validateIntegration(baseSpec, block);
      expect(block.enabled).toBe(false);
      expect(warnings.some((w) => w.includes('probe') && w.includes('not loopback'))).toBe(true);
    }
  });

  it('disables the integration on an unparseable or non-http(s) endpoint', () => {
    for (const endpoint of ['not a url', 'ftp://127.0.0.1:8089']) {
      const block: Record<string, unknown> = { enabled: true, endpoint };
      validateIntegration(baseSpec, block);
      expect(block.enabled).toBe(false);
    }
  });

  it('falls back to the default mode on an unknown mode, with a warning', () => {
    const block: Record<string, unknown> = { enabled: true, mode: 'yolo' };
    validateIntegration(baseSpec, block);
    expect(block.mode).toBe('shadow');
    expect(block.enabled).toBe(true);
    expect(warnings.some((w) => w.includes('probe') && w.includes('mode'))).toBe(true);
  });

  it('falls back to the default timeout_ms on a bad timeout, with a warning', () => {
    for (const timeout_ms of [0, -5, '1500']) {
      const block: Record<string, unknown> = { enabled: true, timeout_ms };
      validateIntegration(baseSpec, block);
      expect(block.timeout_ms).toBe(1500);
      expect(block.enabled).toBe(true);
      expect(warnings.some((w) => w.includes('probe') && w.includes('timeout_ms'))).toBe(true);
    }
  });
});

describe('validateIntegration (extras hook)', () => {
  it('disables the integration when validateExtra returns a fatal reason', () => {
    const block: Record<string, unknown> = { enabled: true };
    validateIntegration(layaishSpec, block);
    expect(block.enabled).toBe(false);
  });

  it('lets validateExtra fix extra fields and keep the integration enabled', () => {
    const block: Record<string, unknown> = {
      enabled: true,
      checkpoint: 'x/y',
      confidence_threshold: 5,
    };
    validateIntegration(layaishSpec, block);
    expect(block.enabled).toBe(true);
    expect(block.confidence_threshold).toBe(0.8);
  });
});

describe('integration health registry', () => {
  beforeEach(() => resetIntegrationHealth());
  afterEach(() => resetIntegrationHealth());

  it('reports state "unknown" for an unregistered integration', () => {
    expect(getIntegrationHealth('nope')).toEqual({ state: 'unknown' } satisfies IntegrationHealth);
  });

  it('round-trips a health entry with lastError, version and lastOkAt', () => {
    setIntegrationHealth('laya', {
      state: 'down',
      lastError: 'connect ECONNREFUSED',
      lastOkAt: 1234,
    });
    expect(getIntegrationHealth('laya')).toEqual({
      state: 'down',
      lastError: 'connect ECONNREFUSED',
      lastOkAt: 1234,
    });
    setIntegrationHealth('laya', { state: 'ok', version: 'r2@1.0.0', lastOkAt: 5678 });
    expect(getIntegrationHealth('laya')).toEqual({
      state: 'ok',
      version: 'r2@1.0.0',
      lastOkAt: 5678,
    });
  });

  it('an entry with `until` reads as unknown once that time has passed (a TTL-gated probe result)', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    setIntegrationHealth('laya', { state: 'down', lastError: 'x', until: 2_000 });
    now.mockReturnValue(2_000);
    expect(getIntegrationHealth('laya').state).toBe('down');
    now.mockReturnValue(2_001);
    expect(getIntegrationHealth('laya')).toEqual({ state: 'unknown' });
    now.mockRestore();
  });

  it('resetIntegrationHealth(name) clears one entry, resetIntegrationHealth() clears all', () => {
    setIntegrationHealth('a', { state: 'ok' });
    setIntegrationHealth('b', { state: 'down' });
    resetIntegrationHealth('a');
    expect(getIntegrationHealth('a').state).toBe('unknown');
    expect(getIntegrationHealth('b').state).toBe('down');
    resetIntegrationHealth();
    expect(getIntegrationHealth('b').state).toBe('unknown');
  });
});

describe('Laya availability lives in the registry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetLayaAvailability();
  });

  it('a failed probe is down with its error, and reads unknown again after the TTL', async () => {
    resetLayaAvailability();
    // Port 1 on loopback refuses the connection.
    expect(await probeLaya('http://127.0.0.1:1', 300)).toBe(false);
    expect(layaAvailabilityState()).toBe('down');
    expect(getIntegrationHealth('laya').state).toBe('down');
    expect(getLastProbeError()).toBeTruthy();
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(t0 + UNAVAILABLE_TTL_MS + 1);
    expect(layaAvailabilityState()).toBe('unknown');
    expect(getLastProbeError()).toBeNull();
  });
});
