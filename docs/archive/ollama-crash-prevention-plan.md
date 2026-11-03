# Ollama Crash Prevention — Diagnosis & Plan

## Diagnosis (from `~/.pi/logs/router.log`)

### Evidence: parallel Ollama streams at 18:42:47 UTC on 2026-08-27

Within **75 milliseconds** (18:42:47.624 → .698), **6 Ollama models** are
brought to stream **simultaneously**:

| Time (UTC) | Model | RAM load |
|---|---|---|
| 18:42:47.624 | `ollama/qwen3.8:27b-mlx` | ~16-20 GB (27B MLX) |
| 18:42:47.647 | `ollama/gemma4:latest` | ~5-8 GB |
| 18:42:47.661 | `ollama/gemma4:12b-mlx` | ~8-12 GB |
| 18:42:47.680 | `ollama/mistral-nemo:latest` | ~6-8 GB |
| 18:42:47.690 | `ollama/ornith:9b` | ~5-7 GB |
| 18:42:47.698 | `ollama/llama3.1:latest` | ~5-8 GB |

**Total: 6 models in parallel → estimated 45-65 GB RAM demand** → Mac crash
(OOM killer or kernel panic).

Before that, **7 OpenRouter free models** were streamed in parallel
(18:42:46.049 → 47.213); they don't consume local RAM, but they show that
this is a **parallel probe of all candidates of a group**, not a sequential
`driveStream`.

### Where do the parallel streams come from?

- `driveStream` itself is **sequential** (for-of loop, line 2741 — breaks
  after the first success).
- The parallel streams come from **pi subagents** started in parallel, each
  streaming a model through the router (e.g. `exploration → scout` at 18:42:38
  in the log, then fan-out).
- The router has **no concurrency control** for local providers
  (Ollama/lm-studio). Every subagent stream immediately loads its model into
  RAM.

### Root cause

No throttling: N concurrent subagent streams → N Ollama models in RAM at the
same time → OOM crash.

## Plan

### Phase 1 — Complete the diagnosis (this section)
- [x] Log analysis: parallel Ollama streams confirmed (6 models in 75ms)
- [x] Code analysis: no concurrency control for local providers present
- [x] Source identified: pi subagent fan-out, not the router itself
- [x] RAM usage of the concrete installed models verified:
      `ollama list` — qwen3.8:27b-mlx (18GB), gemma4:12b-mlx (10GB),
      gemma4:latest (9.6GB), mistral-nemo:latest (7.1GB), ornith:9b (5.6GB),
      llama3.1:latest (4.9GB), gemma2:2b (1.6GB). The 6 parallel-loaded
      models total ~55GB → guaranteed OOM at 16-32GB RAM.

### Decisions (2026-08-28, confirmed by the owner)
- **Release scope:** build first, then decide (1.4.3 vs. 1.5.0 depending on
  the result).
- **Behavior when the limit is exceeded:** **soft-fail** with
  `reason: 'local_concurrency_limit'` → `driveStream` immediately takes the
  next candidate (cloud fallback). No waiting, no queue.
- **Default `ollama_max_concurrent_streams`:** **1** (strictly serial — the
  safest value).

### Phase 2 — Fix (1.4.3 or 1.5.0, depending on scope)

**Option A: process-internal semaphore in the router (recommended, minimal —
TO BE IMPLEMENTED)**
- New config `ollama_max_concurrent_streams` (default 1) in
  `router-defaults.yaml` + `src/types.ts`
- Module-global semaphore counter in `index.ts` (or
  `src/local-llm-throttle.ts`)
- In `tryStream`: when `isLocal` (PROVIDER_MAP), check+increment the counter
  before `streamSimple`, decrement after stream end/error.
- When exceeded: **soft-fail** (no queue) — `tryStream` returns `null` with
  skipReason `'local_concurrency_limit (N of M)'` → `driveStream`
  immediately takes the next candidate (cloud fallback).
- The guard applies ONLY to local providers (`ollama`, `lm-studio`), not to
  the cloud.
- Default 1 = strictly serial for local models.

**Option B: preventive RAM check (in addition to A, if option A alone is not
enough)**
- During the scan: record the model size from `/api/show`
  (`model_info.size` / `details.parameter_size`) in
  `cache.available_models[].capabilities`.
- Before streaming: query available system RAM (`os.totalmem() -
  os.freemem()`), roughly check whether the model still fits. If not:
  soft-fail.
- More complex, platform-dependent — only if option A is insufficient.

**Option C: external monitoring (out of scope for this router)**
- Ollama's own `OLLAMA_MAX_LOADED_MODELS` env var (Ollama-side limit,
  independent of the router).
- System watchdog (see the pi-watchdog subproject in memory).
- Documentation/README recommendation, not router code.

### Phase 3 — Tests
- `test/ollama-concurrency-limit.test.ts`: 3 parallel `groupStream` calls
  with Ollama candidates, `ollama_max_concurrent_streams: 1` → only 1 streams
  at a time, 2 wait or fall through.
- Existing tests must not break (no throttling for free/cloud models).

### Phase 4 — Release
- Version bump, CHANGELOG, roborev review, tag, GitHub Release → npm publish
  (same process as 1.4.2).

## Open questions (all resolved 2026-08-28)
1. ✅ RAM usage verified (see above).
2. ✅ Soft-fail (cloud fallback), no queue.
3. ✅ Default 1 (strictly serial).

## Remaining open question (after implementation)
- Is option A (semaphore) alone sufficient, or is option B (RAM check) also
  needed for 1.5.0? Decision after local testing.
