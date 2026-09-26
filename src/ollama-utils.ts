// src/ollama-utils.ts
// Utility functions for Ollama calls (classification, fallback handling)
//
// NOT merged with ollama-gdpval.ts / ollama-context.ts (F1 evaluation): this
// module is the live Ollama HTTP client (fetch + fallback), unrelated to
// GDPval scoring math or context-window resolution. Kept separate.

// ── Types ────────────────────────────────────────────────────────────────

interface OllamaOptions {
  model: string;
  prompt: string;
  timeoutMs?: number;
  format?: 'json' | 'text';
}

// ── Core Function ────────────────────────────────────────────────────────

/**
 * Calls the Ollama HTTP API and returns the response.
 */
export async function callOllama(
  model: string,
  prompt: string,
  options: Partial<OllamaOptions> = {}
): Promise<string> {
  const { timeoutMs = 30_000, format = 'json' } = options;

  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      ...(format === 'json' ? { format: 'json' } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { response: string };

  // Clean up the response: remove markdown code blocks and trim whitespace
  let response = data.response;

  // Remove markdown code blocks (```json ... ``` or ``` ... ```)
  response = response.replace(/^```(json)?\s*/, '').replace(/\s*```$/, '');

  // Remove any remaining markdown formatting
  response = response.replace(/```[\s\S]*?```/g, '');

  return response.trim();
}

// ── Availability Probe ───────────────────────────────────────────────

/** Timeout for the Ollama availability probe (GET /api/tags). */
const AVAILABILITY_PROBE_TIMEOUT_MS = 1_500;

/**
 * How long a "down" probe result is cached before re-probing (ms). Bounds
 * the hanging-port worst case to one probe per TTL window per process,
 * while self-healing shortly after the daemon comes back up.
 */
const AVAILABILITY_NEGATIVE_TTL_MS = 15_000;

let lastProbeDownAt = 0;

/**
 * Checks whether the local Ollama daemon is reachable via a cheap
 * GET /api/tags request with a short timeout.
 *
 * Purpose: when the daemon is down, fetch-based calls fail fast with
 * ECONNREFUSED anyway, but a *hanging* port (overloaded daemon, firewall
 * drop, suspended machine) would otherwise burn the full classification
 * timeouts (primary + fallback model) on every prompt. This probe bounds
 * that to a single short request, letting the classifier jump straight
 * to its cloud fallback chain.
 *
 * Note: availability != the model being loaded. If the daemon is up but
 * a model is missing, callOllama still fails — the existing
 * primary→fallback→cloud chain handles that case.
 */
export async function isOllamaAvailable(
  timeoutMs: number = AVAILABILITY_PROBE_TIMEOUT_MS
): Promise<boolean> {
  const now = Date.now();
  if (now - lastProbeDownAt < AVAILABILITY_NEGATIVE_TTL_MS) return false;
  try {
    const response = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      lastProbeDownAt = now;
      return false;
    }
    return true;
  } catch {
    lastProbeDownAt = now;
    return false;
  }
}

// ── Fallback Handling ───────────────────────────────────────────────────

/**
 * Fallback strategy when Ollama is not available.
 * @returns A default result for the fallback case.
 */
export function getFallbackClassification(): {
  category: 'fallback';
  reason: string;
} {
  return {
    category: 'fallback',
    reason: 'Ollama unavailable — using default routing.',
  };
}
