# Cloud-First Routing (Local Ollama as Last Resort) Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Stop the local Ollama daemon from being hit on nearly every
classified turn (100% GPU load reported by the owner) by making the
already-implemented cloud classification path the default, and by making
five model groups rank cloud models ahead of local ones — Ollama becomes a
last-resort fallback, not the default path.

**Architecture:** No new infrastructure. Reorder `classifyPrompt`'s
try-sequence so the existing cloud fallback chain (gated by
`allowCloudFallback`, already `true` in production config) runs BEFORE the
local Ollama attempts instead of after. Add two new `billing_preference`
sort modes (`cloud_first`, `local_before_payg`) to the existing
`sortByBillingPreference` ranking function and apply them to the five
local-biased groups in `router-config.json`.

**Tech Stack:** TypeScript, Vitest, existing `src/content-classifier.ts` /
`src/routing.ts` modules.

**Design doc:** `docs/plans/2026-09-27-cloud-first-local-fallback-design.md`

---

## Task 1: `cloud_first` and `local_before_payg` billing-preference modes

**Files:**
- Modify: `src/types.ts:88`
- Modify: `src/routing.ts:661-716` (`sortByBillingPreference`)
- Test: `test/billing-preference.test.ts`

**Step 1: Write the failing tests**

Append two new `describe` blocks to `test/billing-preference.test.ts` (reuse
the file's existing `testConfig`/`cache` fixtures — do not duplicate them):

```ts
describe('sortByBillingPreference — cloud_first override (free → subscription → payg → local, local always last)', () => {
  const router = new Router(testConfig, cache, new Map());

  it('ranks local (Ollama) LAST — even behind payg', () => {
    const sorted = router.sortByBillingPreference(
      ['ollama/gemma4:12b-mlx', 'openai/gpt-4', 'mistral/mistral-medium-latest'],
      'cloud_first'
    );
    expect(sorted[0]).toBe('mistral/mistral-medium-latest');
    expect(sorted[1]).toBe('openai/gpt-4');
    expect(sorted[2]).toBe('ollama/gemma4:12b-mlx');
  });

  it('ranks free ahead of subscription and payg with cloud_first', () => {
    const sorted = router.sortByBillingPreference(
      ['mistral/mistral-medium-latest', 'openrouter/ling-3.0-flash-fin:free', 'openai/gpt-4'],
      'cloud_first'
    );
    expect(sorted[0]).toBe('openrouter/ling-3.0-flash-fin:free');
    expect(sorted[1]).toBe('mistral/mistral-medium-latest');
    expect(sorted[2]).toBe('openai/gpt-4');
  });
});

describe('sortByBillingPreference — local_before_payg override (free → subscription → local → payg)', () => {
  const router = new Router(testConfig, cache, new Map());

  it('ranks local (Ollama) ahead of payg but behind subscription', () => {
    const sorted = router.sortByBillingPreference(
      ['openai/gpt-4', 'ollama/gemma4:12b-mlx', 'mistral/mistral-medium-latest'],
      'local_before_payg'
    );
    expect(sorted[0]).toBe('mistral/mistral-medium-latest');
    expect(sorted[1]).toBe('ollama/gemma4:12b-mlx');
    expect(sorted[2]).toBe('openai/gpt-4');
  });

  it('still ranks free ahead of local with local_before_payg', () => {
    const sorted = router.sortByBillingPreference(
      ['ollama/gemma4:12b-mlx', 'openrouter/ling-3.0-flash-fin:free'],
      'local_before_payg'
    );
    expect(sorted[0]).toBe('openrouter/ling-3.0-flash-fin:free');
    expect(sorted[1]).toBe('ollama/gemma4:12b-mlx');
  });
});
```

**Step 2: Run to verify it fails**

Run: `npx vitest run test/billing-preference.test.ts`
Expected: FAIL — `cloud_first`/`local_before_payg` are not valid values yet
(TS will also fail to compile once Step 3's type isn't updated first — run
the type change in Step 3 together with the test, or expect a runtime
fallback to `default` ranking, which produces the WRONG order and fails the
assertions).

**Step 3: Extend the type and the ranking function**

`src/types.ts:88` — change:
```ts
  billing_preference?: 'default' | 'local_first' | 'strict_local';
```
to:
```ts
  billing_preference?:
    | 'default'
    | 'local_first'
    | 'strict_local'
    | 'cloud_first'
    | 'local_before_payg';
```

`src/routing.ts` — replace the `sortByBillingPreference` body (the
`billingPreference` parameter type and the `ra`/`rb` ternary block) with a
single `rank()` helper covering all five modes (consolidates the existing
`strict_local`/`local_first` duplicated ternary — in scope while touching
this function, AGENTS.md §7):

```ts
  sortByBillingPreference(
    refs: string[],
    billingPreference:
      | 'default'
      | 'local_first'
      | 'strict_local'
      | 'cloud_first'
      | 'local_before_payg' = 'default'
  ): string[] {
    // strict_local: local(2) → free(0) → sub(1) → payg(3) — the local
    // daemon FIRST (trivial/simple's old ordering before 2026-09-27).
    const strictRank = (t: number) => (t === 2 ? 0 : t === 0 ? 1 : t === 1 ? 2 : 3);
    // cloud_first: free(0) → sub(1) → payg(3) → local(2) ALWAYS LAST.
    // For scout/bulk_reader/code_writer — the local Ollama daemon is a
    // last-resort fallback, not a default path (2026-09-27, repeated GPU
    // load / MLX-wedge incidents made the local daemon untrusted as a
    // default hop).
    const cloudFirstRank = (t: number) => (t === 0 ? 0 : t === 1 ? 1 : t === 3 ? 2 : 3);
    // local_before_payg: free(0) → sub(1) → local(2) → payg(3). For
    // trivial/simple — keeps a free local fallback ahead of PAYG spend for
    // the cheapest prompts, without ranking local ahead of free/subscription
    // like the old strict_local did.
    const localBeforePaygRank = (t: number) => (t === 0 ? 0 : t === 1 ? 1 : t === 2 ? 2 : 3);
    const rank = (t: number): number => {
      switch (billingPreference) {
        case 'strict_local':
          return strictRank(t);
        case 'local_first':
          // Rank local (2) level with free (0), ahead of subscription (1).
          return t === 2 ? 0.5 : t;
        case 'cloud_first':
          return cloudFirstRank(t);
        case 'local_before_payg':
          return localBeforePaygRank(t);
        default:
          return t;
      }
    };
    return [...refs].sort((a, b) => {
      const ta = billingTier(a),
        tb = billingTier(b);
      const ra = rank(ta);
      const rb = rank(tb);
      if (ra !== rb) return ra - rb;
      // Within subscription tier, prefer lower rate-limit pressure first, then cost
      if (ta === 1) {
        const pa = this.limitSecs(a),
          pb = this.limitSecs(b);
        if (pa !== pb) return pa - pb;
      }
      const costA = effCost(a);
      const costB = effCost(b);
      // Handle 'unknown' costs - treat them as equal, fall through to gdpval tiebreaker
      if (costA !== 'unknown' || costB !== 'unknown') {
        if (costA === 'unknown') return 1; // unknown costs go to the end
        if (costB === 'unknown') return -1;
        if (costA !== costB) return costA - costB;
      }
      // Cost ties (e.g. all $0.0 subscription/local models) would otherwise fall
      // through to Array.sort's stable order, i.e. registry insertion order — not
      // a ranking. Prefer higher-quality models when cost cannot discriminate.
      return getM(b).gdpval - getM(a).gdpval;
    });
  }
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/billing-preference.test.ts`
Expected: PASS — all describe blocks (existing `default`, `strict_local`,
`local_first`, plus the two new ones) green.

Run: `npx tsc --noEmit`
Expected: no errors.

**Step 5: Commit**

```bash
git add src/types.ts src/routing.ts test/billing-preference.test.ts
git commit -m "feat: add cloud_first and local_before_payg billing-preference modes

Consolidates the ra/rb ranking ternary into a single rank() helper
while adding the two new modes (Boyscout Rule, AGENTS.md §7).

Enables groups to rank local Ollama models behind cloud models
(cloud_first: always last; local_before_payg: ahead of payg only) —
needed so trivial/simple/scout/bulk_reader/code_writer can stop
defaulting to the local daemon, which has repeatedly pinned the GPU
at 100% (MLX wedge incidents, 2026-09-25/26)."
```

---

## Task 2: Switch the five groups to the new modes

**Files:**
- Modify: `router-config.json` (5 lines)
- Test: new guard test `test/config-cloud-first-groups.test.ts`

**Step 1: Write the failing guard test**

Create `test/config-cloud-first-groups.test.ts` (follow the existing pattern
in `test/config-opus-5-5-routable.test.ts` — read the real
`router-config.json` from disk, no mocking):

```ts
// test/config-cloud-first-groups.test.ts
// Guards the 2026-09-27 cloud-first routing change: five model groups must
// rank cloud models ahead of the local Ollama daemon, which had repeatedly
// pinned the GPU at 100% when hit as a default path (MLX wedge incidents).
// A silent revert to strict_local/local_first would reintroduce that load.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const cfg = JSON.parse(readFileSync(join(__dirname, '../router-config.json'), 'utf-8'));

describe('router-config.json — cloud-first group billing_preference', () => {
  it.each(['scout', 'bulk_reader', 'code_writer'])(
    '%s uses cloud_first (local always last)',
    (group) => {
      expect(cfg.model_groups[group]?.billing_preference).toBe('cloud_first');
    }
  );

  it.each(['trivial', 'simple'])(
    '%s uses local_before_payg (local ahead of payg only)',
    (group) => {
      expect(cfg.model_groups[group]?.billing_preference).toBe('local_before_payg');
    }
  );

  it('no group still uses the old local-biased modes', () => {
    const offenders = Object.entries(cfg.model_groups)
      .filter(([, g]: [string, any]) => g.billing_preference === 'strict_local' || g.billing_preference === 'local_first')
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });
});
```

**Step 2: Run to verify it fails**

Run: `npx vitest run test/config-cloud-first-groups.test.ts`
Expected: FAIL — `router-config.json` still has `strict_local`/`local_first`.

**Step 3: Update router-config.json**

- `trivial` (`billing_preference": "strict_local"` at line 38) → `"local_before_payg"`
- `simple` (line 47) → `"local_before_payg"`
- `scout` (line 103) → `"cloud_first"`
- `bulk_reader` (line 134) → `"cloud_first"`
- `code_writer` (line 142) → `"cloud_first"`

Also update the two `description` strings that say "local daemon first" to
stay accurate (Boyscout — stale docs are a smell):
- `trivial`: `"Trivial tasks - local daemon first, then free models"` →
  `"Trivial tasks - free/subscription first, local Ollama as a fallback before PAYG"`
- `simple`: `"Simple tasks - local daemon first, then free or very cheap models"` →
  `"Simple tasks - free/subscription first, local Ollama as a fallback before PAYG"`
- `scout`: `"Any available model, cheapest first — local $0-Modelle bevorzugt"` →
  `"Any available model, cheapest first — cloud models preferred, local Ollama as last resort"`
  (also fixes the stray German clause per AGENTS.md §3 — English-only docs)

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/config-cloud-first-groups.test.ts`
Expected: PASS.

Run: `npx vitest run` (full suite — a config change can ripple into other
group-shape assertions elsewhere)
Expected: all green, same count as before (or +5 new tests from Task 1/2).

Run: `npx tsc --noEmit`
Expected: no errors.

**Step 5: Commit**

```bash
git add router-config.json test/config-cloud-first-groups.test.ts
git commit -m "fix: rank cloud models ahead of local Ollama in 5 groups

trivial/simple: strict_local -> local_before_payg (local no longer
ranks ahead of free/subscription, only ahead of payg).
scout/bulk_reader/code_writer: local_first -> cloud_first (local
always ranks last, even behind payg).

Fixes the local Ollama daemon being hit as a default path in these
groups, which repeatedly pinned the GPU at 100% (owner report,
2026-09-27)."
```

---

## Task 3: Reorder the classifier's try-sequence (cloud first, Ollama last resort)

**Files:**
- Modify: `src/content-classifier.ts:549-732` (inside `classifyPrompt`)
- Test: `test/classifier-fallback-chain.test.ts`

**Context:** `classifyPrompt` currently tries Ollama primary → Ollama
fallback FIRST (unconditionally), and only runs the cloud fallback chain
(`allowCloudFallback`-gated) if both Ollama attempts fail or the daemon is
unavailable/wedged. Production already sets
`classifier_cloud_fallback: true` (`router-config.json:122`), so this
reorder is the change that actually stops the classifier from hitting
Ollama on (almost) every turn.

**Step 1: Write/adjust the failing tests first**

In `test/classifier-fallback-chain.test.ts`, the test **"classifies via
completeSimple when both Ollama models fail"** (in the `describe('cloud
fallback paths', ...)` block) encodes the OLD order (Ollama tried first,
then cloud). Replace it:

```ts
    it('classifies via completeSimple WITHOUT ever touching Ollama when cloud-first is enabled', async () => {
      // Cloud is tried FIRST when allowCloudFallback is true (2026-09-27) —
      // Ollama only becomes a last resort if the entire cloud chain fails.
      // callOllama is still mocked to reject so a regression that restores
      // the old Ollama-first order would surface as a failing assertion
      // below, not as a silently-passing test.
      vi.mocked(callOllama).mockRejectedValue(new Error('ECONNREFUSED'));
      const completeSimple = vi.fn().mockResolvedValue(
        cloudReply({ category: 'code_simple', reason: 'from cloud', confidence: 0.85 })
      );
      const findModel = vi.fn().mockReturnValue(mockModel);

      const result = await classifyPrompt('Please add a small import statement to that file', {
        allowCloudFallback: true,
        cfg: {} as any,
        cache: { classifier_fallback_models: ['prov/cloud-a'] } as any,
        completeSimple,
        findModel,
      });

      expect(callOllama).not.toHaveBeenCalled();
      expect(completeSimple).toHaveBeenCalledTimes(1);
      expect(findModel).toHaveBeenCalledWith('prov/cloud-a');
      expect(result).toEqual({ category: 'code_simple', reason: 'from cloud', confidence: 0.85 });
    });
```

Add a NEW test right after it proving the last-resort behavior (this is the
non-vacuous regression test for the reorder itself — without it, Task 3
could regress to "cloud only, no local fallback at all" and nothing would
catch it):

```ts
    it('falls back to Ollama as a LAST RESORT when the entire cloud chain fails', async () => {
      vi.mocked(callOllama)
        .mockRejectedValueOnce(new Error('ECONNREFUSED')) // primary
        .mockResolvedValueOnce( // fallback
          ollamaReply({ category: 'simple', reason: 'local last resort', confidence: 0.8 })
        );
      const completeSimple = vi.fn().mockResolvedValue({ errorMessage: 'provider 500', stopReason: 'error' });
      const findModel = vi.fn().mockReturnValue(mockModel);

      const result = await classifyPrompt('Explain the difference between let and const briefly', {
        model: 'gemma-primary',
        fallbackModel: 'gemma-backup',
        allowCloudFallback: true,
        cfg: {} as any,
        cache: { classifier_fallback_models: ['prov/cloud-a'] } as any,
        completeSimple,
        findModel,
      });

      // Cloud was tried first (and failed) before Ollama was touched at all.
      expect(completeSimple).toHaveBeenCalledTimes(1);
      expect(callOllama).toHaveBeenCalledTimes(2);
      expect(vi.mocked(callOllama).mock.calls[0]?.[0]).toBe('gemma-primary');
      expect(vi.mocked(callOllama).mock.calls[1]?.[0]).toBe('gemma-backup');
      expect(result).toEqual({ category: 'simple', reason: 'local last resort', confidence: 0.8 });
    });
```

**Step 2: Run to verify both fail**

Run: `npx vitest run test/classifier-fallback-chain.test.ts`
Expected: FAIL on both new/adjusted tests (current code still tries Ollama
first, so `callOllama` gets called in the first test, and the second test's
"cloud tried before Ollama at all" ordering doesn't hold yet).

**Step 3: Reorder `classifyPrompt`**

Replace the block from the `// Primary model — may be slow on cold start.`
comment (right after `tryClassify` is defined) through the end of the cloud
fallback `try {...} catch (cloudFallbackError) {...}` block (i.e. everything
between `tryClassify`'s closing `};` and the `// Static fallback` comment)
with:

```ts
  // Primary model — may be slow on cold start. A short availability probe
  // guards BOTH local attempts: when the daemon is unreachable (down or
  // hanging port), we skip straight to the cloud fallback chain instead of
  // burning primary+fallback timeouts on every prompt.
  let classificationResult: FullClassificationResult | null = null;
  const ollamaWedged = isProviderWedged(cache, 'ollama');

  const tryOllama = async (): Promise<void> => {
    if (!ollamaWedged && (await isOllamaAvailable())) {
      // Self-healing: a primary marked as rejecting structured output (a 501
      // from e.g. the MLX backend — permanent for that backend, not transient)
      // is skipped entirely. No guaranteed-501 hop on every prompt.
      if (model !== fallbackModel && isMarkedNoSchema(cache, model)) {
        routerLog(
          `[classifier] Primary model "${model}" marked no-structured-output (501) — trying ${fallbackModel} directly`
        );
        try {
          classificationResult = await tryClassify(fallbackModel, fallbackTimeoutMs);
        } catch (fallbackError) {
          routerLog(`[classifier] Fallback model also failed`, (fallbackError as Error).message);
        }
      } else {
        try {
          classificationResult = await tryClassify(model, timeoutMs);
        } catch (primaryError) {
          const primaryMsg = String((primaryError as Error)?.message ?? '');
          // Cold-start timeout or load error → retry immediately with the fallback model
          if (model !== fallbackModel) {
            if (primaryMsg.includes(NO_SCHEMA_MARKER)) {
              // Permanent backend property, not transient — mark and never
              // burn this hop again while the mark is within its TTL.
              markNoSchema(cache, model);
              routerLog(
                `[classifier] Primary model "${model}" rejects structured output (501) — marked in cache, retrying with ${fallbackModel}`,
                primaryMsg
              );
            } else {
              routerLog(
                `[classifier] Primary model "${model}" failed, retrying with ${fallbackModel}`,
                primaryMsg
              );
            }
            try {
              classificationResult = await tryClassify(fallbackModel, fallbackTimeoutMs);
            } catch (fallbackError) {
              routerLog(`[classifier] Fallback model also failed`, (fallbackError as Error).message);
            }
          }
        }
      }
    } else if (ollamaWedged) {
      routerLog('[classifier] Ollama marked wedged by the watchdog — skipping both local models');
    } else {
      routerLog('[classifier] Ollama daemon unreachable — skipping both local models');
    }
  };

  // Cloud fallback: classify using pi's own model registry (completeSimple)
  // — pi already owns the model list, the auth (keys live in pi's auth
  // store, not router-config.json), and the provider HTTP quirks. The
  // router must NOT roll its own HTTP client + key resolution (the old
  // CloudClient path threw "No API key for provider" whenever the key
  // wasn't duplicated into router-config.json).
  //
  // Model selection: prefer the probe-verified cached list
  // (cache.classifier_fallback_models, populated at scan time by
  // probeAndCache — a quality probe with real classification cases, incl.
  // the HINT-narration trap, filters broken/misclassifying candidates). If
  // the probe hasn't run yet this scan cycle, fall back to
  // selectClassifierCandidates (price + gdpval tiered discovery) and the
  // try-each loop acts as a lazy probe. Only activate when allowCloudFallback
  // is true AND cfg/cache + the pi completeSimple/findModel hooks are
  // available.
  const tryCloud = async (): Promise<FullClassificationResult | null> => {
    if (!(allowCloudFallback && cfg && cache && completeSimple && findModel)) return null;
    try {
      // Prefer the probe-verified cached list (fast path — no probing at
      // classification time, the probe ran at scan time).
      let modelsToTry = getCachedFallbackModels(cache);
      let source = 'probed';
      if (modelsToTry.length === 0) {
        // Probe hasn't run or found nothing — lazy discovery as a fallback.
        // This also handles the first classification before the first scan
        // completes the probe.
        modelsToTry = selectClassifierCandidates(cfg, cache);
        source = 'discovered';
      }
      if (modelsToTry.length === 0) {
        // Last resort: the static free_models list from config.
        const discovery = new DiscoveryManager(cfg, cache);
        modelsToTry = discovery.getFreeModels();
        source = 'static-free';
      }
      // Pinned cloud classifier (dynamic group's classifier_cloud_model):
      // tried FIRST — before the probe-verified list — so a user-pinned
      // (e.g. subscription-covered) model classifies deterministically. The
      // findModel guard in the loop below skips it if pi doesn't know it.
      if (pinnedCloudModel) {
        // Tried FIRST — dedup instead of skip so a pinned ref that already
        // sits in the probe-verified list still moves to position 0 (code
        // review 2026-09-26, Minor #3).
        modelsToTry = [pinnedCloudModel, ...modelsToTry.filter((m) => m !== pinnedCloudModel)];
        source = `pinned+${source}`;
      }
      routerLog(`[classifier] Cloud fallback trying ${modelsToTry.length} model(s) (${source}): ${modelsToTry.join(', ')}`);
      // Distinguish "probe ran but all candidates failed" from "probe hasn't
      // run yet" so the empty-list case is diagnosable from logs (roborev
      // job 445 LOW).
      if (modelsToTry.length === 0 && source === 'discovered' && hasProbedFallback(cache)) {
        routerLog('[classifier] Cloud fallback: probe ran at scan time but all probed candidates failed — falling back through discovered/static-free tiers.');
      }

      const classifyCtx: any = {
        messages: [{ role: 'user', content: ollamaPrompt }],
      };

      for (const modelRef of modelsToTry) {
        try {
          const model = findModel(modelRef);
          if (!model) {
            routerLog(`[classifier] Cloud model ${modelRef} not in pi registry — skipping`);
            continue;
          }
          const result = await completeSimple(model, classifyCtx, undefined);
          if (result.errorMessage || result.stopReason === 'error') {
            routerLog(`[classifier] Cloud model ${modelRef} failed`, result.errorMessage ?? 'error');
            continue;
          }
          // AssistantMessage.content is an array of TextContent | ThinkingContent
          // | ToolCall. Concatenate the text blocks (skip <think> blocks).
          const raw = (result.content ?? [])
            .filter((b: any) => b.type === 'text' && typeof b.text === 'string')
            .map((b: any) => b.text)
            .join('');
          // Shared extraction helper (identical to the former inline
          // extraction; null means unparseable, which degrades exactly
          // like the old thrown SyntaxError — catch skips to next model).
          const extracted = extractClassificationJson(raw);
          if (!extracted) {
            throw new Error(`Invalid format from cloud model ${modelRef}`);
          }
          const parsed = extracted as FullClassificationResult;
          if (isValidFullClassification(parsed)) {
            // HINT replies need conversion + a spurious guard (code review
            // 2026-09-26, Important #1): the Ollama path converts raw hint:*
            // categories into processed hints, but this loop returned them
            // AS-IS — an invalid category that pollutes lastClassifiedCategory
            // (short-prompt momentum) and misroutes via the CATEGORY_TO_GROUP
            // miss. A hint:* reply is legitimate only when the CURRENT request
            // itself carries a HINT marker (start-position hints already
            // returned via detectHintDirectly before this loop); otherwise the
            // model copied HINT narration out of the context block (voxtral
            // incident 2026-09-26) and the candidate is skipped like any other
            // bad reply.
            if (isHintCategory((extracted as any).category)) {
              if (!containsHintMarker(prompt)) {
                throw new Error(
                  `Cloud model ${modelRef} echoed a spurious HINT (${(extracted as any).category}) — no HINT in the current request`
                );
              }
              const hint = toHintClassification(extracted);
              if (!hint) {
                throw new Error(`Cloud model ${modelRef} returned an unusable HINT: ${(extracted as any).category}`);
              }
              routerLog(`[classifier] Cloud model ${modelRef} succeeded (HINT conversion via pi completeSimple)`);
              return hint;
            }
            routerLog(`[classifier] Cloud model ${modelRef} succeeded (via pi completeSimple)`);
            // Apply escalation logic to cloud result
            if (context.lastModel && !context.isCompaction) {
              const escalated = applyEscalationLogic(parsed, context.lastModel);
              if (escalated) {
                return escalated;
              }
            }
            return parsed;
          }
        } catch (cloudError) {
          routerLog(`[classifier] Cloud model ${modelRef} failed`, (cloudError as Error).message);
        }
      }
    } catch (cloudFallbackError) {
      routerLog(`[classifier] Cloud fallback failed`, (cloudFallbackError as Error).message);
    }
    return null;
  };

  // Cloud-first (2026-09-27): the local Ollama daemon is a last resort, not
  // the default path — repeated MLX wedge incidents (2026-09-25/26) pinned
  // the GPU at 100% when it was hit on every turn. When allowCloudFallback
  // is enabled, try the cloud chain first; only fall through to Ollama if
  // every cloud candidate failed. When allowCloudFallback is disabled, the
  // behavior is unchanged (Ollama only, no cloud attempt).
  if (allowCloudFallback) {
    const cloudResult = await tryCloud();
    if (cloudResult) return cloudResult;
    await tryOllama();
  } else {
    await tryOllama();
  }

  // Escalation logic: if we have a classification and lastModel, check if we need to escalate
  if (classificationResult && context.lastModel && !context.isCompaction) {
    const result = applyEscalationLogic(classificationResult, context.lastModel);
    if (result) {
      return result;
    }
  }

  if (classificationResult) {
    // Cache the LLM classification result for repeated identical prompts
    // (only when there was no conversation context — see cache check above).
    if (!contextBlock) classifyCacheSet(prompt, classificationResult);
    return classificationResult;
  }
```

The `// Static fallback` comment and everything below it (unchanged) now
follows directly — `tryCloud()` already ran (if `allowCloudFallback` was
true) and returned nothing, so reaching this point means both chains (or
just Ollama, if cloud was disabled) failed.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/classifier-fallback-chain.test.ts`
Expected: PASS — all tests in the file, including the two touched above.

Run: `npx vitest run` (full suite)
Expected: all green — this is the highest-risk change in the plan (a
control-flow reorder inside a heavily-tested function), so a full run,
not just the touched file, is required before moving on.

Run: `npx tsc --noEmit`
Expected: no errors.

**Step 5: Commit**

```bash
git add src/content-classifier.ts test/classifier-fallback-chain.test.ts
git commit -m "fix: try the cloud classifier chain before touching Ollama

Previously classifyPrompt always tried the local Ollama primary +
fallback models FIRST, and only ran the (already-implemented,
already-enabled via classifier_cloud_fallback: true) cloud chain if
both Ollama attempts failed or the daemon was unavailable/wedged.
That meant nearly every classified turn loaded a local model, pinning
the GPU at 100% (owner report, 2026-09-27; repeated MLX wedge
incidents 2026-09-25/26 already made the daemon untrusted).

Reorders classifyPrompt so the cloud chain (extracted into tryCloud(),
otherwise byte-identical) runs first when allowCloudFallback is true;
the local Ollama chain (extracted into tryOllama(), otherwise
byte-identical) now only runs as a last resort if the entire cloud
chain returns nothing. Behavior is unchanged when allowCloudFallback
is false (Ollama-only path, no cloud attempt)."
```

---

## Task 4: Final verification and design-doc cross-link

**Step 1:** Run the full suite one more time after all three tasks landed:

```bash
npx tsc --noEmit && npx vitest run
```

Expected: same or higher pass count than the pre-plan baseline (1009 passed
| 3 skipped, 114 test files), no regressions, no lowered coverage
thresholds.

**Step 2:** Rebuild so the running dev bundle picks up the change:

```bash
npm run build
```

**Step 3:** Manually confirm with a fresh `/router scan` or a live prompt
that `ollama ps` stays empty for a normal chat/coding turn — this is the
actual acceptance criterion from the owner's report, not just green tests.

**Step 4:** Report back to Achim with the commit list and the `ollama ps`
observation. Do NOT propose a release/tag — this plan produces `fix:`
commits on `main`; releasing is a separate, explicit decision (AGENTS.md
§1).

---

## Notes carried over from the design doc

- `strict_local`/`local_first` modes are NOT removed from
  `sortByBillingPreference` — no call sites remain after Task 2, but
  deleting the modes is a separate, unforced refactor (YAGNI: leave working,
  tested code alone unless something requires touching it).
- The HINT-mechanism regression Achim reported (2026-09-27) is OUT OF SCOPE
  for this plan — tracked separately in memory
  (`todo.hints-broken.2026-09-27`).
