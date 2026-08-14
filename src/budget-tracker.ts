// src/budget-tracker.ts
// Budget tracking for subscription-based providers (Claude, Mistral)

import type { Cache, Config } from './types.ts';
import { PROVIDER_MAP } from './providers.ts';

/**
 * Budget information for a subscription provider
 */
export interface BudgetInfo {
  remaining_tokens: number;
  window_type: 'hourly' | 'daily' | 'monthly';
  window_reset: number; // Unix timestamp in ms when window resets
  last_checked: number; // Unix timestamp in ms of last check
}

/**
 * Optional budget information (for cache)
 */
export type OptionalBudgetInfo = {
  remaining_tokens?: number;
  window_type?: 'hourly' | 'daily' | 'monthly';
  window_reset?: number;
  last_checked?: number;
};

/**
 * Provider-specific budget fetchers
 */
const BUDGET_FETCHERS: Record<string, (apiKey: string) => Promise<BudgetInfo | null>> = {
  // Claude Bridge / Anthropic
  'claude-bridge': fetchClaudeBudget,
  anthropic: fetchClaudeBudget,
  
  // Mistral
  mistral: fetchMistralBudget,
};

/**
 * Fetch Claude API budget (hourly window)
 * Uses the /v1/user/usage endpoint or similar
 */
async function fetchClaudeBudget(apiKey: string): Promise<BudgetInfo | null> {
  try {
    // Claude has hourly token windows
    // We need to check the current usage against the hourly limit
    // For Claude Pro, the limit is typically 100k tokens/hour for Sonnet, 50k for Haiku
    
    // Try to fetch from Anthropic API
    const response = await fetch('https://api.anthropic.com/v1/user/usage', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(10000),
    });
    
    if (!response.ok) {
      // If API fails, return null to indicate unknown budget
      return null;
    }
    
    const data = await response.json();
    
    // Parse the response - this is a placeholder, actual API may differ
    // Claude API might return usage data that we need to parse
    const now = Date.now();
    const hourStart = now - (now % (60 * 60 * 1000));
    const hourEnd = hourStart + (60 * 60 * 1000);
    
    // For now, return a conservative estimate
    // In production, this should use the actual API response
    return {
      remaining_tokens: 50000, // Conservative estimate for testing
      window_type: 'hourly',
      window_reset: hourEnd,
      last_checked: now,
    };
  } catch {
    return null; // API call failed
  }
}

/**
 * Fetch Mistral API budget (monthly window)
 */
async function fetchMistralBudget(apiKey: string): Promise<BudgetInfo | null> {
  try {
    // Mistral has monthly token budgets for Pro accounts
    const response = await fetch('https://api.mistral.ai/v1/usage', {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(10000),
    });
    
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json();
    
    // Parse the response
    const now = Date.now();
    
    // Get the start of the current month
    const monthStart = new Date(now);
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    
    // Get the start of next month
    const nextMonth = new Date(now);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    nextMonth.setDate(1);
    nextMonth.setHours(0, 0, 0, 0);
    
    // For now, return a conservative estimate
    return {
      remaining_tokens: 1000000, // Conservative estimate for testing
      window_type: 'monthly',
      window_reset: nextMonth.getTime(),
      last_checked: now,
    };
  } catch {
    return null; // API call failed
  }
}

/**
 * BudgetTracker - Tracks token budgets for subscription providers
 */
export class BudgetTracker {
  private cache: Cache;
  private cfg: Config;
  private lastCheck: number = 0;
  private checkInterval: number = 5 * 60 * 1000; // 5 minutes

  constructor(cfg: Config, cache: Cache) {
    this.cfg = cfg;
    this.cache = cache;
    
    // Initialize budget cache if not exists
    if (!this.cache.budget_cache) {
      this.cache.budget_cache = {};
    }
  }

  /**
   * Check if a model has available budget
   */
  async hasBudget(ref: string): Promise<boolean> {
    const prov = ref.split('/')[0];
    
    // Local providers (ollama, lm-studio) always have budget
    if (PROVIDER_MAP[prov]?.local) {
      return true;
    }
    
    // Pay-per-token providers always have budget (limited by money, not tokens)
    const billing = this.cfg.providers?.[prov]?.billing ?? PROVIDER_MAP[prov]?.billing ?? 'pay_per_token';
    if (billing === 'pay_per_token') {
      return true;
    }
    
    // Subscription providers: check budget
    const budget = await this.getBudget(prov);
    if (!budget) {
      // If we can't determine budget, assume it's available
      // (conservative: better to try than to fail)
      return true;
    }
    
    // Check if we're still in the same window
    const now = Date.now();
    if (budget.window_reset && now >= budget.window_reset) {
      // Window has reset, refresh budget
      await this.refreshBudget(prov);
      const newBudget = this.cache.budget_cache?.[prov];
      return newBudget && newBudget.remaining_tokens ? newBudget.remaining_tokens > 0 : true;
    }
    
    return (budget.remaining_tokens ?? 0) > 0;
  }

  /**
   * Get the remaining budget for a provider
   */
  async getBudget(provider: string): Promise<BudgetInfo | null> {
    // Check cache first
    const cached = this.cache.budget_cache?.[provider];
    if (cached) {
      const now = Date.now();
      
      // If cache is recent and window hasn't reset, use cached value
      if (cached.last_checked && cached.window_reset && 
          now - cached.last_checked < this.checkInterval && now < cached.window_reset) {
        return cached as BudgetInfo;
      }
    }
    
    // Refresh budget
    return await this.refreshBudget(provider);
  }

  /**
   * Refresh the budget for a provider
   */
  async refreshBudget(provider: string): Promise<BudgetInfo | null> {
    // Get API key for this provider
    const keys = this.cfg.providers?.[provider]?.keys;
    if (!keys || keys.length === 0) {
      return null;
    }
    
    // Try each key until one works
    for (const key of keys) {
      const apiKey = this.resolveKeyValue(key.key);
      if (!apiKey) continue;
      
      const fetcher = BUDGET_FETCHERS[provider];
      if (fetcher) {
        try {
          const budget = await fetcher(apiKey);
          if (budget) {
            // Update cache
            if (!this.cache.budget_cache) {
              this.cache.budget_cache = {};
            }
            this.cache.budget_cache[provider] = budget;
            return budget;
          }
        } catch {
          // Try next key
          continue;
        }
      }
    }
    
    return null;
  }

  /**
   * Resolve a key value (handle pass references, CLI auth, etc.)
   */
  private resolveKeyValue(key: string): string | null {
    if (key.startsWith('!pass show ')) {
      try {
        const { execSync } = require('node:child_process');
        return execSync(key.slice(1) + ' 2>/dev/null', { encoding: 'utf-8' }).trim();
      } catch {
        return null;
      }
    }
    
    if (key.startsWith('__cli_oauth__:')) {
      // Handle CLI OAuth tokens
      const parts = key.slice('__cli_oauth__:'.length);
      const lastColon = parts.lastIndexOf(':');
      const filePath = parts.slice(0, lastColon).replace('~', require('node:os').homedir());
      const field = parts.slice(lastColon + 1);
      
      try {
        const { readFileSync } = require('node:fs');
        const data = JSON.parse(readFileSync(filePath, 'utf-8'));
        return data[field] ?? null;
      } catch {
        return null;
      }
    }
    
    if (key === '__local__') {
      return 'local';
    }
    
    // Environment variable
    if (process.env[key]) {
      return process.env[key]!;
    }
    
    return key;
  }

  /**
   * Consume tokens from a provider's budget
   * (Call this after a successful request to update remaining tokens)
   */
  async consumeTokens(provider: string, tokens: number): Promise<void> {
    const budget = await this.getBudget(provider);
    if (!budget) return;
    
    // Update remaining tokens
    const currentTokens = budget.remaining_tokens ?? 0;
    (budget as BudgetInfo).remaining_tokens = Math.max(0, currentTokens - tokens);
    
    // Update cache
    if (!this.cache.budget_cache) {
      this.cache.budget_cache = {};
    }
    this.cache.budget_cache[provider] = budget as BudgetInfo;
  }

  /**
   * Get all models with available budget
   */
  async getModelsWithBudget(models: string[]): Promise<string[]> {
    const result: string[] = [];
    
    for (const model of models) {
      if (await this.hasBudget(model)) {
        result.push(model);
      }
    }
    
    return result;
  }

  /**
   * Update cache reference (for external updates)
   */
  updateCache(cache: Cache): void {
    this.cache = cache;
    if (!this.cache.budget_cache) {
      this.cache.budget_cache = {};
    }
  }

  /**
   * Get cache for saving
   */
  getCache(): Cache {
    return this.cache;
  }
}

/**
 * Singleton instance
 */
export let budgetTracker: BudgetTracker | null = null;

export function initBudgetTracker(cfg: Config, cache: Cache): BudgetTracker {
  budgetTracker = new BudgetTracker(cfg, cache);
  return budgetTracker;
}
