// test/provider-watchdog.test.ts
// Local-provider watchdog (ADR-0016): a wedged Ollama daemon answers its API
// but times out every generation (MLX runner stuck in "Stopping…", live
// 2026-09-25/26). The watchdog detects it from timeouts across distinct
// local models and skips the provider for a cooldown instead of burning a
// full timeout per local candidate.

import { describe, it, expect } from 'vitest';
import {
  WEDGE_WINDOW_MS,
  WEDGE_COOLDOWN_MS,
  recordLocalTimeout,
  recordLocalSuccess,
  isProviderWedged,
} from '../src/provider-watchdog.ts';
import type { Cache } from '../src/types.ts';

describe('provider watchdog', () => {
  it('flags the provider after timeouts on two distinct local models', () => {
    const cache: Cache = {};
    expect(recordLocalTimeout(cache, 'ollama/gemma4:12b-mlx', 0)).toBe(false);
    expect(isProviderWedged(cache, 'ollama', 1)).toBe(false);
    expect(recordLocalTimeout(cache, 'ollama/ornith:9b', 30_000)).toBe(true);
    expect(isProviderWedged(cache, 'ollama', 30_001)).toBe(true);
  });

  it('does not flag repeated timeouts of one slow model', () => {
    const cache: Cache = {};
    for (let i = 0; i < 5; i++) recordLocalTimeout(cache, 'ollama/qwen3.8:27b-mlx', i * 30_000);
    expect(isProviderWedged(cache, 'ollama', 200_000)).toBe(false);
  });

  it('ignores timeouts older than the window', () => {
    const cache: Cache = {};
    recordLocalTimeout(cache, 'ollama/a', 0);
    expect(recordLocalTimeout(cache, 'ollama/b', WEDGE_WINDOW_MS + 1)).toBe(false);
    expect(isProviderWedged(cache, 'ollama', WEDGE_WINDOW_MS + 2)).toBe(false);
  });

  it('a local success clears the evidence and the wedge', () => {
    const cache: Cache = {};
    recordLocalTimeout(cache, 'ollama/a', 0);
    recordLocalSuccess(cache, 'ollama/gemma2:2b');
    expect(recordLocalTimeout(cache, 'ollama/b', 1_000)).toBe(false);

    recordLocalTimeout(cache, 'ollama/c', 2_000);
    expect(isProviderWedged(cache, 'ollama', 2_001)).toBe(true);
    recordLocalSuccess(cache, 'ollama/c');
    expect(isProviderWedged(cache, 'ollama', 2_002)).toBe(false);
  });

  it('expires after the cooldown so the provider is probed again', () => {
    const cache: Cache = {};
    recordLocalTimeout(cache, 'ollama/a', 0);
    recordLocalTimeout(cache, 'ollama/b', 1_000);
    expect(isProviderWedged(cache, 'ollama', 1_000 + WEDGE_COOLDOWN_MS - 1)).toBe(true);
    expect(isProviderWedged(cache, 'ollama', 1_000 + WEDGE_COOLDOWN_MS)).toBe(false);
  });

  it('reports "newly wedged" only once per wedge', () => {
    const cache: Cache = {};
    recordLocalTimeout(cache, 'ollama/a', 0);
    expect(recordLocalTimeout(cache, 'ollama/b', 1_000)).toBe(true);
    expect(recordLocalTimeout(cache, 'ollama/c', 2_000)).toBe(false);
  });

  it('tracks providers independently and ignores cloud refs', () => {
    const cache: Cache = {};
    recordLocalTimeout(cache, 'ollama/a', 0);
    recordLocalTimeout(cache, 'lm-studio/b', 1_000);
    expect(isProviderWedged(cache, 'ollama', 1_001)).toBe(false);
    expect(isProviderWedged(cache, 'lm-studio', 1_001)).toBe(false);
    expect(recordLocalTimeout(cache, 'mistral/x', 0)).toBe(false);
    expect(recordLocalTimeout(cache, 'mistral/y', 1)).toBe(false);
    expect(isProviderWedged(cache, 'mistral', 2)).toBe(false);
  });
});
