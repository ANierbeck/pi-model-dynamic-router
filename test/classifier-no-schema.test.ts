// test/classifier-no-schema.test.ts
// Regression tests for the classifier's "primary rejects structured output"
// self-healing.
//
// Live incident 2026-09-26: the classifier primary ran on the MLX backend,
// which answers every JSON-schema call with HTTP 501
// "structured output is unavailable" — every classification burned a
// guaranteed-501 hop before the fallback model answered. The fix has two
// parts: (1) a schema-capable DEFAULT_MODEL, and (2) self-healing — a 501
// marks the primary in cache.classifier_no_schema, and subsequent calls skip
// the marked primary entirely (straight to the fallback).
//
// Behavior under test:
//   1. A 501 "structured output is unavailable" primary failure marks the
//      model in cache.classifier_no_schema.
//   2. On the next call the marked primary is NOT called — the fallback
//      answers directly (one callOllama invocation, not two).
//   3. Other primary failures (timeouts, load errors) do NOT mark the model;
//      the primary is retried on the next call (two invocations).
//   4. Aged marks (past the TTL) are retried — an Ollama upgrade that adds
//      schema support to a backend self-heals.
//   5. When the marked-skip path's fallback also fails, classifyPrompt
//      degrades (no throw) — fail-open preserved.

import { describe, it, beforeEach, expect, vi } from "vitest";
import { classifyPrompt } from "../src/content-classifier.js";
import * as ollamaUtils from "../src/ollama-utils";
import { localModelCache } from "./helpers/local-model-cache.ts";

vi.mock("../src/ollama-utils", () => ({
  callOllama: vi.fn(),
  // Daemon probed as reachable so the mocked Ollama path stays exercised.
  isOllamaAvailable: vi.fn(async () => true),
}));

const NO_SCHEMA_501 = 'Ollama HTTP 501: {"error":"structured output is unavailable"}';
const VALID = '{"category": "trivial", "reason": "test", "confidence": 0.9}';

// Prompts must be unique across the whole suite: classifyPrompt caches
// successful results in a module-level LRU (5 min TTL) keyed by raw prompt.
describe("classifier no-structured-output self-healing (live incident 2026-09-26)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(ollamaUtils.isOllamaAvailable).mockResolvedValue(true);
  });

  it("marks the primary on a 501 structured-output failure and skips it on the next call", async () => {
    const callOllama = vi.mocked(ollamaUtils.callOllama);
    // First call: primary rejects with the 501, fallback answers.
    callOllama.mockRejectedValueOnce(new Error(NO_SCHEMA_501));
    callOllama.mockResolvedValueOnce(VALID);
    const cache: Record<string, any> = localModelCache();
    const r1 = await classifyPrompt("no-schema marking: first turn prompt", { cache });
    expect(r1?.category).toBe("trivial");
    // The failing primary must now be marked.
    expect(cache.classifier_no_schema).toBeTruthy();
    const marked = Object.keys(cache.classifier_no_schema);
    expect(marked.length).toBe(1);

    // Second call, same cache: the marked primary must NOT be called —
    // exactly one invocation, which is the fallback (not the marked model).
    callOllama.mockClear();
    callOllama.mockResolvedValue(VALID);
    const r2 = await classifyPrompt("no-schema marking: second turn prompt", { cache });
    expect(r2?.category).toBe("trivial");
    expect(callOllama).toHaveBeenCalledTimes(1);
    expect(String(callOllama.mock.calls[0][0])).not.toBe(marked[0]);
  });

  it("does not mark the model on other primary failures — the primary is retried", async () => {
    const callOllama = vi.mocked(ollamaUtils.callOllama);
    // First call: primary times out (NOT a 501), fallback answers.
    callOllama.mockRejectedValueOnce(new Error("no response within timeout"));
    callOllama.mockResolvedValueOnce(VALID);
    const cache: Record<string, any> = localModelCache();
    const r1 = await classifyPrompt("timeout marking: first turn prompt", { cache });
    expect(r1?.category).toBe("trivial");
    expect(cache.classifier_no_schema).toBeUndefined();

    // Second call: the primary is tried again — two invocations
    // (primary + fallback), not a skip.
    callOllama.mockClear();
    callOllama.mockRejectedValueOnce(new Error("no response within timeout"));
    callOllama.mockResolvedValueOnce(VALID);
    const r2 = await classifyPrompt("timeout marking: second turn prompt", { cache });
    expect(r2?.category).toBe("trivial");
    expect(callOllama).toHaveBeenCalledTimes(2);
  });

  it("retries the primary once a no-schema mark has aged past the TTL", async () => {
    const callOllama = vi.mocked(ollamaUtils.callOllama);
    // Mark via the real path (primary 501, fallback answers).
    callOllama.mockRejectedValueOnce(new Error(NO_SCHEMA_501));
    callOllama.mockResolvedValueOnce(VALID);
    const cache: Record<string, any> = localModelCache();
    await classifyPrompt("aged mark: first turn prompt", { cache });
    const markedName = Object.keys(cache.classifier_no_schema ?? {})[0];
    expect(markedName).toBeTruthy();

    // Age the mark beyond the 24h TTL.
    cache.classifier_no_schema[markedName] = Date.now() - 25 * 60 * 60_000;

    // The primary is retried and now succeeds — exactly one invocation,
    // and it is the previously-marked model.
    callOllama.mockClear();
    callOllama.mockResolvedValue(VALID);
    const r = await classifyPrompt("aged mark: second turn prompt", { cache });
    expect(r?.category).toBe("trivial");
    expect(callOllama).toHaveBeenCalledTimes(1);
    expect(String(callOllama.mock.calls[0][0])).toBe(markedName);
  });

  it("degrades without throwing when the marked primary is skipped and the fallback also fails", async () => {
    const callOllama = vi.mocked(ollamaUtils.callOllama);
    // Mark the primary via the real path.
    callOllama.mockRejectedValueOnce(new Error(NO_SCHEMA_501));
    callOllama.mockResolvedValueOnce(VALID);
    const cache: Record<string, any> = localModelCache();
    await classifyPrompt("skip fail-open: first turn prompt", { cache });

    // Now the fallback fails too — classifyPrompt must degrade without
    // throwing: the static fallback (classifyStatically) answers with a
    // usable category (fail-open: always a classification result).
    callOllama.mockClear();
    callOllama.mockRejectedValue(new Error("no response within timeout"));
    const r = await classifyPrompt("skip fail-open: second turn prompt", { cache });
    expect(r).toBeTruthy();
    expect(r?.category).toBeTruthy();
  });
});
