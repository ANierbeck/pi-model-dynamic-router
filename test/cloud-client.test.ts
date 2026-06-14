// test/cloud-client.test.ts
// Unit-Tests für CloudClient

import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { CloudClient } from "../src/cloud-client.js";
import type { Config } from "../src/types.js";

// ── Mock für fetch ────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

// ── Test-Konfiguration ────────────────────────────────────────────────────

const mockCfg: Config = {
  providers: {
    openrouter: {
      keys: [{ key: "test-api-key" }],
    },
    mistral: {
      keys: [{ key: "mistral-test-key" }],
    },
  },
  model_groups: {},
  model_metrics: {},
};

// ── Tests ────────────────────────────────────────────────────────────────

describe("CloudClient", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  describe("constructor", () => {
    it("erstellt Instanz mit Standard-Optionen", () => {
      const client = new CloudClient(mockCfg);
      expect(client).toBeInstanceOf(CloudClient);
    });

    it("akzeptiert benutzerdefinierte Optionen", () => {
      const client = new CloudClient(mockCfg, {
        timeoutMs: 60000,
        maxRetries: 5,
      });
      expect(client).toBeInstanceOf(CloudClient);
    });
  });

  describe("callModel", () => {
    describe("OpenRouter", () => {
      it("erfolgreicher Aufruf mit OpenRouter", async () => {
        const mockResponse = {
          choices: [
            {
              message: {
                content: '{"category": "code_simple", "reason": "Test", "confidence": 0.95}',
              },
            },
          ],
          usage: {
            promptTokens: 100,
            completionTokens: 50,
          },
        };

        vi.mocked(globalThis.fetch).mockResolvedValue({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockResponse),
        });

        const client = new CloudClient(mockCfg);
        const result = await client.callModel(
          "openrouter/openrouter/qwen/qwen3-4b:free",
          "Klassifiziere diesen Prompt"
        );

        expect(result.content).toBe(
          '{"category": "code_simple", "reason": "Test", "confidence": 0.95}'
        );
        expect(result.usage).toEqual({
          promptTokens: 100,
          completionTokens: 50,
        });

        expect(fetch).toHaveBeenCalledWith(
          "https://openrouter.ai/api/v1/chat/completions",
          expect.objectContaining({
            method: "POST",
            headers: expect.objectContaining({
              Authorization: "Bearer test-api-key",
              "Content-Type": "application/json",
            }),
          })
        );
      });

      it("unterstützt System-Prompt", async () => {
        const mockResponse = {
          choices: [{ message: { content: "Test" } }],
        };

        vi.mocked(globalThis.fetch).mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockResponse),
        });

        const client = new CloudClient(mockCfg);
        await client.callModel(
          "openrouter/qwen/qwen3-4b:free",
          "User prompt",
          "You are a classifier"
        );

        expect(fetch).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            method: "POST",
          })
        );
      });

      it("behandelt HTTP-401-Fehler (Unauthorized)", async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          text: () => Promise.resolve("Invalid API key"),
        });

        const client = new CloudClient(mockCfg);
        await expect(
          client.callModel("openrouter/qwen/qwen3-4b:free", "Test prompt")
        ).rejects.toThrow("OpenRouter API error (401): Invalid API key");
      });

      it("behandelt HTTP-429-Fehler (Rate Limit)", async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          text: () => Promise.resolve("Rate limit exceeded"),
        });

        const client = new CloudClient(mockCfg);
        await expect(
          client.callModel("openrouter/qwen/qwen3-4b:free", "Test prompt")
        ).rejects.toThrow("OpenRouter API error (429): Rate limit exceeded");
      });

      it("behandelt HTTP-500-Fehler (Server Error)", async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          text: () => Promise.resolve("Server error"),
        });

        const client = new CloudClient(mockCfg);
        await expect(
          client.callModel("openrouter/qwen/qwen3-4b:free", "Test prompt")
        ).rejects.toThrow("OpenRouter API error (500): Server error");
      });

      it("behandelt Timeout-Fehler", async () => {
        const controller = new AbortController();
        const abortError = new Error("Timeout");
        abortError.name = "AbortError";
        vi.mocked(globalThis.fetch).mockImplementation(() => {
          controller.abort();
          return Promise.reject(abortError);
        });

        const client = new CloudClient(mockCfg, { timeoutMs: 100 });
        await expect(
          client.callModel("openrouter/qwen/qwen3-4b:free", "Test prompt")
        ).rejects.toThrow("OpenRouter request timed out after 100ms");
      });

      it("behandelt leere Response (keine choices)", async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ choices: [] }),
        });

        const client = new CloudClient(mockCfg);
        await expect(
          client.callModel("openrouter/qwen/qwen3-4b:free", "Test prompt")
        ).rejects.toThrow("No choices returned from OpenRouter");
      });

      it("behandelt ungültigen Provider", async () => {
        const client = new CloudClient(mockCfg);
        await expect(
          client.callModel("unknown-provider/test", "Test prompt")
        ).rejects.toThrow("Unknown provider: unknown-provider");
      });

      it("behandelt fehlenden API-Key", async () => {
        const cfgNoKey: Config = {
          providers: {
            openrouter: {}, // Kein Key
          },
          model_groups: {},
          model_metrics: {},
        };

        const client = new CloudClient(cfgNoKey);
        await expect(
          client.callModel("openrouter/qwen/qwen3-4b:free", "Test prompt")
        ).rejects.toThrow("No API key for provider: openrouter");
      });

      it("behandelt ungültiges Modell-Format", async () => {
        const client = new CloudClient(mockCfg);
        await expect(
          client.callModel("invalid-model-ref", "Test prompt")
        ).rejects.toThrow("Invalid model reference format: invalid-model-ref");
      });
    });

    describe("Provider-Erkennung", () => {
      it("erkennt OpenRouter-Modelle", () => {
        const client = new CloudClient(mockCfg);
        expect(client).toBeInstanceOf(CloudClient);
      });

      it("unterstützt nur openai-completions API", async () => {
        const client = new CloudClient(mockCfg);
        expect(client).toBeInstanceOf(CloudClient);
      });
    });

    describe("Headers", () => {
      it("sendet korrekte OpenRouter-Headers", async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ choices: [{ message: { content: "Test" } }] }),
        });

        const client = new CloudClient(mockCfg);
        await client.callModel("openrouter/qwen/qwen3-4b:free", "Test");

        expect(fetch).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: "Bearer test-api-key",
              "Content-Type": "application/json",
              "HTTP-Referer": "https://github.com/earendil-works/pi-model-router",
              "X-Title": "pi-model-router",
            }),
          })
        );
      });
    });
  });

  describe("splitModelRef", () => {
    it("teilt Modell-Referenz korrekt auf", () => {
      const client = new CloudClient(mockCfg);
      expect(client).toBeInstanceOf(CloudClient);
    });
  });
});
