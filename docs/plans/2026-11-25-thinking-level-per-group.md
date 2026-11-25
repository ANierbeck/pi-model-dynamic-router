# Thinking level per group: high/medium/low as part of the candidate score

**Status:** proposed — 2026-11-25.

**Verified against:** `docs/host-upgrade-shape-spike` @ `f9a5dfe` (carries
the proposed companion plan `2026-11-24-gdpval-effort-variant.md`); Pi 1.6.0
(`node_modules/@earendil-works/pi-ai/dist/models.js:702-726`,
`core/virtual-models.d.ts:37-62`); the scan caches
`dist/.cache/scan-cache.json` (2026-11-24) and `.bak-20261122-main`;
`~/.pi/agent/sessions/**` (all thinking levels ever used). What was NOT
checked: whether a thinking-level change mid-turn invalidates the Anthropic
prompt cache (assumed yes, see step 4), and why the 2026-11-24 scrape
lost the variant rows.

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
   the companion plan (`lookupGdp(id, level)` → `-high` row, fallback bare
   slug). No variant row for that level → bare slug AND the pair is flagged
   `unmeasured-level`: such a candidate is ranked at the group's level
   requirement, not optimized down (models without variant rows must not
   win "cheapest thinking" by default).
4. **Level is fixed for the whole turn.** The level is decided on the
   `user` request and carried in `SelectionState` (new field
   `level?`, alongside `pin`/`runGroup`); `continuation`/`retry` requests
   keep it. Rationale: a level change mid-turn changes the provider's
   reasoning parameter, which is expected to invalidate the Anthropic
   prompt cache — not verified, so no mid-turn changes until measured.
5. **The pair is ranked like any candidate.** `best` groups score by the
   `score_by` column at the pair's level; `tiered` groups apply their
   gdpval floors to the level-aware score; the quality-equivalence window
   (ADR-0023) compares pairs, so "Sonnet-high ≈ Opus-medium" resolves by
   cost/quota as today. `max_cost` and budget pacing see the pair's
   expected cost — step 7.
6. **Direct/group requests** (`router/<group>` selected directly) use the
   group's `thinking_level` as the requested level and let Pi clamp.
7. **Measure the level's cost before using it in ranking.** Extend the
   usage log entry with the level (Pi already stores `thinkingLevel` on
   every assistant message) and report per-level output tokens and step
   cost (`/router cost`); only then may the ranking prefer a lower level
   for cost. Today the data does not exist: of all assistant messages in
   `~/.pi/agent/sessions`, mistral-large-4 ran `low` 173 times, `off`
   1966 times and `high` 6280 times — everything else is `high`, so there is
   no per-level cost factor to learn from yet.

### Tests (red first, AGENTS §4)

- Effective level = min(group, user) across the full level order; user
  ceiling never exceeded.
- Own clamp rule: requested `xhigh` on a model whose map is
  low/medium/high → `high`, never up (red today: Pi's clamp would pick a
  higher level).
- Pair ranking: with the 2026-11-22 scrape rows (opus low 1240 / medium
  1593 / high 1714 / xhigh 1835, sonnet high 1557), a `best` group with
  floor 1500 ranks sonnet-`high` above opus-`low` (red today: bare-slug
  lookup ranks opus first at 1900/builtin).
- `unmeasured-level` pairs keep the group level requirement (no downgrade
  without data).
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
   (454 keys with all four Opus/Sonnet levels on 11-22 → 333 keys, bare
   slugs only). Step 1 of the effort-variant plan cannot work without
   them; find out whether AA stopped publishing them or the scraper lost
   them (provenance still says "Default Fallback") and fix before this
   plan's step 3.
