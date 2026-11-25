# Budget pacing counter: measurements, 2026-11-25

Measurements behind `docs/plans/2026-11-25-budget-pacing-counter.md`.
Window: 2026-11-01 to 2026-11-25. Budget under test: the owner's user layer,
`providers.mistral.budget = { amount: 300, unit: "usd", period: "month",
reset_day: 1 }`. Linear target on 2026-11-25: $243.

## Sources

Project names other than this repo are anonymized as project A–D — the
owner's other projects must not be named in this public repository
(`scripts/forbidden-patterns.ts`, AGENTS §8). Project A is the project
whose name this repo forked from working on the router itself.

- `classifier-decisions.jsonl`, `stage: "pool"` records: the candidate
  flags at decision time, grouped by the project name in `proc`.
- `<project>/.pi/cache/router-state.json` → `usage_log`: the counter that
  `pacedProviders()` reads.
- Pi session files under `~/.pi/agent/sessions/` (parent and subagent
  transcripts), `usage.cost.total` of every Mistral assistant message,
  deduplicated by response id: Pi's own per-component step cost.
- Prices: Pi 1.6.0 catalog `@earendil-works/pi-ai/dist/providers/data/mistral.json`
  (e.g. `mistral-large-4` input 0.7, output 2.1, cacheRead 0.07 $/M;
  `zai-glm-5-3` 1.4 / 4.4 / 0.14 $/M).

## 1. The `paced` flag depends on the project

Mistral candidates in `pool` records with the `paced` flag:

| Project | Days | Mistral candidates | `paced` |
|---|---|---|---|
| pi-model-router-fork | 11-19..11-25 | 7656 | 100 % |
| project A | 11-24..11-25 | 2141 | 0 % |
| project B | 11-24 | 1632 | 0 % |
| virtual-selection | 11-21 | 278 | 0 % |
| project C | 11-21, 11-24 | 127 | 0 % |
| project D | 11-20..11-24 | 118 | 0 % |

`pool` records exist from 2026-11-19. `router.log` shows `paced` for
pi-model-router-fork on every day from 2026-11-07.

## 2. What the counter adds up vs what Pi charged

| Project | usage_log tokens | Router estimate (all tokens × input price) | Per component from usage_log (rest as input .. as output) | Pi `usage.cost.total` |
|---|---|---|---|---|
| pi-model-router-fork | 1133M (93.8 % cacheRead) | $785 | $107 .. $192 | $117.45 (1193M tokens) |
| project A | 42M (89.5 % cacheRead) | $28 | $5 .. $12 | $21.35 (195M tokens) |
| project D | — | — | — | $14.50 |
| project C | — | — | — | $7.60 |
| others | — | — | — | $0.57 |
| **all projects** | | | | **$161.47** (1497M tokens) |

`usage_log` entries carry `tokens`, `cacheRead` and `cacheWrite`, but not
input and output separately (7748 of 8212 November Mistral entries in
pi-model-router-fork have the cache split; the rest predate it). The
middle column therefore prices the non-cache rest once at the input and
once at the output price. Pi's cost lands near the lower bound.

The project A log starts on 2026-11-24 and holds 42M tokens;
Pi's session files hold 195M Mistral tokens for that project in November,
most of them in subagent runs. The cause of the gap was not investigated.

## 3. Retention

Both writers trim `usage_log` to 30 days (`src/event-handlers.ts:596-598`,
`src/cache.ts:444-446`); a window from `reset_day: 1` in a 31-day month is
31 days long.
