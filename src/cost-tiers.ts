// src/cost-tiers.ts
// Kostenstufen-System für kosteneffizientes dynamisches Routing

import type { Config } from './types.js';
import { lookupPrice, effCost } from './metrics.js';

// ── Types ──────────────────────────────────────────────────────────────

/**
 * Kostenstufen für das Routing
 * - free: Kostenlose Modelle ($0)
 * - budget: Kosteneffiziente Modelle ($)
 * - premium: Hochwertige Modelle ($$)
 */
export type CostTier = 'free' | 'budget' | 'premium';

/**
 * Konfiguration für eine Kostenstufe
 */
export interface CostTierConfig {
  id: CostTier;
  description: string;
  max_cost_per_m: number;      // Maximale Kosten pro Million Tokens
  max_cost_per_request: number; // Maximale Kosten pro Anfrage
  min_gdpval: number;          // Minimales GDPval
  preferred_providers: string[]; // Bevorzugte Provider
}

/**
 * Kostenstufen-Konfiguration
 */
export interface CostTiersConfig {
  free: CostTierConfig;
  budget: CostTierConfig;
  premium: CostTierConfig;
}

// ── Default Cost Tiers ─────────────────────────────────────────────────

/**
 * Standard-Kostenstufen-Konfiguration
 * Kann durch router-config.json überschrieben werden
 */
export const DEFAULT_COST_TIERS: CostTiersConfig = {
  free: {
    id: 'free',
    description: 'Kostenlose Modelle für einfache Aufgaben',
    max_cost_per_m: 0,
    max_cost_per_request: 0,
    min_gdpval: 0,
    preferred_providers: ['openrouter', 'ollama'],
  },
  budget: {
    id: 'budget',
    description: 'Kosteneffiziente Modelle für Standard-Aufgaben',
    max_cost_per_m: 0.5,
    max_cost_per_request: 0.1,
    min_gdpval: 300,
    preferred_providers: ['anthropic', 'openai', 'mistral'],
  },
  premium: {
    id: 'premium',
    description: 'Hochwertige Modelle für komplexe Aufgaben',
    max_cost_per_m: 2.0,
    max_cost_per_request: 1.0,
    min_gdpval: 600,
    preferred_providers: ['anthropic', 'openai', 'mistral'],
  },
};

// ── Cost Tier Detection ────────────────────────────────────────────────

/**
 * Gibt die Kostenstufe eines Modells zurück
 * @param modelRef - Modell-Referenz (z.B. 'openrouter/qwen/qwen3-4b:free')
 * @param staticFreeModels - Liste der kostenlosen Modelle aus der Konfiguration
 * @returns Die Kostenstufe des Modells
 */
export function getModelCostTier(
  modelRef: string,
  staticFreeModels: string[] = []
): CostTier {
  const price = lookupPrice(modelRef);
  
  // 1. Prüfe ob Modell in den statischen free_models ist
  if (staticFreeModels.includes(modelRef)) {
    return 'free';
  }
  
  // 2. Prüfe ob Modell kostenlos ist (Preis = 0)
  if (price && price.input === 0 && price.output === 0) {
    return 'free';
  }
  
  // 3. Prüfe ob Modell im Budget-Bereich ist (unter Budget-Schwellenwert)
  if (price && price.input <= DEFAULT_COST_TIERS.budget.max_cost_per_m) {
    return 'budget';
  }
  
  // 4. Ansonsten: Premium
  return 'premium';
}

/**
 * Prüft ob ein Modell zu einer Kostenstufe passt
 * @param modelRef - Modell-Referenz
 * @param tier - Kostenstufe
 * @param tierConfig - Kostenstufen-Konfiguration
 * @param staticFreeModels - Liste der kostenlosen Modelle
 * @returns true, wenn das Modell zur Kostenstufe passt
 */
export function modelFitsCostTier(
  modelRef: string,
  tier: CostTier,
  tierConfig: CostTierConfig = DEFAULT_COST_TIERS[tier],
  staticFreeModels: string[] = []
): boolean {
  const price = lookupPrice(modelRef);
  const cost = effCost(modelRef);
  const isFreeModel = staticFreeModels.includes(modelRef);
  const isZeroCost = price && price.input === 0 && price.output === 0;
  
  // 1. Kostenlose Modelle passen immer zu 'free'
  if (tier === 'free') {
    return isFreeModel || isZeroCost;
  }
  
  // 2. Budget-Modelle: Kostenlose Modelle + Modelle unter Budget-Schwelle
  if (tier === 'budget') {
    // Kostenlose Modelle passen immer zu budget
    if (isFreeModel || isZeroCost) return true;
    
    // Modelle unter Budget-Schwelle passen
    if (price && price.input <= tierConfig.max_cost_per_m) return true;
    
    // Effektive Kosten-Check
    if (cost <= tierConfig.max_cost_per_request) return true;
    
    return false;
  }
  
  // 3. Premium-Modelle: Alle Modelle, die nicht explizit ausgeschlossen sind
  if (tier === 'premium') {
    // Kostenlose und Budget-Modelle passen immer zu premium
    if (isFreeModel || isZeroCost) return true;
    
    // Budget-Modelle passen zu premium
    if (price && price.input <= DEFAULT_COST_TIERS.budget.max_cost_per_m) return true;
    
    // Premium-spezifische Checks
    if (price && price.input > tierConfig.max_cost_per_m) return false;
    if (cost > tierConfig.max_cost_per_request) return false;
    
    return true;
  }
  
  return false;
}

/**
 * Gibt die Kostenstufe basierend auf der Klassifizierungskategorie zurück
 */
export type ClassificationCategory = 
  | 'trivial'
  | 'simple'
  | 'code_simple'
  | 'standard'
  | 'code_complex'
  | 'design'
  | 'planning'
  | 'exploration'
  | 'fallback';

/**
 * Mapping von Klassifizierungskategorien zu Kostenstufen
 * Dies ist die Kernlogik für das kosteneffiziente Routing
 */
export const CATEGORY_TO_COST_TIER: Record<ClassificationCategory, CostTier> = {
  trivial: 'free',       // $0 - Sehr einfache Anfragen
  simple: 'free',        // $0 - Einfache Fragen
  code_simple: 'free',   // $0 - Kleine Code-Änderungen
  standard: 'budget',    // $ - Standard-Anfragen
  code_complex: 'premium', // $$ - Komplexe Code-Änderungen
  design: 'premium',     // $$ - Architektur/Design
  planning: 'premium',   // $$ - Planung/Roadmaps
  exploration: 'free',   // $0 - Brainstorming (kann günstig sein)
  fallback: 'budget',    // $ - Fallback (Standard-Modell)
};

/**
 * Gibt die Kostenstufe für eine Klassifizierungskategorie zurück
 */
export function getCostTierForCategory(category: ClassificationCategory): CostTier {
  return CATEGORY_TO_COST_TIER[category] || 'budget';
}

/**
 * Gibt die passende Modellgruppe für eine Klassifizierungskategorie zurück
 * (Kompatibilität mit bestehendem CATEGORY_TO_GROUP Mapping)
 */
export const CATEGORY_TO_GROUP: Record<ClassificationCategory, string> = {
  trivial: 'trivial',
  simple: 'simple',
  code_simple: 'simple',
  standard: 'standard',
  code_complex: 'complex',
  design: 'complex',
  planning: 'complex',
  exploration: 'scout',
  fallback: 'standard',
};

/**
 * Gibt die Modellgruppe für eine Klassifizierungskategorie zurück
 */
export function getGroupForCategory(category: ClassificationCategory): string {
  return CATEGORY_TO_GROUP[category] || 'fallback';
}

// ── Cost Optimization Utilities ────────────────────────────────────────

/**
 * Berechnet die geschätzten Einsparungen durch kostenlose Modelle
 * @param totalRequests - Gesamtzahl der Anfragen
 * @param freeRequests - Anzahl der kostenlosen Anfragen
 * @param avgCostPerRequest - Durchschnittskosten pro Anfrage (für nicht-kostenlose)
 * @returns Geschätzte Einsparungen
 */
export function calculateEstimatedSavings(
  totalRequests: number,
  freeRequests: number,
  avgCostPerRequest: number
): number {
  if (totalRequests === 0 || avgCostPerRequest === 0) return 0;
  
  // Was die kostenlosen Anfragen gekostet hätten
  const potentialCost = freeRequests * avgCostPerRequest;
  
  return potentialCost;
}

/**
 * Berechnet die Einsparrate
 * @param totalCost - Gesamtkosten
 * @param estimatedSavings - Geschätzte Einsparungen
 * @returns Einsparrate in Prozent
 */
export function calculateSavingsPercentage(
  totalCost: number,
  estimatedSavings: number
): number {
  if (totalCost + estimatedSavings === 0) return 0;
  
  return (estimatedSavings / (totalCost + estimatedSavings)) * 100;
}

// ── Validation ──────────────────────────────────────────────────────────

/**
 * Validiert eine Kostenstufen-Konfiguration
 */
export function validateCostTiersConfig(config: Partial<CostTiersConfig>): string[] {
  const errors: string[] = [];
  
  for (const [tierName, tierConfig] of Object.entries(config)) {
    if (!['free', 'budget', 'premium'].includes(tierName)) {
      errors.push(`Unknown cost tier: ${tierName}`);
      continue;
    }
    
    if (tierConfig.max_cost_per_m < 0) {
      errors.push(`Invalid max_cost_per_m for ${tierName}: must be >= 0`);
    }
    
    if (tierConfig.max_cost_per_request < 0) {
      errors.push(`Invalid max_cost_per_request for ${tierName}: must be >= 0`);
    }
    
    if (tierConfig.min_gdpval < 0) {
      errors.push(`Invalid min_gdpval for ${tierName}: must be >= 0`);
    }
  }
  
  return errors;
}

/**
 * Gibt die Kostenstufen-Konfiguration aus der Router-Konfiguration zurück
 * oder die Standard-Konfiguration, falls nicht definiert
 */
export function getCostTiersFromConfig(cfg: Config): CostTiersConfig {
  if (cfg.cost_tiers && isValidCostTiersConfig(cfg.cost_tiers)) {
    return cfg.cost_tiers as CostTiersConfig;
  }
  
  return DEFAULT_COST_TIERS;
}

/**
 * Prüft ob eine Kostenstufen-Konfiguration gültig ist
 */
export function isValidCostTiersConfig(config: any): config is CostTiersConfig {
  if (!config || typeof config !== 'object') return false;
  
  const requiredTiers: CostTier[] = ['free', 'budget', 'premium'];
  
  for (const tier of requiredTiers) {
    if (!(tier in config)) return false;
    
    const tierConfig = config[tier];
    if (!tierConfig || typeof tierConfig !== 'object') return false;
    
    if (typeof tierConfig.max_cost_per_m !== 'number') return false;
    if (typeof tierConfig.max_cost_per_request !== 'number') return false;
    if (typeof tierConfig.min_gdpval !== 'number') return false;
  }
  
  return true;
}
