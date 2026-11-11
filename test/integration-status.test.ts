// test/integration-status.test.ts
//
// The "Integrations" view (plan 2026-11-08-optional-integrations-config.md,
// open step): one renderer that enumerates every KNOWN integration, not just
// the configured ones, so a switched-off Laya is still listed and says how to
// switch it on. Health comes from the registry by name.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  formatIntegrationLines,
  checkIntegrationPatch,
  resetIntegrationHealth,
  setIntegrationHealth,
  type IntegrationSpec,
} from '../src/integration.ts';
import { INTEGRATION_SPECS } from '../src/integration-registry.ts';
import { resetLayaAvailability } from '../src/laya-classifier.ts';

const SPECS: Readonly<Record<string, IntegrationSpec>> = INTEGRATION_SPECS;

describe('formatIntegrationLines', () => {
  beforeEach(() => {
    resetIntegrationHealth();
    resetLayaAvailability();
  });

  it('lists every known integration, even one that is not configured at all', () => {
    const lines = formatIntegrationLines({}, SPECS);
    expect(lines.join('\n')).toContain('laya: off');
  });

  it('tells the user how to switch an off integration on', () => {
    const out = formatIntegrationLines({}, SPECS).join('\n');
    expect(out).toContain('/router config integration laya on');
  });

  it('shows an enabled integration with its mode, endpoint and reported version', () => {
    setIntegrationHealth('laya', { state: 'ok', version: 'r2@1.0.0' });
    const out = formatIntegrationLines(
      {
        laya: {
          enabled: true,
          mode: 'active',
          endpoint: 'http://127.0.0.1:8089',
          checkpoint: 'r2@1.0.0',
        },
      },
      SPECS
    ).join('\n');
    expect(out).toContain('laya: on (active)');
    expect(out).toContain('http://127.0.0.1:8089');
    expect(out).toContain('reachable');
    expect(out).toContain('r2@1.0.0');
  });

  it('shows a down integration with its last error, and an unprobed one as not probed yet', () => {
    setIntegrationHealth('laya', { state: 'down', lastError: 'connect ECONNREFUSED' });
    const down = formatIntegrationLines({ laya: { enabled: true, mode: 'shadow' } }, SPECS).join(
      '\n'
    );
    expect(down).toContain('unreachable (connect ECONNREFUSED)');
    resetIntegrationHealth();
    const fresh = formatIntegrationLines({ laya: { enabled: true, mode: 'shadow' } }, SPECS).join(
      '\n'
    );
    expect(fresh).toContain('not probed yet');
  });

  it('flags a configured name that is not a known integration, instead of ignoring it', () => {
    const out = formatIntegrationLines(
      { laya: { enabled: false }, codexbr: { enabled: true } },
      SPECS
    ).join('\n');
    expect(out).toContain('"codexbr" is not a known integration');
  });
});

describe('checkIntegrationPatch', () => {
  const laya = SPECS.laya as IntegrationSpec;

  it('accepts a boolean enabled and a mode the spec allows', () => {
    expect(checkIntegrationPatch(laya, { enabled: true })).toBeUndefined();
    expect(checkIntegrationPatch(laya, { enabled: false, mode: 'shadow' })).toBeUndefined();
  });

  it('refuses a mode the spec does not allow, naming the allowed ones', () => {
    const err = checkIntegrationPatch(laya, { mode: 'yolo' });
    expect(err).toContain('yolo');
    expect(err).toContain('active');
    expect(err).toContain('shadow');
  });

  it('refuses a non-boolean enabled (the string "false" is truthy)', () => {
    expect(checkIntegrationPatch(laya, { enabled: 'false' as unknown as boolean })).toBeDefined();
  });
});

describe('formatIntegrationLines — what it shows', () => {
  beforeEach(() => {
    resetIntegrationHealth();
    resetLayaAvailability();
  });

  it('still shows the last health of a switched-off integration', () => {
    setIntegrationHealth('laya', { state: 'down', lastError: 'connect ECONNREFUSED' });
    const out = formatIntegrationLines({ laya: { enabled: false } }, SPECS).join('\n');
    expect(out).toContain('laya: off');
    expect(out).toContain('unreachable (connect ECONNREFUSED)');
  });

  it('does not present the configured checkpoint as the version the sidecar reported', () => {
    setIntegrationHealth('laya', { state: 'ok' });
    const out = formatIntegrationLines(
      { laya: { enabled: true, mode: 'shadow', checkpoint: 'r2@1.0.0' } },
      SPECS
    ).join('\n');
    expect(out).toContain('reachable (no version reported)');
    expect(out).not.toContain('reachable (r2@1.0.0)');
  });

  it('keeps the version a down sidecar last served', () => {
    setIntegrationHealth('laya', { state: 'down', version: 'r2@1.0.0', lastError: 'timeout' });
    const out = formatIntegrationLines({ laya: { enabled: true, mode: 'shadow' } }, SPECS).join(
      '\n'
    );
    expect(out).toContain('last served r2@1.0.0');
    expect(out).toContain('timeout');
  });

  it('strips terminal control sequences and line breaks from the last error', () => {
    setIntegrationHealth('laya', { state: 'down', lastError: 'boom\u001b[31m red\nFORGED line' });
    const out = formatIntegrationLines({ laya: { enabled: true, mode: 'shadow' } }, SPECS).join(
      '\n'
    );
    expect(out).not.toContain('\u001b');
    expect(out).not.toContain('\nFORGED');
    expect(out).toContain('boom');
  });

  it('redacts credentials in the endpoint URL', () => {
    const out = formatIntegrationLines(
      {
        laya: {
          enabled: true,
          mode: 'shadow',
          endpoint: 'http://ops-admin:s3cret@127.0.0.1:8089',
          checkpoint: 'r2@1.0.0',
        },
      },
      SPECS
    ).join('\n');
    expect(out).not.toContain('s3cret');
    expect(out).not.toContain('ops-admin');
    expect(out).toContain('127.0.0.1:8089');
  });
});
