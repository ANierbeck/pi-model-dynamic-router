// src/config-schema.ts
// The known top-level config keys, hand-maintained (plan
// 2026-11-08-optional-integrations-config.md, decision 2: no new dependency).
//
// The record is typed `Record<keyof Config, true>`, so `tsc` fails when `Config`
// gains or loses a key without this file following; test/config-schema.test.ts
// additionally compares it with the `interface Config` source text so the
// vitest run catches it too.

import type { Config } from './types.ts';

export const KNOWN_TOP_LEVEL_KEYS: Readonly<Record<keyof Config, true>> = {
  providers: true,
  model_groups: true,
  model_metrics: true,
  gdpval_builtin: true,
  log_level: true,
  classifier_log: true,
  integrations: true,
  scan_settle_ms: true,
  empty_response_timeout_ms: true,
  reasoning_empty_response_timeout_ms: true,
  stall_timeout_ms: true,
  rate_limit_wait_max_ms: true,
  backoff_minutes: true,
  soft_backoff_ms: true,
  ollama_max_concurrent_streams: true,
  exclude: true,
  non_agent_model_prefixes: true,
  provider_breaker: true,
  best_quality_window: true,
  delegation: true,
  category_groups: true,
  context_budget: true,
};

/**
 * Keys of a config layer that `Config` does not know. Keys starting with `_`
 * (comments, e.g. `_comment`) or `$` (`$schema`) are annotations, not settings.
 */
export function unknownTopLevelKeys(layer: Record<string, unknown>): string[] {
  return Object.keys(layer).filter(
    (k) => !k.startsWith('_') && !k.startsWith('$') && !Object.hasOwn(KNOWN_TOP_LEVEL_KEYS, k)
  );
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/** The known key a typo most likely meant, or undefined when nothing is close. */
export function closestKey(key: string, known: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of known) {
    const d = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  // Close enough to be a typo: at most 2 edits and under a third of the length.
  return best !== undefined && bestDistance <= 2 && bestDistance < key.length / 3
    ? best
    : undefined;
}
