# Measurements for the per-group thinking-level plan

Measurements behind
`docs/plans/2026-11-25-thinking-level-per-group.md` (moved here from the
plan per AGENTS §11 — a plan is not a lab notebook). Collected 2026-11-25
against `main` @ `44eec66`.

## Per-level usage in existing sessions

All assistant messages in `~/.pi/agent/sessions/**` (every project, every
level ever used), grouped by model and `thinkingLevel`:

- `mistral/mistral-large-4`: `high` 6280 messages, `off` 1966, `low` 173.
- Every other model: effectively `high` only.

Conclusion: there is no per-level cost factor to learn from yet — sessions
are high-only, so the plan's step 7 (measure per-level cost in the usage
log before ranking may prefer lower levels) has no existing data.

## Variant rows in the scan caches

- `dist/.cache/scan-cache.json` (2026-11-22 backup `.bak-20261122-main`):
  454 gdpval keys, including all four AA variant rows per level for
  opus/sonnet/haiku (e.g. opus low 1240 / medium 1593 / high 1714 /
  xhigh 1835, sonnet high 1557).
- `dist/.cache/scan-cache.json` (2026-11-24): 333 keys, only 7
  variant-suffixed keys — the AA variant rows were lost. Provenance of the
  remaining rows still says "Default Fallback".

Conclusion: whether AA stopped publishing the variant rows or the scraper
lost them is unresolved (open decision 5 of the plan); the loss is a
prerequisite to fix before level-aware scoring can work.
