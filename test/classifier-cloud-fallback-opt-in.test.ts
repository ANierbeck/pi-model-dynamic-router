// test/classifier-cloud-fallback-opt-in.test.ts
// Data-minimization regression: classifyPrompt() must never send prompt
// content to a cloud model unless the caller explicitly passes
// allowCloudFallback: true. A provider configured with free_models (for
// normal answering fallback) must not silently also receive prompt content
// for classification purposes.

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { classifyPrompt } from '../src/content-classifier.js';
import * as ollamaUtils from '../src/ollama-utils';
import type { Config, Cache } from '../src/types.ts';

vi.mock('../src/ollama-utils', () => ({
  callOllama: vi.fn(),
}));

const originalFetch = globalThis.fetch;

const cfgWithFreeModel: Config = {
  providers: {
    openrouter: {
      keys: [{ key: 'test-api-key' }],
      free_models: ['openrouter/qwen/qwen3-4b:free'],
    },
  },
  model_groups: {},
  model_metrics: {},
};
const cache: Cache = {};

describe('classifyPrompt cloud fallback opt-in', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(ollamaUtils.callOllama).mockRejectedValue(new Error('ollama unavailable'));
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('does not call any cloud model when allowCloudFallback is omitted, even with a configured free_models provider', async () => {
    const result = await classifyPrompt('a reasonably long prompt to avoid short-circuiting', {
      cfg: cfgWithFreeModel,
      cache,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.category).toBe('fallback');
  });

  it('does not call any cloud model when allowCloudFallback is explicitly false', async () => {
    await classifyPrompt('a reasonably long prompt to avoid short-circuiting', {
      cfg: cfgWithFreeModel,
      cache,
      allowCloudFallback: false,
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it('does call the cloud model when allowCloudFallback is explicitly true', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            {
              message: {
                content: '{"category": "code_simple", "reason": "cloud", "confidence": 0.9}',
              },
            },
          ],
        }),
    } as Response);

    const result = await classifyPrompt('a reasonably long prompt to avoid short-circuiting', {
      cfg: cfgWithFreeModel,
      cache,
      allowCloudFallback: true,
    });

    expect(fetch).toHaveBeenCalled();
    expect(result.category).toBe('code_simple');
  });
});
