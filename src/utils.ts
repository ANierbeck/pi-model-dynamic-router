// src/utils.ts
// Hilfsfunktionen für den pi-model-router

import { STRIP_SUFFIXES, PARAM_SUFFIXES } from "./providers.js";
import type { ModelRef } from "./types.js";

// ── String Utilities ──────────────────────────────────────────────────────

/**
 * Normalisiert einen String für den Vergleich
 */
export function stripDateSuffix(s: string): string {
  // Strip trailing date/version tags: -YYYYMMDD, -YYMMDD, -YYMM (e.g., -20250514, -2507, -0324)
  return s.replace(/-\d{4,8}$/, "");
}
export function norm(s: string): string {
  s = s.toLowerCase();
  // Strip to last path segment — "chutes/deepseek-ai/DeepSeek-V3" → "deepseek-v3"
  const slash = s.lastIndexOf("/");
  if (slash !== -1 && slash < s.length - 1) s = s.slice(slash + 1);
  for (const x of STRIP_SUFFIXES) s = s.replace(x, "");
  s = stripDateSuffix(s);
  return s.replace(/[^a-z0-9]/g, "");
}

/**
 * Entfernt Datums-Suffixes von Modell-IDs (z.B. -20250514, -2507, -0324)
 */

/**
 * Teilt eine Modell-Referenz in Provider und Modell-ID
 */
export function splitRef(ref: string): ModelRef {
  const i = ref.indexOf("/");
  return i === -1 ? { provider: ref, modelId: ref } : { provider: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

/**
 * Entfernt den Provider-Präfix von einer Referenz
 * Beispiel: "chutes/deepseek-ai/DeepSeek-V3" → "deepseek-ai/DeepSeek-V3"
 */
export function stripProvider(ref: string): string {
  const i = ref.indexOf("/");
  if (i === -1) return ref;
  const prov = ref.slice(0, i);
  // Wenn der Provider in PROVIDER_MAP oder cfg.providers existiert, entferne ihn
  // Für diese Funktion reichen wir die Provider-Liste später nach
  return ref.slice(i + 1);
}

/**
 * Formatiert Zahlen für die Anzeige (z.B. 1000 → "1k")
 */
export function fmt(n: number): string {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

/**
 * Formatiert Zeitdauern für die Anzeige
 */
export function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return `${m}m${rs ? rs + "s" : ""}`;
  return `${Math.floor(m / 60)}h${m % 60 ? (m % 60) + "m" : ""}`;
}

// ── Model Token Utilities ─────────────────────────────────────────────────

/**
 * Extrahiere Basistokens aus einer Modell-ID
 * Entfernt Parameter-Suffixes, Datums-Suffixes und teilt in sortierte Tokens
 */
export function baseTokens(s: string): Set<string> {
  s = s.toLowerCase();
  const slash = s.lastIndexOf("/");
  if (slash !== -1 && slash < s.length - 1) s = s.slice(slash + 1);
  for (const ps of PARAM_SUFFIXES) s = s.replace(ps, "");
  for (const x of STRIP_SUFFIXES) s = s.replace(x, "");
  s = stripDateSuffix(s);
  return new Set(s.match(/[a-z]+|\d+/g) ?? []);
}

// ── Validation Utilities ──────────────────────────────────────────────────

/**
 * Prüft, ob eine Modell-Referenz aktuell rate-limited ist
 */
export function isModelLimited(ref: string, limits: Map<string, { cooldown_until: number }>): boolean {
  const limit = limits.get(ref);
  if (!limit) return false;
  if (Date.now() >= limit.cooldown_until) {
    limits.delete(ref);
    return false;
  }
  return true;
}

/**
 * Gibt die verbleibenden Sekunden der Rate-Limit zurück
 */
export function limitSecs(ref: string, limits: Map<string, { cooldown_until: number }>): number {
  const limit = limits.get(ref);
  return limit ? Math.max(0, Math.ceil((limit.cooldown_until - Date.now()) / 1000)) : 0;
}
