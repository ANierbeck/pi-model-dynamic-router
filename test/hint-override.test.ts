// test/hint-override.test.ts
// Unit-Tests für die HINT-Override Logik

import { describe, it, expect, beforeEach, vi } from "vitest";
import { extractHintTarget, applyHintOverride, processHintOverride } from "../src/hint-override.js";
import type { Config } from "../src/types.js";

// ── Mock Config ────────────────────────────────────────────────────────────

const mockCfg: Config = {
  model_groups: {
    tactical: {
      method: 'dynamic',
      description: 'Tactical models',
    },
    operational: {
      method: 'best',
      description: 'Operational models',
    },
  },
  model_metrics: {},
  providers: {},
};

// ── Mock resolve function ────────────────────────────────────────────────────

const mockResolve = vi.fn((name: string) => {
  if (name === 'tactical') {
    return { selected: 'anthropic/claude-3-sonnet', candidates: ['anthropic/claude-3-sonnet', 'mistral/mistral-medium'] };
  }
  if (name === 'operational') {
    return { selected: 'mistral/mistral-small', candidates: ['mistral/mistral-small'] };
  }
  return null;
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("extractHintTarget", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("extrahiere HINT mit 'use group tactical'", () => {
    const result = extractHintTarget("HINT: use group tactical\nErsetze foo mit bar");
    expect(result).toBe("tactical");
  });

  it("extrahiere HINT mit 'use model anthropic/claude-3-sonnet'", () => {
    const result = extractHintTarget("HINT: use model anthropic/claude-3-sonnet\nErkläre das");
    expect(result).toBe("anthropic/claude-3-sonnet");
  });

  it("extrahiere HINT mit 'use mistral-medium-3.5'", () => {
    const result = extractHintTarget("HINT: use mistral-medium-3.5\nSchreibe Code");
    expect(result).toBe("mistral-medium-3.5");
  });

  it("extrahiere HINT ohne 'use' (direkt)", () => {
    const result = extractHintTarget("HINT: group tactical\nMache das");
    expect(result).toBe("tactical");
  });

  it("extrahiere HINT mit Modell-Ref (provider/model)", () => {
    const result = extractHintTarget("HINT: anthropic/claude-3-sonnet\nBeantworte das");
    expect(result).toBe("anthropic/claude-3-sonnet");
  });

  it("gibt null zurück wenn kein HINT vorhanden", () => {
    const result = extractHintTarget("Ersetze foo mit bar");
    expect(result).toBeNull();
  });

  it("gibt null zurück bei ungültigem HINT-Format (Sonderzeichen am Anfang)", () => {
    const result = extractHintTarget("HINT: !@# invalid");
    expect(result).toBeNull();
  });

  it("extrahiere gültiges Target das nicht existiert (bare word)", () => {
    const result = extractHintTarget("HINT: unknown-group");
    expect(result).toBe("unknown-group");
  });
});

describe("applyHintOverride", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("wendet Gruppe-HINT an", () => {
    const result = applyHintOverride("tactical", mockCfg, mockResolve);
    expect(result).toEqual({
      candidates: ['anthropic/claude-3-sonnet', 'mistral/mistral-medium'],
      label: 'HINT: tactical → anthropic/claude-3-sonnet',
      model: 'anthropic/claude-3-sonnet',
    });
  });

  it("wendet Modell-Ref-HINT an", () => {
    const result = applyHintOverride("anthropic/claude-3-sonnet", mockCfg, mockResolve);
    expect(result).toEqual({
      candidates: ['anthropic/claude-3-sonnet'],
      label: 'HINT: anthropic/claude-3-sonnet',
      model: 'anthropic/claude-3-sonnet',
    });
  });

  it("gibt null zurück für unbekannte Gruppe", () => {
    const result = applyHintOverride("unknown-group", mockCfg, mockResolve);
    expect(result).toBeNull();
  });

  it("gibt null zurück für Gruppe ohne resolve-Ergebnis", () => {
    const mockResolveEmpty = vi.fn(() => null);
    const result = applyHintOverride("tactical", mockCfg, mockResolveEmpty);
    expect(result).toBeNull();
  });

  it("gibt null zurück für unbekanntes bare-word Target", () => {
    const result = applyHintOverride("unknown-group", mockCfg, mockResolve);
    expect(result).toBeNull();
  });
});

describe("processHintOverride", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("verarbeitet vollständigen HINT-Prompt", () => {
    const result = processHintOverride(
      "HINT: use group tactical\nErsetze foo mit bar",
      mockCfg,
      mockResolve
    );
    expect(result).toEqual({
      candidates: ['anthropic/claude-3-sonnet', 'mistral/mistral-medium'],
      label: 'HINT: tactical → anthropic/claude-3-sonnet',
      model: 'anthropic/claude-3-sonnet',
    });
  });

  it("gibt null zurück wenn kein HINT im Prompt", () => {
    const result = processHintOverride("Ersetze foo mit bar", mockCfg, mockResolve);
    expect(result).toBeNull();
  });

  it("verarbeitet HINT mit Modell-Ref", () => {
    const result = processHintOverride(
      "HINT: mistral/mistral-medium-3.5\nSchreibe Code",
      mockCfg,
      mockResolve
    );
    expect(result).toEqual({
      candidates: ['mistral/mistral-medium-3.5'],
      label: 'HINT: mistral/mistral-medium-3.5',
      model: 'mistral/mistral-medium-3.5',
    });
  });
});
