# Compaction Continuity Decides by Context Window Implementation Plan

**Status:** proposed (2026-11-07) — third fix of the "no migration" decision
(`2026-11-04-virtual-models-routing.md`); item I5 in `TODO.md`.

**Problem:** Compaction continuity trusts any model whose id does not look small.
`src/content-classifier.ts:788-800` decides "large enough for compaction" with a
regex: not `ollama/` or `lm-studio/`, and no `2b`-`14b` parameter token in the id.
A free tier or a meta-router (`…:free`, `openrouter/openrouter/free`) passes that
test, gets the compaction HINT, and is then asked to compact a context it cannot
hold. The `driveStream` context-window guard may skip it (wasted attempt) or the
request fails with an overflow error — during compaction, which is the one moment
the router must not lose the context.

**Solution:** Decide by the model's real context window, not by its name.

1. **Red-first.** New `test/compaction-continuity-window.test.ts`: a last model
   with a small real context window (and an id without a parameter token) must
   not receive the compaction HINT; a large-window model must. The test must fail
   against the regex.
2. **Window.** Use the registry value (`getModelContextWindow`, already available
   through the context utils) against the estimated compacted context plus the
   output reserve; unknown window counts as "not large enough".
3. **Free tier and meta-routers.** Exclude `:free` and meta-router refs from
   compaction continuity explicitly (derived from the registry/config, not a
   model list — AGENTS.md §9).
4. **Fallback unchanged.** When continuity is refused, the existing
   `code_complex` route for compaction stays.

**Open decisions (owner):**

1. **Threshold.** Window ≥ estimated tokens + output reserve + a safety margin,
   or a simpler fixed multiple of the estimate? Proposal: the reserve-aware form,
   since `driveStream` already computes it.
2. **Unknown window.** Treat as unusable (proposal) or as usable as today?

**Verified against:** `main` @ `daa9623` (2026-11-07). Checked: the `isCompaction`
branch and its `isSmallLocal` regex, the `code_complex` fallback, the
`lastModelLimited` cooldown flag, and the `TODO.md` I5 entry. **Not checked:**
which models in the current pool actually hit the wrong branch — a log query over
`compaction` decisions would quantify it.
