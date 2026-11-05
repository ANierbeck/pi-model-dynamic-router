// Shared ollama-utils mock module factory (Prettier round step 5,
// docs/plans/2026-11-05-prettier-formatting.md). 25 test files mock
// '../src/ollama-utils' with the same two-export shape — the one-time
// reformat would normalise those near-identical mock blocks into shared
// windows, so the shape is owned here once, before the reformat.
//
// Mock factories are hoisted above the imports, so a test cannot pass
// variables in from outside; the standard usage is the async factory with
// all options inline:
//
//   vi.mock('<module path>', async () => {
//     const { ollamaMockModule } = await import('./helpers/ollama-mock.ts');
//     return ollamaMockModule({ category: 'code_complex', reason: 'complex refactor' });
//   });
//
// A test that needs the mock itself imports the mocked module afterwards:
//   const { callOllama } = await import('../src/ollama-utils.ts');

import { vi } from 'vitest';

export interface OllamaMockOptions {
  /** Classification the mocked callOllama returns. Default 'simple'. */
  category?: string;
  /** Reason string in the mocked classification. Default 'test'. */
  reason?: string;
  /** Confidence in the mocked classification. Default 0.9. */
  confidence?: number;
  /** Whether the daemon probe answers. Default true. */
  available?: boolean;
  /** Replaces the whole callOllama mock (plain vi.fn(), mockRejectedValue, ...). */
   
  callOllama?: any;
  /** Extra module exports (isOllamaWedged, isOllamaProbablyDown, ...). */
   
  extra?: Record<string, any>;
}

/** The mocked ollama-utils module: a classifying callOllama plus the daemon probe. */
 
export function ollamaMockModule(options: OllamaMockOptions = {}): Record<string, any> {
  const { category = 'simple', reason = 'test', confidence = 0.9, available = true, callOllama, extra = {} } = options;
  return {
    callOllama: callOllama ?? vi.fn(async () => JSON.stringify({ category, reason, confidence })),
    isOllamaAvailable: vi.fn(async () => available),
    ...extra,
  };
}

/**
 * The importOriginal variant: keep the real module and stub the ollama
 * seam. The default stubs are the most common shape (plain vi.fn()s — the
 * daemon probe returns undefined, i.e. "down"); pass `overrides` for the
 * variants (an async probe, extra exports).
 */
 
export function ollamaMockPatched(
   
  actual: Record<string, any>,
   
  overrides: Record<string, any> = {}
   
): Record<string, any> {
  return { ...actual, callOllama: vi.fn(), isOllamaAvailable: vi.fn(), ...overrides };
}
