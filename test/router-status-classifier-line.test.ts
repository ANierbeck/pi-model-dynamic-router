// /router status honesty: the dynamic-group block must show the classifier
// that ACTUALLY classified (cloud chain vs local Ollama), not a hardcoded
// "via Ollama (gemma2:2b)". Regression test for the 2026-10-02 finding that
// the status claimed local Ollama while the cloud fallback chain
// (mistral/ministral-3b-latest et al.) was doing all the work.
//
// Part 1: content-classifier records the backend that produced the last
// classification (getLastClassificationSource).
// Part 2: commands.formatClassifierStatus renders that record + live chain
// state — no hardcoded model claims.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/ollama-utils', () => {
  const ollamaUtils = {
    callOllama: vi.fn(),
    isOllamaAvailable: vi.fn(async () => true),
    isOllamaWedged: vi.fn(() => false),
  };
  return ollamaUtils;
});

import { callOllama } from '../src/ollama-utils';
import { classifyPrompt, getLastClassificationSource, type ClassificationSourceInfo } from '../src/content-classifier.ts';
import { formatClassifierStatus } from '../src/commands.ts';
import type { Group } from '../src/types.ts';

const VALID_JSON = JSON.stringify({
  category: 'trivial',
  reason: 'test',
  confidence: 0.9,
});

function baseDynamicGroup(overrides: Partial<Group> = {}): Group {
  return {
    name: 'dynamic',
    method: 'dynamic',
    description: 'content-based routing',
    models: [],
    classifier_model: 'ollama/mistral-nemo:latest',
    classifier_fallback: 'ollama/gemma2:2b',
    classifier_cloud_fallback: true,
    ...overrides,
  } as unknown as Group;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(callOllama).mockReset();
});

describe('getLastClassificationSource — who actually classified', () => {
  it('records the local Ollama model after a local classification', async () => {
    vi.mocked(callOllama).mockResolvedValue(VALID_JSON);
    await classifyPrompt('read the file src/utils.ts and summarize it');
    expect(getLastClassificationSource()?.source).toBe('ollama:mistral-nemo:latest');
  });

  it('records the cloud model after a cloud-fallback classification', async () => {
    vi.mocked(callOllama).mockReset(); // cloud path must not need Ollama
    const result = await classifyPrompt('please structure the module list carefully for us', {
      allowCloudFallback: true,
      cfg: { model_groups: {} } as any,
      cache: { classifier_fallback_models: ['mistral/ministral-3b-latest'] } as any,
      completeSimple: vi.fn(async () => ({
        content: [{ type: 'text', text: VALID_JSON }],
        stopReason: 'stop',
      })),
      findModel: vi.fn(() => ({})),
    });
    expect(result.category).toBe('trivial');
    expect(getLastClassificationSource()?.source).toBe('cloud:mistral/ministral-3b-latest');
  });

  it('records deterministic HINT resolution without any LLM', async () => {
    await classifyPrompt('HINT: use mistral/zai-glm-5-3 please fix the failing test');
    expect(getLastClassificationSource()?.source).toBe('hint');
  });

  it('records short-prompt momentum inheritances', async () => {
    await classifyPrompt('yes please do it', {
      context: { lastCategory: 'code_complex' },
    });
    expect(getLastClassificationSource()?.source).toBe('momentum');
  });

  it('records cache hits on repeated identical prompts', async () => {
    const prompt = 'list all modules in this very unique cache probe prompt xyzzy1';
    vi.mocked(callOllama).mockResolvedValue(VALID_JSON);
    await classifyPrompt(prompt);
    expect(getLastClassificationSource()?.source).toBe('ollama:mistral-nemo:latest');
    // Second identical call with no context must hit the classification cache.
    await classifyPrompt(prompt);
    expect(getLastClassificationSource()?.source).toBe('cache');
  });
});

describe('formatClassifierStatus — honest /router status lines', () => {
  const last = (source: string): ClassificationSourceInfo => ({ source, at: Date.now() });

  it('shows the actual classifier and the real chain (cloud-first, Ollama down)', () => {
    const lines = formatClassifierStatus({
      group: baseDynamicGroup(),
      last: last('cloud:mistral/ministral-3b-latest'),
      probedCount: 7,
      ollamaUp: false,
    });
    expect(lines.some((l) => l.includes('cloud:mistral/ministral-3b-latest (last used)'))).toBe(true);
    // The chain must reflect execution order: cloud BEFORE Ollama (cloud-first
    // 2026-09-27), and Ollama must be reported as down, not silently claimed.
    const chain = lines.find((l) => l.includes('Chain:')) ?? '';
    expect(chain).toContain('cloud');
    expect(chain.indexOf('cloud')).toBeLessThan(chain.indexOf('Ollama'));
    expect(chain).toContain('Ollama (down');
    expect(chain).toContain('mistral-nemo:latest');
    expect(chain).toContain('gemma2:2b');
    expect(chain).toContain('7 probed');
    // The old hardcoded claim must be gone.
    expect(lines.join('\n')).not.toContain('via Ollama (gemma2:2b)');
  });

  it('reports Ollama as up when it actually is', () => {
    const lines = formatClassifierStatus({
      group: baseDynamicGroup(),
      last: last('ollama:mistral-nemo:latest'),
      probedCount: 3,
      ollamaUp: true,
    });
    const chain = lines.find((l) => l.includes('Chain:')) ?? '';
    expect(chain).toContain('Ollama (up');
  });

  it('says when no classification ran yet this session', () => {
    const lines = formatClassifierStatus({
      group: baseDynamicGroup(),
      last: null,
      probedCount: 7,
      ollamaUp: false,
    });
    expect(lines.some((l) => l.includes('none yet this session'))).toBe(true);
  });

  it('omits the cloud leg when classifier_cloud_fallback is disabled', () => {
    const lines = formatClassifierStatus({
      group: baseDynamicGroup({ classifier_cloud_fallback: false }),
      last: last('ollama:gemma2:2b'),
      probedCount: 0,
      ollamaUp: true,
    });
    const chain = lines.find((l) => l.includes('Chain:')) ?? '';
    expect(chain).not.toContain('cloud');
    expect(chain).toContain('Ollama (up');
  });

  it('shows a pinned cloud classifier ahead of the probed list', () => {
    const lines = formatClassifierStatus({
      group: baseDynamicGroup({ classifier_cloud_model: 'mistral/zai-glm-5-3' }),
      last: last('cloud:mistral/zai-glm-5-3'),
      probedCount: 5,
      ollamaUp: false,
    });
    const chain = lines.find((l) => l.includes('Chain:')) ?? '';
    expect(chain).toContain('pinned mistral/zai-glm-5-3');
    expect(chain).toContain('5 probed');
  });
});
