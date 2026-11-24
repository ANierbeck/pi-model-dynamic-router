# Scraped GDPval: the effort variant follows Pi's thinking level; drop the stale opus-5-5 builtin

**Status:** proposed — 2026-11-24.

**Verified against:** `main` @ `d29f01c`; `dist/.cache/scan-cache.json`
(2026-11-24) and its `.bak-20261122-main`; `~/.pi/logs/router.log`;
`~/.pi/logs/classifier-decisions.jsonl*`; Pi 1.6.0
(`docs/extensions.md` §`ctx.thinkingLevel`,
`pi.getThinkingLevel()`); `src/scan-runner.ts:83` (`extractGdpvalScores`),
`src/metrics.ts:121/319/405/547/561` (set/lookup pipeline);
`test/consolidated-config-pins.test.ts:142` (the builtin pin).

## Problem

Two facts, measured on the live data, break the ranking:

1. **The bare AA slug is the "Default Fallback" variant — usually Low.**
   Artificial Analysis scores each effort variant separately
   (`claude-opus-5-5-low/-medium/-high/-xhigh`, scraped into
   `cache.gdpval_scores`). The bare slug `claude-opus-5-5` is AA's own
   "(Low, Default Fallback)" row — the cache's `gdpval_provenance` shows
   exactly that display name for the bare key. So every model whose id has
   no explicit variant suffix is scored at its **lowest** effort, whatever
   Pi's thinking level actually is (this session runs `high`,
   `PI_REASONING_LEVEL=high`). Measured 2026-11-14..21: sonnet-5-5 fell
   1838 → 1182, haiku-5-5 1631 → 1130, glm-5-3 1657 → 1332,
   deepseek-1017 1746 → 1317, all to their Low/Non-reasoning rows.
2. **`gdpval_builtin["claude-opus-5-5"] = 1900` overrides the scrape and
   exceeds every measured Opus variant** (max xhigh = 1835; the 1900 date
   from 2026-09-27, before any scraped row existed). Builtin wins in
   `setConfig`/`setCache` (`Object.assign(gdpval, cfg.gdpval_builtin)`).

Net effect, measured in
`docs/research/2026-11-24-opus-surge-gdpval-variant.md`: since
2026-11-21 `code_complex` (min_gdpval 1630, max_gdpval 1700) contains only
`claude-opus-5-5` (2026-11-24: none at all after the user-layer Opus
exclude, so turns fall through to `planning`, where Opus also leads), and
Opus carries 45–68 % of daily tokens since 2026-11-20 (177 M tokens;
`continue` turns keep the run group, so one Opus turn pins a session).

## Solution

1. **Variant-aware score lookup.** `lookupGdp(id, level?)` and
   `lookupCapability(ref, column, level?)` first try the AA variant slug
   for the current thinking level, then fall back to the bare slug:
   - Pi level → AA suffix: `off`/`minimal`/`low` → `-low`, `medium` →
     `-medium`, `high` → `-high`, `xhigh`/`max` → `-xhigh`.
   - No variant row → bare slug (today's behaviour), so older models are
     unaffected.
   - Capability profiles get the same mapping (they carry `-high`/`-xhigh`
     keys for some models; missing → bare key).
2. **Thread the level through every score use, not just the gates.**
   `route()` already receives `request.thinkingLevel`
   (`src/virtual-model.ts:104`). The level travels with the request into
   group resolution, the gates (`applyGroupFilters`) **and the ranking**
   (`getM`, `sortBy`, `sortBest`, `rankByScore`) as a parameter — with only
   the gates level-aware, candidates that pass would still be ordered by
   bare-slug scores. A module-global "current level" would race between a
   parent turn and its sub-calls, so no global state. Where a lookup
   happens without a request (scan-time snapshot generation), use the bare
   slug as today.
3. **Remove `"claude-opus-5-5": 1900` from the shipped
   `router-config.json` `gdpval_builtin`.** With variant-aware lookup the
   scrape is the source of truth; the entry was a pre-scrape placeholder
   and now actively distorts. All other builtin entries stay (they cover
   slugs AA never publishes, e.g. `mistral-medium-3-5`, and models without
   variant rows). **No `SCRAPE_VERSION` bump**: the scraped values did not
   change, only their interpretation.
4. **Fix the pin.** `test/consolidated-config-pins.test.ts:142` asserts the
   builtin entry exists and beats `claude-sonnet-5` (1603). Rewrite
   red-first: the shipped config must NOT pin a score above every scraped
   variant of that model; assert instead that a scraped variant row
   exists for the bare slug (or the fallback rule applies).

## Open decisions

1. **Mapping details:** is `max` → `-xhigh` right, or should AA get a
   `-max` row eventually (fallback covers it)? Is `off` → `-low`
   acceptable, or should `off` use the bare/default row? (Recommendation:
   `off`/`minimal`/`low` → `-low`, bare slug as fallback everywhere.)
2. **Where the level comes from for non-virtual requests** (direct group
   requests): same `request.thinkingLevel`, or `pi.getThinkingLevel()`
   at route time? (Recommendation: request field, fallback
   `pi.getThinkingLevel()`.)
3. **User-layer overrides:** `gdpval_builtin` in `router-config.user.json`
   (user layer, allowed to name models) must win over BOTH the bare slug
   and the variant row — precedence order: user builtin key (bare or
   variant) → scraped variant slug → scraped bare slug. Document this as
   the escape hatch if a scraped variant looks wrong; a bare user key
   applies to every variant of that model.
4. **Timing:** in 2.0.0 or after? The change alters the ranking for every
   install, so it belongs in the 2.0.0 breaking-change batch; the owner
   decides.

## Steps

- [ ] Level→suffix map + variant-first lookup in `metrics.ts`, with tests
      (red-first: bare-slug-only lookup must differ from `-high` lookup
      when both rows exist).
- [ ] Thread `thinkingLevel` request → gates AND ranking lookups
      (`getM`/`sortBy`/`sortBest`/`rankByScore`); concurrency test with
      different levels in parent and sub-call.
- [ ] Remove the shipped builtin entry; rewrite the config pin red-first.
- [ ] Capability-profile variant mapping + tests.
- [ ] Docs (`docs/config-reference.md`, CHANGELOG), AGENTS §4 count.
- [ ] Companion plan `2026-11-24-relative-group-thresholds.md` converts
      the absolute group floors, which only make sense once scores are
      comparable again.
