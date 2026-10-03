/**
 * Regression test: the virtual group providers were registered with a
 * hardcoded contextWindow (`resolvedMetrics ? 200_000 : 128_000`). For
 * `method: 'dynamic'` groups resolve() is never called, so resolvedMetrics
 * was ALWAYS null and the dynamic group ALWAYS advertised 128k. Pi compacts
 * when contextTokens > contextWindow - reserveTokens (16384), i.e. at ~112k
 * — in a live session on 2026-10-03 that produced three auto-compactions
 * in 22 minutes (tokensBefore 114,056 / 115,180 / 111,899) while the model
 * actually serving the turns (mistral/zai-glm-5-3) has a 1M window.
 *
 * Fix: the group window is derived from the real windows of the group's
 * candidates (max — the pre-flight guard in driveStream skips candidates too
 * small for the current context), capped at VIRTUAL_GROUP_CONTEXT_CAP
 * (250k, owner decision 2026-10-03) to bound per-request token cost against
 * the Mistral token cap. Unknown windows fall back to Pi's 128k default.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createGroupRegistration,
  virtualGroupContextWindow,
  VIRTUAL_GROUP_CONTEXT_CAP,
} from '../src/group-registration.ts';

const WINDOWS: Record<string, number> = {
  'mistral/zai-glm-5-3': 1_000_000,
  'claude-bridge/claude-opus-5-5': 200_000,
  'ollama/gemma2:2b': 8_192,
  'ollama/qwen3.5': 32_768,
};
const lookup = (ref: string) => WINDOWS[ref] ?? null;

describe('virtualGroupContextWindow()', () => {
  it('caps large candidate windows at 250k', () => {
    expect(VIRTUAL_GROUP_CONTEXT_CAP).toBe(250_000);
    expect(virtualGroupContextWindow(['claude-bridge/claude-opus-5-5', 'mistral/zai-glm-5-3'], lookup)).toBe(250_000);
  });

  it('uses the real max window when every candidate is below the cap', () => {
    expect(virtualGroupContextWindow(['ollama/gemma2:2b', 'ollama/qwen3.5'], lookup)).toBe(32_768);
  });

  it("falls back to Pi's 128k default when no candidate window is known", () => {
    expect(virtualGroupContextWindow([], lookup)).toBe(128_000);
    expect(virtualGroupContextWindow(['unknown/model'], lookup)).toBe(128_000);
  });

  it('floors tiny-window groups at 32k so compaction does not fire on every turn', () => {
    // Pi reserves 16,384 tokens (reserveTokens) below the advertised window;
    // a group whose largest real window is 8,192 would trip the compaction
    // check (contextTokens > window - reserve) on EVERY turn.
    expect(virtualGroupContextWindow(['ollama/gemma2:2b'], lookup)).toBe(32_768);
  });
});

describe('registerGroupProviders(): contextWindow of the virtual models', () => {
  function register() {
    const registerProvider = vi.fn();
    const candidatesByGroup: Record<string, string[]> = {
      standard: ['mistral/zai-glm-5-3', 'claude-bridge/claude-opus-5-5'],
      local: ['ollama/gemma2:2b', 'ollama/qwen3.5'],
    };
    const { registerGroupProviders } = createGroupRegistration({
      cache: {} as any,
      cfg: {
        model_groups: {
          standard: {},
          local: {},
          dynamic: { method: 'dynamic' },
        },
      } as any,
      getM: () => ({}) as any,
      groupStream: vi.fn() as any,
      pi: { registerProvider } as any,
      resolve: (name: string) =>
        candidatesByGroup[name] ? { selected: candidatesByGroup[name][0], candidates: candidatesByGroup[name] } : null,
      sessionCtx: null,
      contextWindow: lookup,
    });
    registerGroupProviders();
    const windowsOf = (group: string) =>
      Object.fromEntries(
        registerProvider.mock.calls
          .find((c: any[]) => c[0] === group)![1]
          .models.map((m: any) => [m.id, m.contextWindow]),
      );
    return windowsOf;
  }

  it('gives the dynamic group the capped window of all static candidates (was always 128k)', () => {
    const windowsOf = register();
    expect(windowsOf('dynamic')).toEqual({ dynamic: 250_000, 'dynamic:use-static': 250_000 });
  });

  it('derives static group windows from their own candidates', () => {
    const windowsOf = register();
    expect(windowsOf('standard')).toEqual({ standard: 250_000 });
    expect(windowsOf('local')).toEqual({ local: 32_768 });
  });
});
