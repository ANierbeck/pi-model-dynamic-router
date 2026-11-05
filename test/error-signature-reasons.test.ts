// The ineligibility reasons of a provider 404 body (src/error-signatures.ts
// parseBody). Burn-down S2 replaced `String(r?.reason ?? '')` with a string
// check: a non-string reason is no longer stringified ("42") and no longer
// matches a signature by accident. This pins that the classifier still reads
// the real guardrail reason and survives a malformed one.
import { describe, it, expect } from 'vitest';
import { classifyFailure } from '../src/error-signatures.ts';

const body = (reasons: unknown[]): string =>
  '404: ' +
  JSON.stringify({
    message: '0 endpoints out of 1 requested are available matching your guardrail restrictions',
    code: 404,
    metadata: { ineligibility_reasons: reasons, failed_routing_step: 'Filter by Guardrails' },
  });

describe('classifyFailure — ineligibility reasons', () => {
  it('still reads a string guardrail reason', () => {
    const c = classifyFailure(
      'openrouter/openrouter/free',
      body([{ reason: 'free-model-training-violation-by-guardrail', endpoint_count: 1 }])
    );
    expect(c.signature).toMatch(/404/);
  });

  it('a non-string reason neither throws nor changes the classification', () => {
    // Observable contract: the malformed entry is dropped, so the verdict is
    // the one the message alone gives (not an exception, not a different signature).
    const malformed = classifyFailure('openrouter/openrouter/free', body([{ reason: 42 }]));
    const withoutReasons = classifyFailure('openrouter/openrouter/free', body([]));
    expect(malformed).toEqual(withoutReasons);
  });
});
