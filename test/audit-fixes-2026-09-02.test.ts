// test/audit-fixes-2026-09-02.test.ts
// Regression tests for the architecture-review findings fixed in the
// 2026-09-02 audit pass:
//   F6  — HINT without a colon is recognized (see also hint-classification.test.ts)
//   F8  — isScanCacheValid() rejects a fresh-but-EMPTY cache (forces rescan)
//   F11 — stripProvider() recognizes pi-registered providers (pi-claude, etc.)
//
// F2 (empty repo-root .cache) is resolved by the F8 fix + deleting the stale
// file; no separate test (it's a hygiene artifact, not a code path).
// F5 (escalation on hard-coded fallback) is covered by classifier-integration
// tests; F7 (getCheapestCloudModels quality floor) is moot — the function was
// deleted (dead code) in favor of the probe-based discovery.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CacheManager } from '../src/cache.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { stripProvider, setConfig, setPiRegisteredProviders, getPiRegisteredProviders } from '../src/metrics.ts';
import type { Config } from '../src/types.ts';

// ── F8: isScanCacheValid rejects a fresh-but-empty cache ──────────────────

describe('F8: isScanCacheValid rejects a fresh-but-empty cache', () => {
  let tmpDir: string;
  let cm: CacheManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-cache-test-'));
    cm = new CacheManager(tmpDir);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects a cache with no lastScanTimestamp (unchanged — always was false)', () => {
    expect(cm.isScanCacheValid()).toBe(false);
  });

  it('accepts a fresh cache WITH available models (unchanged)', () => {
    cm.updateCache({
      lastScanTimestamp: Date.now(),
      available_models: [{ id: 'test-model', provider: 'test', cost_per_m: 0 }],
    });
    expect(cm.isScanCacheValid()).toBe(true);
  });

  it('F8: rejects a fresh cache with ZERO available models (forces rescan)', () => {
    // Regression: the repo-root .cache/scan-cache.json had a fresh
    // lastScanTimestamp but available_models: 0. It passed the 30-day
    // freshness check, so neither it nor the populated dist cache triggered
    // a rescan — tests/dev ran against zero models. Now an empty-but-fresh
    // cache is invalid so the next scan repopulates it.
    cm.updateCache({
      lastScanTimestamp: Date.now(),
      available_models: [],
    });
    expect(cm.isScanCacheValid()).toBe(false);
  });

  it('F8: accepts an empty cache only when timestamp is also stale (rescan either way)', () => {
    const stale = Date.now() - 31 * 24 * 60 * 60 * 1000; // 31 days ago
    cm.updateCache({
      lastScanTimestamp: stale,
      available_models: [],
    });
    expect(cm.isScanCacheValid()).toBe(false);
  });

  it('rejects a future timestamp (no time travel)', () => {
    cm.updateCache({
      lastScanTimestamp: Date.now() + 10000,
      available_models: [{ id: 'test-model', provider: 'test', cost_per_m: 0 }],
    });
    expect(cm.isScanCacheValid()).toBe(false);
  });
});

// ── F11: stripProvider recognizes pi-registered providers ─────────────────

describe('F11: stripProvider recognizes pi-registered providers', () => {
  beforeEach(() => {
    // Reset to a clean config (no providers) and no pi-registered providers.
    setConfig({ model_groups: {}, model_metrics: {}, providers: {} });
    setPiRegisteredProviders([]);
  });
  afterEach(() => {
    setConfig({ model_groups: {}, model_metrics: {}, providers: {} });
    setPiRegisteredProviders([]);
  });

  it('strips a PROVIDER_MAP provider (unchanged)', () => {
    expect(stripProvider('openrouter/z-ai/glm-5.2:free')).toBe('z-ai/glm-5.2:free');
    expect(stripProvider('mistral-zai/mistral-small-latest')).toBe('mistral-small-latest');
  });

  it('strips a cfg.providers provider (unchanged)', () => {
    const cfg: Config = { model_groups: {}, model_metrics: {}, providers: { 'my-provider': { keys: [] } } } as any;
    setConfig(cfg);
    expect(stripProvider('my-provider/some-model')).toBe('some-model');
  });

  it('F11: strips a pi-registered provider not in PROVIDER_MAP or cfg.providers', () => {
    // pi-claude is registered by pi (claude-bridge extension) but the router
    // has no static PROVIDER_MAP entry for it. Without the F11 fix,
    // stripProvider left 'pi-claude/claude-sonnet-5' intact → GDPval/price
    // inference never resolved the model id.
    setPiRegisteredProviders(['pi-claude', 'claude-bridge', 'ollama']);
    expect(stripProvider('pi-claude/claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(stripProvider('claude-bridge/claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('F11: leaves an unrecognized provider intact (no false strip)', () => {
    // An unknown first segment might be part of the model id, not a provider.
    // stripProvider must not strip it.
    setPiRegisteredProviders(['pi-claude']);
    expect(stripProvider('unknown-provider/some-model')).toBe('unknown-provider/some-model');
    expect(stripProvider('just-a-model-id')).toBe('just-a-model-id');
  });

  it('F11: setPiRegisteredProviders replaces (not merges) the set', () => {
    setPiRegisteredProviders(['a', 'b']);
    expect([...getPiRegisteredProviders()].sort()).toEqual(['a', 'b']);
    setPiRegisteredProviders(['c']);
    expect([...getPiRegisteredProviders()].sort()).toEqual(['c']);
  });

  it('F11: all three sources are checked (PROVIDER_MAP OR cfg OR pi-registry)', () => {
    // A provider in cfg.providers but not PROVIDER_MAP nor pi-registry still strips.
    const cfg: Config = { model_groups: {}, model_metrics: {}, providers: { 'cfg-only': { keys: [] } } } as any;
    setConfig(cfg);
    setPiRegisteredProviders(['pi-only']);
    expect(stripProvider('cfg-only/model')).toBe('model');
    expect(stripProvider('pi-only/model')).toBe('model');
    expect(stripProvider('openrouter/model')).toBe('model'); // PROVIDER_MAP
    expect(stripProvider('none-of-the-above/model')).toBe('none-of-the-above/model');
  });
});
