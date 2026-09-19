# Use-Case Model Groups (`bulk_reader` / `code_writer`) Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.
>
> **STATUS (2026-09-18, late — PAUSED before execution; design REVISED twice):**
> The design in Tasks 1 & 4 below is **STALE**. Final decision:
>
> - **No `exclude_models` denylist and no new `allow_unscored` field.** The
>   user's correction (2026-09-18, late): we already have the cost gate we
>   need — `max_cost: 0`. It excludes expensive models (e.g.
>   `claude-bridge/claude-opus-5`, `cost_per_m: 0.0000015`, NOT free) that
>   would "burn the Pro abo in 5 minutes", because `max_cost: 0` keeps a
>   model only if `isFreeModel && isTokenBased` (`src/dynamic-config.ts:112`).
>   Verified: Opus 5 is not `:free`, not in any `free_models` list, and has
>   `cost_per_m !== 0` → `isFreeModel === false` → excluded. No leak.
> - **`bulk_reader` = `min_context_length: 64000` (new filter) + `max_cost: 0`
>   + `min_gdpval` omitted (no gate, so unscored glm-5.2 is admitted) +
>   `billing_preference: "local_first"`.** Two axes covered: too-expensive
>   (max_cost:0 → Opus out) and too-small-context (min_context_length →
>   gemma2-2b 8k out). Residual edge (free + large-context + weak) is
>   accepted by the user — it costs $0, unlike the Opus case.
> - **`code_writer` = symmetric: `min_context_length: 32000` + `max_cost: 0` +
>   `min_gdpval` omitted + `billing_preference: "local_first"`.**
>
> **Before executing, REVISE:** Task 1 (drop any `exclude_models`/denylist
> mention — only `min_context_length` is new), Task 4 (rewrite the two group
> configs to the `max_cost: 0` + `min_context_length` form above, NOT the
> `min_gdpval: 0`-only form currently in the file).

**Goal:** Add a `min_context_length` group filter and two documented default
groups (`bulk_reader`, `code_writer`) so subagent workflows can address a
*cheap-but-context-rich* model by name — closing the "dedicated model for a
dedicated use-case" gap from ADR-0007 without leaving the router's scope
(resolve a group name → best available model ref).

**Architecture:** Purely additive, three small surfaces: (1) a new
`min_context_length` field on the `Group` interface, applied as a 6th step in
the shared `applyGroupFilters` pipeline in `src/routing.ts` (identical
semantics across all three callers — live resolve, `/router` display,
persisted dynamic config); (2) a `lookupContextWindow(ref)` helper in
`src/metrics.ts` reading the already-scanned `capabilities.contextWindow`
from `cache.available_models` (no new scanning); (3) two new groups declared
in `router-config.json` and documented in `README.md` + ADR-0007. No new
extension, no tool-interception hook, no provider registration — consistent
with ADR-0007's scope conclusion.

**Tech Stack:** TypeScript (Pi extension), Vitest, JSON/YAML config,
Conventional Commits.

---

## Scope boundary (read before implementing)

This plan stays strictly inside the router's stated responsibility: **resolve
a named group to a model ref**. It does **not** implement Spotify-style
task decomposition / tool-call interception — ADR-0007 already concluded
that belongs in a *separate* Pi extension, not in this router. Concretely,
this plan adds:

- a new **filter** (`min_context_length`) to the existing group-filter
  pipeline;
- two new **named groups** (`bulk_reader`, `code_writer`) declared in the
  example config, addressable as `bulk_reader/bulk_reader` and
  `code_writer/code_writer` by subagents (exactly like `trivial/trivial`
  today);
- tests + docs.

It does **not** add: a new group `method`, a `delegate`/`bulk_scan` method,
a `PreToolUse`/`tool_result` hook, a new provider, or any call to
`registerProvider`. (Re-stated from ADR-0007 §"Explicitly rejected
approaches".)

## Preconditions the implementer must honor (read `AGENTS.md` first)

> **Instruction to the implementer:** read `/Users/anierbeck/git/pi-model-router-fork/AGENTS.md`
> in full before starting. This is a **Pi extension**, not a Claude
> extension — every interaction with Pi must go through the **Pi extension
> API** (`ExtensionContext` / `pi.registerProvider` / `pi.modelRegistry` /
> the `streamSimple` hook the router already uses). Do **not** touch Pi's
> files on disk (`models.json`, Pi's config, Pi's cache files) and do **not**
> reach into Pi internals by any other path. The changes in this plan stay
> inside *this repo's own* source/config (`src/`, `router-config.json`) and
> talk to Pi exclusively through the API surface the existing code already
> uses.

The relevant `AGENTS.md` rules, verified against this plan:

- **§1 Release & Publish — explicit user approval only.** This plan ends at
  "commit + push + CI green". Tagging / `gh release create` / `npm publish` /
  triggering a publish workflow are all release actions and remain a
  *separate, explicit* user decision — never an agent action.
- **§3 English only** in all docs/comments/commit messages.
- **§4 `npx tsc --noEmit` and `npx vitest run` must pass** before any
  non-test-only commit. Don't lower `coverage.thresholds` to unblock a red
  run; fix the actual regression. New filters get a regression test that
  actually exercises them (non-vacuous).
- **§5 Conventional-Commits prefixes** (`feat:`, `test:`, `docs:`).
- **§6 Don't touch Pi's `models.json` / don't overwrite existing
  registrations.** `pi.registerProvider` REPLACES the provider's `models`
  array wholesale — never register a provider with a partial model list. 
  **This plan does not call `registerProvider` at all.** The two new groups
  (`bulk_reader`, `code_writer`) are picked up automatically by the existing
  `registerGroupProviders()` loop (`index.ts:1262`), which iterates
  `cfg.model_groups` and registers one virtual provider per group *through
  the Pi API* — so the new groups become addressable as
  `bulk_reader/bulk_reader` / `code_writer/code_writer` with zero extra
  registration code and zero risk to Pi's `models.json`. Do **not** add any
  `registerProvider` call for the new groups.

## Key file references (verified during scoping)

- `src/types.ts:47` — `export interface Group` (add `min_context_length`
  here).
- `src/types.ts:264` — `export interface ModelCapabilities` (already has
  `contextWindow?: number`; **no change needed**).
- `src/types.ts:284` — `AvailableModel.capabilities?: ModelCapabilities`
  (already populated by the scan; **no change needed**).
- `src/capabilities.ts` — normalizes `contextWindow` from Mistral
  (`max_context_length`), OpenRouter (`context_length`), Ollama
  (`model_info.*.context_length`) into `ModelCapabilities.contextWindow`
  (**no change needed** — scanning already works).
- `src/routing.ts:16` — `import { … } from './metrics.ts'` (add
  `lookupContextWindow` to this import).
- `src/routing.ts:80` — `export function applyGroupFilters(…)` (add filter
  step 6 here).
- `src/metrics.ts:262` — `export function lookupGdp(id)` (model the new
  `lookupContextWindow(ref)` on this).
- `src/metrics.ts:372` — `export function setCache(newCache: Cache)` (the
  module-level `cache` variable the new helper reads).
- `index.ts:1262` — `registerGroupProviders()` (registers virtual
  `router-group-<name>` providers per group; **no change needed** — new
  groups are picked up automatically).
- `router-config.json` — example/override config; add the two new groups to
  the `model_groups` block.
- `README.md:345` — "Delegating subtasks to cheap groups (Pi subagents)"
  section (extend with `bulk_reader`/`code_writer` example).
- `README.md:145` — "Group-Based Cost/Quality Routing" (document
  `min_context_length` alongside `min_gdpval`/`max_cost`).
- `docs/adr/0007-task-decomposition-and-delegation.md:195` — "Where the
  router *could* still help" (mark item 1 as delivered by this plan).
- `test/routing-exclude.test.ts` — existing pattern for
  `applyGroupFilters`/`Router` tests with `setConfig`/`setCache` priming
  (model the new test file on this).

---

## Task 1: Add `min_context_length` to the `Group` interface

**Files:**
- Modify: `src/types.ts` (inside `export interface Group`, after
  `max_cost_per_m?: number;`)

**Step 1: Add the field**

Insert immediately after the `max_cost_per_m?: number;` line in the `Group`
interface:

```ts
  /**
   * Minimum model context window (in tokens) required for this group.
   * Models whose scanned `capabilities.contextWindow` is unknown or below
   * this value are dropped — matching the strict (null-fails) semantics of
   * `min_gdpval`. Use this for use-case groups that must hold large inputs
   * (e.g. `bulk_reader` reading several files at once). Absent/0 = no
   * context-length gate (default; preserves existing behaviour).
   */
  min_context_length?: number;
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: PASS (type-only addition; no consumers yet).

**Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(router): add min_context_length field to Group interface"
```

---

## Task 2: Add `lookupContextWindow(ref)` helper in `src/metrics.ts`

**Files:**
- Modify: `src/metrics.ts` (add a new export near `lookupGdp`, ~line 262)
- Test: `test/metrics-context-window.test.ts` (create)

**Step 1: Write the failing test**

Create `test/metrics-context-window.test.ts`:

```ts
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { lookupContextWindow, setConfig, setCache } from '../src/metrics.js';
import type { Cache } from '../src/types.js';

describe('lookupContextWindow', () => {
  beforeAll(() => {
    setConfig({ model_groups: {}, model_metrics: {}, providers: {} });
    const cache: Cache = {
      available_models: [
        { id: 'glm-5-2', provider: 'mistral', cost_per_m: 0, capabilities: { contextWindow: 128_000 } },
        { id: 'gemma-4-31b-it:free', provider: 'openrouter', cost_per_m: 0, capabilities: { contextWindow: 262_144 } },
        // No capabilities → unknown context window.
        { id: 'unknown-ctx-model', provider: 'openrouter', cost_per_m: 0 },
      ],
    };
    setCache(cache);
  });

  afterAll(() => {
    setCache({});
  });

  test('returns the scanned contextWindow for a known mistral model', () => {
    expect(lookupContextWindow('mistral/glm-5-2')).toBe(128_000);
  });

  test('returns the scanned contextWindow for a known openrouter model', () => {
    expect(lookupContextWindow('openrouter/gemma-4-31b-it:free')).toBe(262_144);
  });

  test('returns null when the model has no scanned capabilities', () => {
    expect(lookupContextWindow('openrouter/unknown-ctx-model')).toBeNull();
  });

  test('returns null when the model ref is not in available_models at all', () => {
    expect(lookupContextWindow('openrouter/never-scanned')).toBeNull();
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `npx vitest run test/metrics-context-window.test.ts`
Expected: FAIL — `lookupContextWindow is not a function` (or import error).

**Step 3: Write minimal implementation**

Add to `src/metrics.ts`, immediately after the `lookupGdp` function (after
its closing brace, ~line 290):

```ts
/**
 * Returns the scanned context window (in tokens) for a model ref, or null
 * when the model is unknown or its context window was not reported by the
 * scan. Reads `cache.available_models[].capabilities.contextWindow` — the
 * same field `src/capabilities.ts` normalizes from Mistral
 * (`max_context_length`), OpenRouter (`context_length`), and Ollama
 * (`model_info.*.context_length`).
 *
 * Null is authoritative for "unknown" — callers that need a floor (e.g. the
 * `min_context_length` group filter) must treat null as "fails the gate",
 * mirroring `lookupGdp`'s strict semantics, never as 0 or Infinity.
 */
export function lookupContextWindow(ref: string): number | null {
  const discovered = (cache.available_models ?? []).find(
    (m) => `${m.provider}/${m.id}` === ref,
  );
  const cw = discovered?.capabilities?.contextWindow;
  return typeof cw === 'number' ? cw : null;
}
```

**Step 4: Run the test to verify it passes**

Run: `npx vitest run test/metrics-context-window.test.ts`
Expected: PASS — 4 tests.

**Step 5: Commit**

```bash
git add src/metrics.ts test/metrics-context-window.test.ts
git commit -m "feat(metrics): add lookupContextWindow(ref) reading scanned contextWindow"
```

---

## Task 3: Apply `min_context_length` in `applyGroupFilters`

**Files:**
- Modify: `src/routing.ts:16` (extend the `./metrics.ts` import)
- Modify: `src/routing.ts:80` (`applyGroupFilters`, add step 6)
- Test: `test/routing-context-length.test.ts` (create)

**Step 1: Write the failing test**

Create `test/routing-context-length.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyGroupFilters } from '../src/routing.js';
import * as metricsModule from '../src/metrics.js';
import type { Cache, Group, Config } from '../src/types.js';

// Prime the metrics module's cache so lookupContextWindow(ref) resolves
// from cache.available_models[].capabilities.contextWindow exactly as it
// does in production.
const CACHE: Cache = {
  available_models: [
    { id: 'small-ctx', provider: 'mistral', cost_per_m: 0, capabilities: { contextWindow: 8_000 } },
    { id: 'big-ctx', provider: 'mistral', cost_per_m: 0, capabilities: { contextWindow: 256_000 } },
    { id: 'no-ctx', provider: 'mistral', cost_per_m: 0 }, // unknown context
  ],
};

const CFG: Config = { model_groups: {}, model_metrics: {}, providers: {} };

const REFS = ['mistral/small-ctx', 'mistral/big-ctx', 'mistral/no-ctx'];

describe('applyGroupFilters — min_context_length', () => {
  beforeAll(() => {
    metricsModule.setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: {} });
    metricsModule.setCache(CACHE);
  });
  afterAll(() => {
    metricsModule.setCache({});
  });

  it('is a no-op when min_context_length is absent (regression guard)', () => {
    const g: Group = { method: 'best' };
    expect(applyGroupFilters(REFS, g, CFG)).toEqual(REFS);
  });

  it('is a no-op when min_context_length is 0', () => {
    const g: Group = { method: 'best', min_context_length: 0 };
    expect(applyGroupFilters(REFS, g, CFG)).toEqual(REFS);
  });

  it('drops models below the threshold', () => {
    const g: Group = { method: 'best', min_context_length: 100_000 };
    expect(applyGroupFilters(REFS, g, CFG)).toEqual(['mistral/big-ctx']);
  });

  it('drops models with unknown context window (strict, like min_gdpval)', () => {
    const g: Group = { method: 'best', min_context_length: 5_000 };
    // small-ctx (8k) passes; big-ctx (256k) passes; no-ctx (unknown) is dropped.
    expect(applyGroupFilters(REFS, g, CFG)).toEqual([
      'mistral/small-ctx',
      'mistral/big-ctx',
    ]);
  });

  it('drops everything when no model meets the threshold', () => {
    const g: Group = { method: 'best', min_context_length: 1_000_000 };
    expect(applyGroupFilters(REFS, g, CFG)).toEqual([]);
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `npx vitest run test/routing-context-length.test.ts`
Expected: FAIL — the "drops models below the threshold" case still returns
all three refs because the filter is not implemented yet.

**Step 3: Write minimal implementation**

In `src/routing.ts:16`, extend the import to include `lookupContextWindow`:

```ts
import { getM, lookupGdp, getMatchedSlug, billingTier, effCost, costMux, lookupPrice, calculateScore, lookupContextWindow } from './metrics.ts';
```

In `applyGroupFilters` (immediately after the existing step 5
`max_cost_per_m` block, and before the optional dedup), add step 6:

```ts
  // 6. min_context_length (strict: unknown context window fails the gate,
  //    mirroring min_gdpval's null-fails semantics — never silently admit a
  //    model whose capacity is unverified into a group that *needs* a large
  //    context window). Absent/0 means "no context-length gate".
  if (g.min_context_length != null && g.min_context_length > 0) {
    c = c.filter(ref => {
      const cw = lookupContextWindow(ref);
      return cw !== null && cw >= g.min_context_length!;
    });
  }
```

Also update the JSDoc filter-order comment block above `applyGroupFilters`
to list the new step:

```ts
 *   6. min_context_length — context-window floor; unknown context window
 *                           fails the gate (strict, like min_gdpval)
```

**Step 4: Run the test to verify it passes**

Run: `npx vitest run test/routing-context-length.test.ts`
Expected: PASS — 5 tests.

**Step 5: Run the full suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS — all existing tests still green (filter is additive and
gated on a field that was previously always undefined).

**Step 6: Commit**

```bash
git add src/routing.ts test/routing-context-length.test.ts
git commit -m "feat(routing): apply min_context_length filter in applyGroupFilters"
```

---

## Task 4: Declare `bulk_reader` and `code_writer` groups in `router-config.json`

**Files:**
- Modify: `router-config.json` (add two entries to the `model_groups` block,
  after the `dynamic` group entry)

**Step 1: Add the two groups**

Append inside `model_groups` (keep a trailing comma off the last existing
entry and add these two, comma-separated as appropriate to valid JSON):

```json
    "bulk_reader": {
      "description": "Cheap-but-context-rich models for I/O-heavy subtasks (read+summarize several files). Addressable as bulk_reader/bulk_reader from subagent workflows.",
      "method": "tiered",
      "billing_preference": "local_first",
      "min_gdpval": 0,
      "min_context_length": 64000,
      "fallback_groups": ["scout", "operational", "fallback"]
    },
    "code_writer": {
      "description": "Cheap-and-fast models with enough context for a spec+one reference file (boilerplate generation). Addressable as code_writer/code_writer from subagent workflows.",
      "method": "tiered",
      "billing_preference": "local_first",
      "min_gdpval": 300,
      "min_context_length": 32000,
      "fallback_groups": ["operational", "scout", "fallback"]
    }
```

**Why these thresholds:**
- `bulk_reader` `min_context_length: 64000` — comfortably holds several
  source files plus a summarize instruction; deliberately above the 32k
  baseline so a too-small cheap model is not picked for a multi-file read.
- `code_writer` `min_context_length: 32000` — holds a spec + one reference
  file; lower floor than `bulk_reader` because the input is smaller.
- `min_gdpval: 0` (bulk_reader) / `300` (code_writer) — keep the pool cheap;
  `code_writer` keeps a modest quality floor since generated code must at
  least compile-ish.
- `billing_preference: "local_first"` — prefer local $0 models (Ollama)
  first for these I/O-heavy tasks, exactly like `scout`.

**Step 2: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('router-config.json','utf8')); console.log('valid')"`
Expected: prints `valid`.

**Step 3: Confirm the groups resolve**

Run: `npx vitest run` (the config-loader tests will fail loudly if the new
groups break parsing).
Expected: PASS — no existing config test breaks.

**Step 4: Commit**

```bash
git add router-config.json
git commit -m "feat(config): add bulk_reader and code_writer use-case groups"
```

---

## Task 5: Document the new filter and groups in `README.md`

**Files:**
- Modify: `README.md:145` ("Group-Based Cost/Quality Routing" — document
  `min_context_length`)
- Modify: `README.md:345` ("Delegating subtasks to cheap groups" — add a
  `bulk_reader` example)

**Step 1: Document `min_context_length` in the cost/quality section**

In the "Group-Based Cost/Quality Routing" paragraph (around line 145), after
the sentence mentioning `min_gdpval` and `max_cost`, add:

```markdown
A group may also set `min_context_length` to require a minimum model context
window (in tokens). Models whose scanned context window is unknown or below
the threshold are dropped — strict, like `min_gdpval`. This lets a
use-case-specific group (e.g. `bulk_reader`) guarantee its cheap models can
actually hold the large inputs the use case demands, instead of falling back
to the smallest free model that would truncate.
```

**Step 2: Add a `bulk_reader` subagent example**

In the "Delegating subtasks to cheap groups (Pi subagents)" section (around
line 345), after the existing `trivial/trivial` example block, add a second
example highlighting the new use-case group:

````markdown
The `bulk_reader` group adds a `min_context_length` floor so the cheap model
it resolves to is guaranteed to hold several files at once — exactly the
property a trivial/scout group does *not* guarantee:

```js
subagent({
  workflowScript: `
    const files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
    const summaries = await runs.all(files.map((f) => ({
      key: f,
      agent: "scout",
      model: "bulk_reader/bulk_reader",
      task: "Read " + f + " and return a bullet list of its public API.",
    })));
    return runs.run("synthesize", {
      agent: "worker",
      model: "strategic/strategic",
      task: "Given these file summaries, propose a refactor:\\n\\n" +
        summaries.map((s) => s.output).join("\\n\\n"),
    });
  `,
});
```

`code_writer/code_writer` is the symmetric counterpart: a cheap group with
enough context for a spec + one reference file, used to generate boilerplate
the expensive model never has to read back as output tokens.
````

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document min_context_length filter and bulk_reader/code_writer groups"
```

---

## Task 6: Update ADR-0007 to mark the in-scope item as delivered

**Files:**
- Modify: `docs/adr/0007-task-decomposition-and-delegation.md:195`
  ("Where the router *could* still help", item 1)

**Step 1: Mark item 1 as delivered**

Under "## Where the router *could* still help (in-scope, incremental)",
update item 1 so it records that the pattern is now documented *and* backed
by dedicated groups. Replace the existing item-1 text with:

```markdown
1. **Document the pattern** — *delivered (2026-09-18):* README's
   "Delegating subtasks to cheap groups" section now shows the
   `bulk_reader/bulk_reader` fan-out + `strategic/strategic` synthesis
   pattern, and the router ships two dedicated use-case groups
   (`bulk_reader`, `code_writer`) that add a `min_context_length` floor so a
   cheap model is guaranteed to hold the large inputs the use case demands.
   This is the router's entire, in-scope contribution: resolving a named
   group to a model ref. The decision to *split* a task still belongs to
   the subagent/orchestrating layer (see "Who actually decomposes a task
   today?" below).
```

Leave item 2 ("Nothing else changes in the router's code …") as-is — it
remains accurate (no new method/provider/hook was added).

**Step 2: Commit**

```bash
git add docs/adr/0007-task-decomposition-and-delegation.md
git commit -m "docs(adr): mark ADR-0007 in-scope item 1 (document the pattern) as delivered"
```

---

## Task 7: Final verification

**Step 1: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

**Step 2: Full test suite**

Run: `npx vitest run`
Expected: PASS — all previous tests green plus the 9 new tests (4 from
Task 2 + 5 from Task 3). Count should be previous baseline + 9.

**Step 3: Sanity-resolve the new groups manually (optional but recommended)**

If Ollama is running, load the router in a Pi session and check `/router`
shows `bulk_reader` and `code_writer` resolving to context-rich cheap
models (not the smallest free model). If Ollama is unavailable, skip — the
unit tests already cover the filter logic.

**Step 4: Push**

```bash
git push
```

Expected: CI green. **Stop here.** Tagging / releasing / publishing is a
separate user decision (AGENTS.md §1) — do not proceed to any release
action without explicit, release-specific approval.

---

## Out of scope (explicitly not done by this plan)

- Any Spotify-style `tool_result`/`tool_call` hook, threshold-based shunt,
  or automatic task decomposition. That is ADR-0007's rejected approach and
  would require a separate Pi extension with its own `AGENTS.md`.
- Any new group `method`, any `delegate`/`bulk_scan` method.
- Any call to `registerProvider` (the new groups resolve through the
  existing virtual per-group provider — Ü1 invariant trivially satisfied).
- Auto-picking `bulk_reader` vs `code_writer` based on prompt content —
  that is classifier/orchestrator work, not group resolution. The groups
  are *addressable by name*; who picks the name is a layer above.
