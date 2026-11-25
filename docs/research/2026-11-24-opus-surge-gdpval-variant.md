# Opus surge since 2026-11-20: effort-variant GDPval + the stale builtin

**Date:** 2026-11-24. **Plans:**
`docs/plans/2026-11-24-gdpval-effort-variant.md`,
`docs/plans/2026-11-24-relative-group-thresholds.md`.
**Method:** token usage summed from the assistant messages of all Pi
session files (`~/.pi/agent/sessions/*/`); candidate pools and GDPval
changes from `~/.pi/logs/classifier-decisions.jsonl*` and
`~/.pi/logs/router.log`; scores from `dist/.cache/scan-cache.json`
(2026-11-24) and `.bak-20261122-main`.

## Token share of Opus per day (all projects, input+cacheRead+cacheWrite+output)

| day | Opus share | total |
|---|---|---|
| 2026-11-14 .. 11-19 | 0–16 % | 15–170 M/day |
| 2026-11-20 | 68 % | 42.3 M |
| 2026-11-21 | 34 % | 282.1 M |
| 2026-11-22 | 45 % | 45.4 M |
| 2026-11-24 | 51 % | 60.1 M |

Since 2026-11-20: 177 M Opus tokens. 89 % from two long sessions in this
repository with ~160–170k median context per step (the 2026-10-06 session
54 %, the current 2026-11-21 session 35 %).

## `code_complex` candidate pool over time (router log, method=best)

| date | top candidates |
|---|---|
| 11-12 | sonnet-5-5 > opus-5-5 > haiku-5-5 > glm-5-3 > deepseek > glm-flash |
| 11-14/15 | opus-5-5 > deepseek > glm-flash (haiku already out) |
| 11-16 .. 11-20 | deepseek / glm-flash / opus alternating (opus in when unhealthy-marked) |
| 11-21 .. | opus-5-5 > glm-flash only |
| 11-24 09:43+ | opus-5-5 alone (glm-flash globally excluded) |
| 11-24 18:59+ | empty (user-layer Opus exclude); turns fall through to planning, opus leads there |

## GDPval changes at the 2026-11-14 22:29 / 2026-11-21 21:35 re-scrapes

| slug | before | after | new displayName |
|---|---|---|---|
| claude-sonnet-5-5 | 1838 | 1182 | Sonnet 5.5 (Low, Default Fallback) |
| claude-haiku-5-5 | 1631 | 1130 | Haiku 5.5 (Low) |
| mistral/zai-glm-5-3 | 1657 | 1332 | (non-reasoning row) |
| mistral/deepseek-v4-1-flash-1017 | 1746 | 1317 | DeepSeek V4.1 Flash 1017 (Non-reasoning) |
| claude-opus-5-5 | 1900 | 1900 | unchanged — `gdpval_builtin` override wins |

The bare AA slug is the "Default Fallback" variant (provenance display
name), i.e. usually Low. Measured Opus 5.5 variants in the cache:
low 1240, medium 1593, high 1714, xhigh 1835. The shipped
`gdpval_builtin["claude-opus-5-5"] = 1900` (set 2026-09-27, before any
scraped row) overrides all of them.

## Category mix before/after the virtual-model migration (2026-11-22)

No migration effect visible: classifier categories per day are similar
before and after (code_complex 12–72, continue 7–66, standard 3–24).
The Opus shift starts 2026-11-20, eight days before the migration, and
tracks the score changes above. `continue` turns keep the run group, so
one Opus turn pins a session — this existed before the migration too.

## Score-row shape of the cache

2026-11-18 scan: 454 gdpval keys, 80 with an effort-variant suffix
(`-high/-xhigh/-low/-medium`); 2026-11-21 scan: 333 keys, only 2 variant
suffixes — AA trimmed the variant rows in between, so variant-first
lookup MUST fall back to the bare slug.
