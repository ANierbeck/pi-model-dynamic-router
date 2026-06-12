// src/content-classifier.ts
// Inhaltsbasierte Klassifizierung von User-Prompts für dynamisches Model-Routing

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { callOllama } from "./ollama-utils.js";

// ── Types ────────────────────────────────────────────────────────────────

interface ClassificationResult {
  category: 
    | "code_simple"
    | "code_complex"
    | "design"
    | "planning"
    | "exploration"
    | "fallback";
  reason: string;
  confidence?: number; // Optional: 0–1
}

interface ClassificationOptions {
  model?: string; // Ollama-Modell (Default: "gemma2:2b")
  timeoutMs?: number; // Default: 10000
}

// ── Defaults ────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "gemma2:2b";
const DEFAULT_TIMEOUT = 10_000;

const CLASSIFICATION_PROMPT = `
Klassifiziere die folgende Anfrage in **genau eine** der Kategorien:
- code_simple: Einfache Code-Änderungen (1–10 Zeilen, Syntax-Fixes, Typos)
- code_complex: Komplexe Code-Änderungen (Refactoring, Debugging, >50 Zeilen)
- design: Architektur, Systemdesign, API-Entwurf
- planning: Projektplanung, Roadmaps, Aufgabenaufschlüsselung
- exploration: Forschung, unklare Anforderungen, Brainstorming
- fallback: Unklar oder mehrere Kategorien zutreffend

**Anfrage**: "{{prompt}}"

**Antwortformat** (JSON, keine zusätzlichen Erklärungen):
{
  "category": "<Kategorie>",
  "reason": "<Begründung in 1–2 Sätzen>",
  "confidence": <0.0–1.0> // Optional: Wie sicher bist du?
}
`;

// ── Core Logic ───────────────────────────────────────────────────────────

/**
 * Klassifiziert einen User-Prompt in eine Kategorie für das Model-Routing.
 * @param prompt Der User-Prompt (z. B. "Debugge diese Funktion").
 * @param options Konfigurationsoptionen.
 * @returns Klassifizierungsergebnis.
 */
export async function classifyPrompt(
  prompt: string,
  options: ClassificationOptions = {}
): Promise<ClassificationResult> {
  const { model = DEFAULT_MODEL, timeoutMs = DEFAULT_TIMEOUT } = options;

  // Prompt für das Ollama-Modell vorbereiten
  const ollamaPrompt = CLASSIFICATION_PROMPT.replace("{{prompt}}", prompt);

  try {
    // Ollama aufrufen
    const response = await callOllama(model, ollamaPrompt, { timeoutMs });

    // Antwort parsen (Ollama gibt JSON zurück)
    const parsed = JSON.parse(response.trim()) as ClassificationResult;
    if (!isValidClassification(parsed)) {
      throw new Error(`Invalid classification format: ${response}`);
    }
    return parsed;
  } catch (error) {
    console.error("Classification failed:", error);
    return {
      category: "fallback",
      reason: `Classification error: ${error instanceof Error ? error.message : "Unknown"}`,
      confidence: 0,
    };
  }
}

/**
 * Validiert das Klassifizierungsergebnis.
 */
function isValidClassification(obj: any): obj is ClassificationResult {
  return (
    obj &&
    typeof obj.category === "string" &&
    ["code_simple", "code_complex", "design", "planning", "exploration", "fallback"].includes(obj.category) &&
    typeof obj.reason === "string"
  );
}

// ── Mapping zu Router-Gruppen ────────────────────────────────────────────

/**
 * Mappt Klassifizierungskategorien auf Router-Gruppen.
 */
export const CATEGORY_TO_GROUP: Record<ClassificationResult["category"], string> = {
  code_simple: "operational",
  code_complex: "tactical",
  design: "strategic",
  planning: "tactical",
  exploration: "scout",
  fallback: "tactical",
};

export function getGroupForCategory(category: string): string {
  return CATEGORY_TO_GROUP[category as ClassificationResult["category"]] ?? "fallback";
}

// ── PI Integration ──────────────────────────────────────────────────────

/**
 * PI-Hook für die Echtzeit-Klassifizierung.
 */
interface ExtensionAPIWithHooks extends ExtensionAPI {
  hooks: {
    before_user_prompt: (callback: (args: { prompt: string; context: any }) => Promise<void>) => void;
  };
}

export function setupContentBasedRouting(pi: ExtensionAPI) {
  const piWithHooks = pi as unknown as ExtensionAPIWithHooks;
const piWithTools = pi as unknown as { tools: { resolve_model_group: { execute: (params: { group: string }) => Promise<any> } } };
  piWithHooks.hooks.before_user_prompt(async ({ prompt, context }: { prompt: string; context: any }) => {
    // 1. Prompt klassifizieren
    const classification = await classifyPrompt(prompt);

    // 2. Gruppe basierend auf der Kategorie auswählen
    const group = CATEGORY_TO_GROUP[classification.category];

    // 3. Modell über PI-Tools auflösen (nutzt resolve_model_group)
    const toolResult = await piWithTools.tools.resolve_model_group.execute({ group });
    
    if (toolResult?.details?.selected) {
      const { provider, modelId } = toolResult.details;
      const model = context.modelRegistry.find(provider, modelId);
      if (model) {
        await pi.setModel(model);
        console.log(`[content-based] ${classification.category} → ${group} → ${toolResult.details.selected} (${classification.reason})`);
      }
    }
  });
}