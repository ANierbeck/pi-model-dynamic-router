// src/ollama-utils.ts
// Utility functions for Ollama calls (classification, fallback handling)

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
