# Thinking level per group: high/medium/low as part of the candidate score

**Status:** proposed — 2026-11-25.

**Verified against:** `main` @ `44eec66` (carries the proposed companion
plan `2026-11-24-gdpval-effort-variant.md`); Pi 1.6.0
(`node_modules/@earendil-works/pi-ai/dist/models.js:702-726`,
`core/virtual-models.d.ts:37-62`); measurements in
`docs/research/2026-11-25-thinking-level-per-group.md` (scan caches
`dist/.cache/scan-cache.json` 2026-11-24 and `.bak-20261122-main`;
`~/.pi/agent/sessions/**` per-level usage). What was NOT
checked: whether a thinking-level change mid-turn invalidates the Anthropic
prompt cache (assumed yes, see step 4), and why the 2026-11-24 scrape
lost the variant rows (open decision 5).

Builds on `2026-11-24-gdpval-effort-variant.md` (variant-aware lookup,
level threaded through gates and ranking). This plan is the next step: the
level stops being a pass-through and becomes a routing decision per group.

## Problem

Today the router passes `request.thinkingLevel` through unchanged
(`src/virtual-model.ts:104`; the owner runs `high` for every prompt, so
every routed step runs `high`). The score comparison ignores the level:
the bare AA slug is the Low variant, so candidates are compared at their
lowest effort no matter what level they will actually run at (details and
numbers in the effort-variant plan). Two consequences:

- **Quality is underestimated for high-level work.** Sonnet at `high`
  scores 1557, Opus at `medium` 1593, Haiku at `xhigh` 1522 — the ranking
  cannot express "cheaper model, more thinking".
- **Thinking cost is not a routing input.** A `simple` continuation pays
  the same thinking budget as an architecture review.

## Solution

A candidate is a **(model, level) pair**, and the level is chosen per
group, bounded by the user's level.

1. **Group config gains `thinking_level`.** `GroupConfig` gets
   `thinking_level?: 'off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'`
   (default: the user's level, i.e. today's behaviour). Suggested shipped
   values: `simple: low`, `standard: medium`, `code_complex: high`,
   `design`/`planning`: `high`. The user's selected level (shift+tab,
   `PI_REASONING_LEVEL`) is the **ceiling**: the effective level is
   `min(group level, user level)` in the Pi level order
   off < minimal < low < medium < high < xhigh < max.
2. **Effective level per candidate.** After the ceiling, clamp to what the
   model supports: Pi's `clampThinkingLevel(model, level)` rounds an
   unsupported level **up first** (`pi-ai/dist/models.js:714`), which would
   silently upgrade e.g. `xhigh` on mistral-large-4 to a higher price
   class than intended — so the router clamps with its own rule instead:
   highest supported level ≤ requested (never up). Unsupported levels are
   excluded from the candidate pair; `off` is always supported.
3. **Score lookup with the pair's level** — the variant-aware lookup from
   the companion plan (`lookupGdp(id, level)` → the `-<level>` row). The
   bare slug is **never** used as a pair's score: it is the model's
   low/default-fallback row, so comparing it with measured rows at the
   requested level would misrank. Unmeasured policy: a pair with no variant
   row at its effective level is flagged `unmeasured-level` and gets **no
   score** — it cannot pass a gdpval floor (level-aware quality gates
   require a measured row at the effective level), and in ranking it sorts
   below all measured pairs, ordered by cost among themselves. It stays
   eligible as a last-resort fallback when no measured candidate survives
   the gates, so models without variant rows are never dropped entirely.
4. **Level is fixed for the whole turn.** The level is decided on the
   `user` request and carried in `SelectionState` (new field
   `level?`, alongside `pin`/`runGroup`); `continuation`/`retry` requests
   keep it. Rationale: a level change mid-turn changes the provider's
   reasoning parameter, which is expected to invalidate the Anthropic
   prompt cache — not verified, so no mid-turn changes until measured.
5. **Candidate generation and ranking across levels.** For `best` groups
   the candidate set is not just (model, group level): every supported
   level ≤ the effective level yields a pair, so pairs like Opus-medium and
   Sonnet-high are generated and compared. Each pair is scored at its own
   level (step 3); `tiered` groups apply their gdpval floors to that
   level-aware score; the quality-equivalence window (ADR-0023) compares
   pairs across levels, so "Sonnet-high ≈ Opus-medium" resolves by
   cost/quota as today. Unmeasured pairs never enter this comparison (step
   3). `max_cost` and budget pacing see the pair's expected cost — step 7.
6. **Direct/group requests** (`router/<group>` selected directly) resolve
   the effective level exactly like routed turns: `min(group
   thinking_level, user level)` as the ceiling (step 1), then the router's
   own down-only clamp to a supported level (step 2). The user's ceiling is
   never exceeded, and Pi's up-rounding `clampThinkingLevel` is never the
   deciding clamp.
7. **Measure the level's cost before using it in ranking.** Extend the
   usage log entry with the level (Pi already stores `thinkingLevel` on
   every assistant message) and report per-level output tokens and step
   cost (`/router cost`); only then may the ranking prefer a lower level
   for cost. Today the data does not exist — existing sessions are
   effectively high-only (measurements:
   `docs/research/2026-11-25-thinking-level-per-group.md` §1).

### Tests (red first, AGENTS §4)

- Effective level = min(group, user) across the full level order; user
  ceiling never exceeded.
- Own clamp rule: requested `xhigh` on a model whose map is
  low/medium/high → `high`, never up (red today: Pi's clamp would pick a
  higher level).
- Pair generation and ranking: a `best` group with floor 1500 generates
  pairs at every supported level ≤ the effective level; with the
  2026-11-22 scrape rows (see the research note §2), sonnet-`high` (1557)
  passes the floor and outranks opus-`low` (1240, below the floor) — red
  today: the bare-slug lookup ranks opus first at the builtin score.
- Unmeasured policy: a pair without a variant row at its effective level
  gets no score, cannot pass a gdpval floor, and ranks below all measured
  pairs (ordered by cost); it is still selectable as a last-resort
  fallback. The bare slug is never used as the pair's score.
- Turn stickiness: a `user` request fixes `state.level`; a following
  `continuation` request with a different `request.thinkingLevel` keeps
  the stored one; a new user turn re-decides.
- Config: shipped group levels parse; unknown level rejected fail-open
  with a warning (never drops the group).

## Open decisions

1. **User level as ceiling vs. fixed override vs. ignored** (recommendation:
   ceiling). yeliu84 applies the Pi level as an all-tier override — the
   opposite default.
2. **Shipped per-group levels** — the table in step 1 is a proposal; the
   owner sets the values (user layer can override per group).
3. **Timing:** after 2.0.0 together with the effort-variant plan (both
   change the ranking; the variant lookup must land first or the pair
   scores fall back to bare slugs). Owner decides.
4. **Mid-turn level change:** measure the cache effect first (step 4/7);
   until then the level never changes within a turn.
5. **Scrape prerequisite:** the 2026-11-24 scan lost the AA variant rows
   (cache key counts in
   `docs/research/2026-11-25-thinking-level-per-group.md` §2). Step 1 of
   the effort-variant plan cannot work without them; find out whether AA
   stopped publishing them or the scraper lost them (provenance still says
   "Default Fallback") and fix before this plan's step 3.
