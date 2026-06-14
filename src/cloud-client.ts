// src/cloud-client.ts
// Client für Cloud-Modell-Aufrufe (OpenRouter, etc.)

import type { ProviderDef } from './types.js';
import type { Config } from './types.js';
import { PROVIDER_MAP } from './providers.js';

export interface CloudModelResponse {
  content: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
}

export interface CloudClientOptions {
  timeoutMs?: number;
  maxRetries?: number;
}

/**
 * Client für Cloud-Modell-Aufrufe
 * Unterstützt aktuell: OpenRouter
 */
export class CloudClient {
  private cfg: Config;
  private options: Required<CloudClientOptions>;

  constructor(cfg: Config, options: CloudClientOptions = {}) {
    this.cfg = cfg;
    this.options = {
      timeoutMs: 30000,
      maxRetries: 3,
      ...options,
    };
  }

  /**
   * Führe einen Prompt mit einem Cloud-Modell aus
   * @param modelRef - Modell-Referenz (z. B. "openai/gpt-oss-120b:free")
   * @param prompt - User-Prompt
   * @param systemPrompt - Optional: System-Prompt
   * @returns CloudModelResponse
   */
  async callModel(
    modelRef: string,
    prompt: string,
    systemPrompt?: string
  ): Promise<CloudModelResponse> {
    const [providerId, modelId] = this.splitModelRef(modelRef);
    const providerDef = PROVIDER_MAP[providerId];

    if (!providerDef) {
      throw new Error(`Unknown provider: ${providerId}`);
    }

    // Hole API-Key aus Konfiguration
    const apiKey = this.getApiKey(providerId);
    if (!apiKey) {
      throw new Error(`No API key for provider: ${providerId}`);
    }

    // Provider-spezifische Aufrufe
    switch (providerDef.api) {
      case 'openai-completions':
        return this.callOpenRouter(modelId, prompt, systemPrompt, apiKey, providerDef);
      default:
        throw new Error(`Unsupported API type for cloud calls: ${providerDef.api}`);
    }
  }

  /**
   * Teile Modell-Referenz in Provider und Modell-ID
   * Unterstützt Formate:
   * - "provider/model-id" (z. B. "openrouter/qwen3-4b:free")
   * - "provider/namespace/model-id" (z. B. "openrouter/qwen/qwen3-4b:free")
   */
  private splitModelRef(modelRef: string): [string, string] {
    const parts = modelRef.split('/');
    if (parts.length >= 2) {
      // Provider + Modell-ID (z. B. "openrouter/qwen3-4b:free" oder "openrouter/qwen/qwen3-4b:free")
      const providerId = parts[0];
      if (PROVIDER_MAP[providerId]) {
        // Erster Teil ist der Provider
        return [providerId, parts.slice(1).join('/')];
      } else {
        // Kein bekannter Provider
        throw new Error(`Unknown provider: ${providerId}`);
      }
    } else {
      throw new Error(`Invalid model reference format: ${modelRef}`);
    }
  }

  /**
   * Hole API-Key für einen Provider
   */
  private getApiKey(providerId: string): string | null {
    const providerConfig = this.cfg.providers?.[providerId];
    return providerConfig?.keys?.[0]?.key || null;
  }

  /**
   * OpenRouter-spezifischer Aufruf
   * (OpenRouter nutzt das OpenAI-Chat-Completions-Format)
   */
  private async callOpenRouter(
    modelRef: string,
    prompt: string,
    systemPrompt: string | undefined,
    apiKey: string,
    providerDef: ProviderDef
  ): Promise<CloudModelResponse> {
    const url = `${providerDef.baseUrl}/chat/completions`;
    const headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/earendil-works/pi-model-router',
      'X-Title': 'pi-model-router',
    };

    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const body = {
      model: modelRef,
      messages,
      temperature: 0.7,
      max_tokens: 2000,
    };

    // Node.js fetch mit Timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`OpenRouter API error (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      
      if (!data.choices || data.choices.length === 0) {
        throw new Error('No choices returned from OpenRouter');
      }

      return {
        content: data.choices[0].message.content,
        usage: data.usage,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`OpenRouter request timed out after ${this.options.timeoutMs}ms`);
      }
      throw error;
    }
  }
}
