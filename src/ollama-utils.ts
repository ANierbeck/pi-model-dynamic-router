// src/ollama-utils.ts
// Hilfsfunktionen für Ollama-Aufrufe (Klassifizierung, Fallback-Handling)

// ── Types ────────────────────────────────────────────────────────────────

interface OllamaOptions {
  model: string;
  prompt: string;
  timeoutMs?: number;
  format?: "json" | "text";
}

// ── Core Function ────────────────────────────────────────────────────────

/**
 * Ruft die Ollama HTTP API auf und gibt die Antwort zurück.
 */
export async function callOllama(
  model: string,
  prompt: string,
  options: Partial<OllamaOptions> = {}
): Promise<string> {
  const { timeoutMs = 30_000, format = "json" } = options;

  const res = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false, ...(format === "json" ? { format: "json" } : {}) }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json() as { response: string };
  return data.response;
}

// ── Fallback Handling ───────────────────────────────────────────────────

/**
 * Fallback-Strategie, wenn Ollama nicht verfügbar ist.
 * @returns Ein Standard-Ergebnis für den Fallback-Fall.
 */
export function getFallbackClassification(): {
  category: "fallback";
  reason: string;
} {
  return {
    category: "fallback",
    reason: "Ollama nicht verfügbar — nutze Standard-Routing.",
  };
}