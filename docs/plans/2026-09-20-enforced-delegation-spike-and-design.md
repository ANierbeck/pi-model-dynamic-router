# Enforced Delegation in the Router — Spike Results & Module Design

**Date:** 2026-09-20
**ADR:** revises [ADR-0007](../adr/0007-task-decomposition-and-delegation.md)
**Status:** implementation approved by user (read-only scope, enabled in fork config)

## 1. Spike verification (2026-09-20, live headless run)

Probe extension: `/tmp/router-spike/probe.ts` — registered `tool_call` + `tool_result`
hooks, summarized an oversized `read` result (51,166 chars) via
`ctx.modelRegistry.find('bulk_reader', 'bulk_reader')` +
`ctx.modelRegistry.runtime.streamSimple(...)`, returned
`{ content: [summary], usage }`.

| # | Claim (ADR-0007 open question) | Result | Evidence |
|---|-------------------------------|--------|----------|
| 1 | `tool_call` fires for `read` with full input | ✅ | log: path + offset/limit |
| 2 | `tool_result` delivers full content before the model sees it | ✅ | textLen 51,166 |
| 3 | Replacement reaches the calling model | ✅ | final answer quoted the replacement, not `LINE 0001` |
| 4 | Sub-call routes through the router group (full target architecture) | ✅ | `bulk_reader/bulk_reader` → router cascade → Mistral |
| 5 | Nested `usage` attachable & accounted | ✅ | `{ input: 11973, output: 108, totalTokens: 12081, cost.total: $0.00048 }` |

Bonus: targeted reads pass through untouched — the model's `offset:1, limit:1`
read (179 chars) was correctly NOT delegated. This is the exact degradation
path Spotify's bulk-reader relies on: *understand broadly via summary, then
re-read narrowly for exact lines.*

### Spike finding: router narration leaks into machine-facing output

The router narrates its candidate cascade (`> [router] X — provider error: …`)
as `text_delta` events **into the sub-call stream**. For human sessions that is
intended behavior; for a machine-facing summary consumer it is noise — the
probe's 5 KB "summary" contained ~5 KB of narration and only 108 output tokens
of real summary.

**Consequence:** the delegation module MUST strip `> [router]` lines from
sub-call output before replacing a tool result. Fail-safe regardless of which
candidate ends the cascade.

## 2. Design — `src/delegation.ts`

### Scope (user decision 2026-09-20)

- **Intercepted tool:** `read` only. (`bash cat/head/tail` detection is
  heuristic and fragile; extensible later via a `tools` allowlist.)
- **Initial state:** `delegation.enabled: true` in the fork's
  `router-config.json` (live testing after restart). Upstream default OFF.

### Config (types.ts, layered like `exclude` — always from staticCfg)

```jsonc
"delegation": {
  "enabled": false,      // master switch (fork: true)
  "min_chars": 20000,   // min text length to delegate (read results are ≤ 50 KB)
  "group": "bulk_reader", // router group for the summarization call
  "max_raw_chars": 60000 // cap of raw text passed to the summarizer
}
```

`delegation` is user intent — like `exclude` and the timeout overrides it is
ALWAYS taken from the static (layered) config, never from the dynamic config,
so a stale `router-config.dynamic.json` can never silently change it.

### Trigger conditions (ALL must hold)

1. `delegation.enabled` is true
2. `event.toolName === 'read'`
3. `event.isError` is falsy (errors are small and important)
4. content is an array of **only** text blocks (no images/attachments)
5. joined text length ≥ `min_chars`

Any miss → return `undefined` → original result passes through untouched.

### Sub-call (Pi public APIs only — Leitplanke)

```
model = ctx.modelRegistry.find(group, group)      // router group provider
stream = ctx.modelRegistry.runtime.streamSimple(model, context, { signal: ctx.signal })
```

The router's own group interception resolves the cheap model — the module has
ZERO coupling to router internals; if the group is not registered, fail-open.

### Output hygiene

- Strip every line starting with `> [router]` (covers MHINT narration) from
  the accumulated sub-call text; collapse resulting blank runs.
- If < 50 chars remain after stripping (cascade narrated, no real summary) →
  fail-open, original passes through.

### Replacement shape

```
[delegated summary of a {N}-char read result — re-read with offset/limit for exact lines]

{summary bullets}
```

The marker tells the orchestrating model that a targeted re-read is available
(and passes through untouched) — the degradation path verified in the spike.

### Fail-open everywhere

Any throw, missing registry, empty stream, abort → return `undefined`.
The main model must never lose the original result because delegation broke.
Nested `usage` from the sub-call is attached to the replacement when
available (verified live: token counts + cost appear in footer//session).

### Wiring (index.ts, existing `tool_result` handler)

```ts
pi.on('tool_result', async (ev, ctx) => {
  // Enforced delegation (ADR-0007): shrink oversized read results first.
  const replacement = await handleReadDelegation(ev, ctx, cfg, routerLog);
  if (replacement) return replacement;
  // … existing rate-limit key-rotation logic …
});
```

Single handler — no multi-handler return semantics involved.

## 3. Test plan (TDD)

`test/delegation.test.ts`:
- `delegationSettings`: defaults, full override, disabled-when-missing
- `extractTextContent`: text-only join, mixed blocks → null, empty → null
- `stripRouterNarration`: removes `> [router]` lines (incl. MHINT), keeps content
- `buildSummaryPrompt`: contains instruction + raw excerpt
- `handleReadDelegation` (mock ctx, spy streamSimple):
  disabled / non-read / error / short / mixed-blocks → undefined, stream never called
  happy path → `{ content, usage }` with marker + stripped summary
  narration-only sub-output → fail-open
  group missing / stream throws / stream error event → fail-open
- Integration: router default export's `tool_result` handler returns the
  replacement end-to-end (bootRouterWithMockPi pattern, delegation enabled).

## 4. Future extensions (out of scope for v1)

- `bash` output delegation (fragile command heuristics — needs design)
- Configurable summary prompt / per-tool thresholds
- Router "quiet mode" (suppress narration for machine-facing sub-calls
  instead of stripping afterwards — cleaner, but needs a stream-option
  flag through the group provider; strip is fail-safe and sufficient now)
