# Plan: Multi-benchmark capability sourcing from Artificial Analysis (Round 2 — deferred)

> Registered 2026-10-04 (owner decision: register now, implement in a
> dedicated round with TDD). Extends ADR-0023's tier routing.

## Problem

`calculateScore(ref, taskType)` — the scoring hook behind the `best` group
method — **ignores its `taskType` parameter** and returns the plain GDPval.
Every group therefore ranks on a single "general real-world work" number,
although different task types are measured by different benchmarks. The
2026-10-04 tier collapse (opus/sonnet/glm within 18%, one number for
everything) was the symptom; the planning-group floor is a static patch for
one task type.

## What Artificial Analysis publicly offers (research 2026-10-04)

The GDPval-AA scrape we run today (`gdpval_url`) is **one of ten** public
evaluation columns per model. Same site, same page structure, no API key
needed (the Data API's per-benchmark fields are Pro-tier; the website tables
are public — we already scrape them):

| Column | Measures | Router use |
|---|---|---|
| GDPval-AA v2.1 (Elo, anchored at 1600) | real-world work across 44 occupations | today's global score (keep) |
| AA-Briefcase v1.1 Elo | **agentic knowledge work** — analytical quality, presentation | `planning`/`design` groups |
| Terminal-Bench 4.0 | agentic coding & terminal use | `tactical`/code-heavy groups |
| SciCode | coding | code groups |
| AutomationBench-AA | agentic SaaS workflows | tool-use-heavy paths |
| GDP.pdf | professional document reasoning | `bulk_reader` |
| Capability indexes (Finance, Strategy & Ops, Legal, Healthcare, Engineering, Economics) | per-industry | future domain groups |

## Design sketch

1. **Scrape** (scan-runner, in addition to the existing gdpval scrape):
   GDPval-AA + AA-Briefcase Elo + Terminal-Bench + SciCode — four columns,
   each with the existing scrape's robustness requirements (offline
   tolerance, TTL, partial-failure handling).
2. **Cache** — extend `cache.gdpval_scores` semantics or add
   `cache.capability_profiles: Record<slug, { gdpval, briefcase, coding }>`;
   unknown/missing columns are `null`, never 0.
3. **Scoring** — `calculateScore(ref, taskType)` finally uses `taskType`:
   - `planning`/`design` groups → briefcase Elo (fallback: gdpval)
   - code-heavy groups → terminal-bench/scicode blend (fallback: gdpval)
   - everything else / missing column → gdpval (today's behavior)
4. **Group floors** (`min_gdpval`, tactical's cap, planning's 1700) stay on
   the global GDPval — they are quality gates, not task-type rankings; the
   per-task columns only affect the ordering WITHIN a group's pool.

## Open questions for the implementation round

- Column availability for local Ollama models (AA does not score them) —
  gdpval heuristic fallback must extend to the new columns.
- Scrape stability: AA re-designs pages occasionally; the gdpval scraper's
  parse brittleness will multiply by four. Consider a single multi-column
  parse of one page instead of four scrapes.
- Whether `best_quality_window` should apply per task-type column (probably
  yes, unchanged semantics).

## Non-goals

- No AA Pro/Data-API integration (paid; the website scrape suffices).
- No new groups purely for the sake of the columns — only where the owner
  asks for task-type separation.
