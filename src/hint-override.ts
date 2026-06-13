// src/hint-override.ts
// HINT-Override Logik für direkte Modell/Gruppen-Steuerung im Prompt

import type { Config } from './types.js';

/**
 * Extrahiere HINT-Target aus einem Prompt
 * Unterstützt:
 * - HINT: use mistral-medium-3.5
 * - HINT: use model anthropic/claude-3-sonnet
 * - HINT: use group tactical
 * - HINT: mistral-medium-3.5
 */
export function extractHintTarget(prompt: string): string | null {
  const hintMatch = prompt.match(/HINT:\s*(?:use\s+)?(?:(?:model|group)\s+)?([a-zA-Z0-9\-_:/.]+)/i);
  return hintMatch ? hintMatch[1] : null;
}

/**
 * Wende HINT-Override an und gib Kandidaten + Label zurück
 * @returns {candidates: string[], label: string} oder null wenn HINT ungültig
 */
export function applyHintOverride(
  hintTarget: string,
  cfg: Config,
  resolve: (name: string) => { selected: string; candidates: string[] } | null
): { candidates: string[]; label: string; model: string } | null {
  // Prüfe ob es eine Gruppe ist
  if (cfg.model_groups[hintTarget]) {
    const res = resolve(hintTarget);
    if (res) {
      return {
        candidates: [...res.candidates],
        label: `HINT: ${hintTarget} → ${res.selected}`,
        model: res.selected,
      };
    }
    return null;
  }

  // Prüfe ob es ein Modell-Ref ist (provider/model-id)
  // Einfache Validierung: muss '/' enthalten für provider/model
  if (hintTarget.includes('/')) {
    return {
      candidates: [hintTarget],
      label: `HINT: ${hintTarget}`,
      model: hintTarget,
    };
  }

  return null;
}

/**
 * Vollständige HINT-Verarbeitung für einen Prompt
 * (Nicht exportiert, da nicht in Produktion verwendet, aber für Tests nützlich)
 */
function processHintOverride(
  prompt: string,
  cfg: Config,
  resolve: (name: string) => { selected: string; candidates: string[] } | null
): { candidates: string[]; label: string; model: string } | null {
  const hintTarget = extractHintTarget(prompt);
  if (!hintTarget) return null;
  
  return applyHintOverride(hintTarget, cfg, resolve);
}

// Export für Tests
export { processHintOverride };
