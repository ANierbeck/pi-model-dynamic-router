# Design: `-latest` Aliases and Dated Snapshots — Newest-Version Slug Matching

**Date:** 2026-09-20
**Status:** Approved (user decision: dated snapshots resolve as aliases, not hard-excluded)
**Context:** Mistral's catalog exposes rolling aliases (`mistral-medium-latest`,
`devstral-medium-latest`) and dated snapshots (`mistral-medium-2604`,
`devstral-small-2505`, user-observed `mistral-medium-0426`). Other providers
don't do this. The router's GDPval slug matcher treated both forms
incorrectly.

## Problem (verified against the live registry and gdpval_builtin)

1. **`-latest` with multi-version families picks an ARBITRARY version.**
   `matchSlug` accepts any version when the ref has no version numbers
   (intended for `-latest`), but the tie-break among equal-score slugs is
   "first iterated, then most letter-tokens" — not "newest".
   `mistral-small-latest` matched `mistral-small-3-1` (421) instead of
   `mistral-small-3-2` (478) purely by object iteration order.
2. **Dated snapshots fail the version check.** `mistral-medium-2604` has
   numbers [2604]; Rule 2 compares major 2604 vs slug major 3 → no match →
   GDPval null → dropped from all quality groups, no dedup identity, noise
   in min_gdpval-0 groups.
3. **The persist path dedups by token signature only.**
   `collectGroupModels` uses `baseTokens` signatures, so `mistral-medium-3.5`
   and `mistral-medium-latest` (and `-2604` after fix 2) survive as separate
   entries in generated group lists. The live path (`coalesceBySlug`) already
   dedups by matched slug.

## Design (generic — no provider hardcoding, Leitplanke 1)

### 1. Date-token detection in `src/slug-matcher.ts`

A trailing number token that is exactly 4 digits in STRING form
(`^\d{4}$`) is a date snapshot marker (YYMM `2505`/`2604`/`2411`, MMDD
`0426`/`0528`), not a semantic version. It is excluded from the major-version
check (Rule 2) → the ref matches version-lessly, exactly like `-latest`.

No false positives: `claude-3-5-sonnet-20241022` (8 digits),
`gemma-2-9b`, `mixtral-8x22b`, `glm-4-6` (2–3 digit semantic versions) are
untouched. Applies to `matchSlug` AND `candidateSlugs` (LLM pre-filter).

### 2. Newest-version tie-break in `src/slug-matcher.ts`

Among equal-score candidates, the slug with the HIGHEST version tuple
(all numbers, compared element-wise; a shorter prefix counts as lower)
wins, then token count. This applies to ALL version-less refs (both
`-latest` and date-marked) and also fixes same-major ambiguity
(`glm-4-6` (520) no longer loses ties to `glm-4` (400)).

Result: `mistral-medium-latest` → `mistral-medium-3-5` (933),
`mistral-small-latest` → `mistral-small-3-2` (478),
`zai-glm-latest` → `zai-glm-5-3`, `mistral-medium-2604` → `mistral-medium-3-5`.

Known imprecision (accepted by user): an OLD snapshot
(`mistral-medium-2505`) gets the NEWEST version's score. Practically
harmless: the canonical version is preferred as representative whenever it
is in the pool, so snapshots essentially never represent their slug.

### 3. Dedup parity + canonical preference

- **Live path** (`src/routing.ts` representative selection): preference
  order per slug cluster becomes (1) not rate-limited, (2) canonical —
  the ref whose normalized id equals its matched slug (e.g.
  `mistral-medium-3.5`, not the `-latest` alias or the dated snapshot),
  (3) first by rank.
- **Persist path** (`src/dynamic-config.ts` `collectGroupModels`): dedup key
  becomes `getMatchedSlug(ref) ?? tokenSignature(ref)` so alias, snapshot,
  and canonical form of the same model collapse to ONE entry; canonical
  refs replace alias forms within the same slug key.

## What does NOT change

- **Hint resolution** (`HINT: mistral-medium-latest`): resolves against real
  registry ids and streams fine as-is.
- **Cost lookup**: per registry id — registry entries for aliases and
  snapshots carry their own real costs.
- **`codestral-latest`**: exists as an exact gdpval_builtin slug (520) —
  Stage 3 exact match still wins first.
- **Exclusion rules** (`shouldExclude`): untouched; date detection only
  affects version comparison, not the special-model filter.

## Testing (TDD, failing tests first)

`test/slug-matcher-latest-dates.test.ts`:
1. multi-version `-latest` picks newest (`mistral-small-latest` → 3-2)
2. dated snapshot YYMM matches newest (`mistral-medium-2604` → 3-5)
3. dated snapshot MMDD matches newest (`mistral-medium-0426` → 3-5)
4. `zai-glm-latest` → `zai-glm-5-3`
5. regressions: exact matches still win (`mistral-small-3-1`, `glm-4-6`);
   unversioned families unchanged (`devstral-small-2505` → `devstral`);
   8-digit dates unchanged (`claude-3-5-sonnet-20241022` major check)
6. `candidateSlugs` orders newest first for version-less refs
7. dedup: live-path representative prefers canonical; persist-path
   `collectGroupModels` collapses alias/snapshot/canonical to one canonical
   entry
