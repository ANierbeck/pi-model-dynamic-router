// src/cost-tiers.ts
// Cost tier system for cost-efficient dynamic routing

import type { 
  Config, 
  ClassificationCategory,
  CostTier,
  CostTierConfig,
  CostTiersConfig 
} from './types.js';
import { lookupPrice, effCost } from './metrics.js';

// Re-export of types for compatibility
export type { CostTier, CostTierConfig, CostTiersConfig };

// ── Default Cost Tiers ─────────────────────────────────────────────────

/**
 * Default cost tier configuration
 * Can be overridden by router-config.json
 */
export const DEFAULT_COST_TIERS: CostTiersConfig = {
  free: {
    id: 'free',
    description: 'Free models for simple tasks',
    max_cost_per_m: 0,
    max_cost_per_request: 0,
    min_gdpval: 0,
    preferred_providers: ['openrouter', 'ollama'],
  },
  budget: {
    id: 'budget',
    description: 'Cost-effective models for standard tasks',
    max_cost_per_m: 0.5,
    max_cost_per_request: 0.1,
    min_gdpval: 300,
    preferred_providers: ['anthropic', 'openai', 'mistral'],
  },
  premium: {
    id: 'premium',
    description: 'High-quality models for complex tasks',
    max_cost_per_m: 2.0,
    max_cost_per_request: 1.0,
    min_gdpval: 600,
    preferred_providers: ['anthropic', 'openai', 'mistral'],
  },
};

// ── Cost Tier Detection ────────────────────────────────────────────────

/**
 * Returns the cost tier of a model
 * @param modelRef - Model reference (e.g. 'openrouter/qwen/qwen3-4b:free')
 * @param staticFreeModels - List of free models from the configuration
 * @returns The cost tier of the model
 */
export function getModelCostTier(
  modelRef: string,
  staticFreeModels: string[] = []
): CostTier {
  const price = lookupPrice(modelRef);
  
  // 1. Check whether model is in the static free_models
  if (staticFreeModels.includes(modelRef)) {
    return 'free';
  }
  
  // 2. Check whether model is free (price = 0)
  if (price && price.input === 0 && price.output === 0) {
    return 'free';
  }
  
  // 3. Check whether model is in the budget range (below budget threshold)
  if (price && price.input <= DEFAULT_COST_TIERS.budget.max_cost_per_m) {
    return 'budget';
  }
  
  // 4. Check whether model is in the premium range (above budget threshold)
  if (price && price.input > DEFAULT_COST_TIERS.budget.max_cost_per_m) {
    return 'premium';
  }
  
  // 5. Otherwise: Budget (conservative default for unknown models or models without a price)
  // Unknown models are classified as budget to err on the safe side
  return 'budget';
}

/**
 * Checks whether a model fits a cost tier
 * @param modelRef - Model reference
 * @param tier - Cost tier
 * @param tierConfig - Cost tier configuration
 * @param staticFreeModels - List of free models
 * @returns true if the model fits the cost tier
 */
export function modelFitsCostTier(
  modelRef: string,
  tier: CostTier,
  tierConfig: CostTierConfig = DEFAULT_COST_TIERS[tier],
  staticFreeModels: string[] = []
): boolean {
  const price = lookupPrice(modelRef);
  const cost = effCost(modelRef);
  const isFreeModel: boolean = staticFreeModels.includes(modelRef);
  const isZeroCost: boolean = price !== null && price.input === 0 && price.output === 0;
  
  // 1. Free models always fit 'free'
  if (tier === 'free') {
    return isFreeModel || isZeroCost;
  }
  
  // 2. Budget models: Free models + models below the budget threshold
  if (tier === 'budget') {
    // Free models always fit budget
    if (isFreeModel || isZeroCost) return true;
    
    // Models below the budget threshold fit (input price per 1M tokens)
    if (price && price.input <= tierConfig.max_cost_per_m) return true;
    
    return false;
  }
  
  // 3. Premium models: All models that are not free
  // Premium is the highest tier and accepts all models
  if (tier === 'premium') {
    // Free and budget models always fit premium
    if (isFreeModel || isZeroCost) return true;
    
    // All other models fit premium (no upper limit)
    // Premium is the "catch-all" tier for expensive models
    return true;
  }
  
  return false;
}

// Re-export from content-classifier.ts for compatibility
export { getGroupForCategory } from './content-classifier.js';

/**
 * Returns the cost tier for a given classification category
 */

/**
 * Mapping of classification categories to cost tiers
 * This is the core logic for cost-efficient routing
 */
export const CATEGORY_TO_COST_TIER: Record<ClassificationCategory, CostTier> = {
  trivial: 'free',       // $0 - Very simple requests
  simple: 'free',        // $0 - Simple questions
  code_simple: 'free',   // $0 - Small code changes
  standard: 'budget',    // $ - Standard requests
  code_complex: 'premium', // $$ - Complex code changes
  design: 'premium',     // $$ - Architecture/Design
  planning: 'premium',   // $$ - Planning/Roadmaps
  exploration: 'free',   // $0 - Brainstorming (can be cheap)
  fallback: 'budget',    // $ - Fallback (default model)
};

/**
 * Returns the cost tier for a classification category
 */
export function getCostTierForCategory(category: ClassificationCategory): CostTier {
  return CATEGORY_TO_COST_TIER[category] || 'budget';
}



// ── Cost Optimization Utilities ────────────────────────────────────────

/**
 * Calculates estimated savings through free models
 * @param totalRequests - Total number of requests
 * @param freeRequests - Number of free requests
 * @param avgCostPerRequest - Average cost per request (for non-free ones)
 * @returns Estimated savings
 */
export function calculateEstimatedSavings(
  totalRequests: number,
  freeRequests: number,
  avgCostPerRequest: number
): number {
  if (totalRequests === 0 || avgCostPerRequest === 0) return 0;
  
  // What the free requests would have cost
  const potentialCost = freeRequests * avgCostPerRequest;
  
  return potentialCost;
}

/**
 * Calculates the savings rate
 * @param totalCost - Total cost
 * @param estimatedSavings - Estimated savings
 * @returns Savings rate in percent
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
 * Validates a cost tier configuration
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
 * Returns the cost tier configuration from the router configuration
 * or the default configuration if not defined
 */
export function getCostTiersFromConfig(cfg: Config): CostTiersConfig {
  if (cfg.cost_tiers && isValidCostTiersConfig(cfg.cost_tiers)) {
    return cfg.cost_tiers as CostTiersConfig;
  }
  
  return DEFAULT_COST_TIERS;
}

/**
 * Checks whether a cost tier configuration is valid
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
