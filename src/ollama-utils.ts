// src/ollama-utils.ts
// Hilfsfunktionen für Ollama-Aufrufe (Klassifizierung, Fallback-Handling)

import { execa } from "execa"; // Wird für CLI-Aufrufe benötigt

// ── Types ────────────────────────────────────────────────────────────────

interface OllamaOptions {
  model: string;
  prompt: string;
  timeoutMs?: number;
  format?: "json" | "text"; // Standard: "json"
}

// ── Core Function ────────────────────────────────────────────────────────

/**
 * Führt einen Ollama-Aufruf aus und gibt die Antwort zurück.
 * @param model Ollama-Modell (z. B. "gemma2:2b").
 * @param prompt Der Prompt für Ollama.
 * @param options Zusätzliche Optionen.
 * @returns Die Antwort von Ollama.
 */
export async function callOllama(
  model: string,
  prompt: string,
  options: Partial<OllamaOptions> = {}
): Promise<string> {
  const { timeoutMs = 30_000, format = "json" } = options;
  const args = [
    "run",
    model,
    "--no-stream", // Kein Streaming für einfache Antworten
    `--format=${format}`, // JSON-Format für strukturierte Antworten
  ];

  try {
    // Ollama über CLI aufrufen
    const { stdout, stderr, exitCode } = await execa("ollama", args, {
      input: prompt,
      timeout: timeoutMs,
      reject: false, // Kein automatischer Fehler bei exitCode != 0
    });

    if (exitCode !== 0) {
      throw new Error(`Ollama failed (exit ${exitCode}): ${stderr}`);
    }

    return stdout.trim();
  } catch (error) {
    console.error("Ollama call failed:", error);
    throw new Error(
      `Ollama error: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
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