# HINT pins as a category signal (research, 2026-10-22)

Status: research note, not a decision. No code changed. Prompt texts are
deliberately not reproduced here (they come from private session logs).

## Question

Owner's observation: a `HINT:` model pin carries a task category. Opus pin =
planning/architecture, Sonnet pin = code_complex, Haiku pin = code_standard or
simple. Is that true in the logs, and what would it change in the router?

## Method

- Source: local Pi session files under `~/.pi/agent/sessions/`, user messages
  whose first token is `HINT` / `MHINT` / `MODEL-HINT`, optionally followed by
  a verb (`use`, `nutze`, `verwende`, `benutze`) and a model or group name.
- Deduplicated by SHA-256 of the body (retries and repeats collapse). Result:
  96 unique pinned prompts. An earlier count of 38 used a stricter pattern and
  missed pins where the model name sits on the second line.
- Each body was assigned one taxonomy category by hand, from its content, using
  the v2-r3 definitions in `src/classification-prompt.ts`. This is an
  assistant judgment, not verified by the owner per item.
- Pin family derived from the target string. Two targets are not model pins:
  `strategic` and `group` (group pins), and one unparseable target.

## Result

| Category | Count |
|---|---|
| code_complex | 67 |
| planning | 11 |
| continue | 9 |
| design | 5 |
| simple | 2 |
| standard | 2 |

| Pin family | n | Categories |
|---|---|---|
| Sonnet (incl. typos) | 33 | code_complex 23, continue 4, planning 4, design 1, standard 1 |
| Opus | 12 | code_complex 7, planning 5 |
| Haiku (incl. typo) | 4 | code_complex 3, simple 1 |
| Mistral | 32 | code_complex 26, design 3, planning 2, standard 1 |
| GLM / zai | 11 | code_complex 6, continue 4, design 1 |
| group / unparsed | 4 | code_complex 2, simple 1, continue 1 |

Caveats:
- The sample is almost entirely debugging of the router itself (router output
  checks, fallback failures, review findings). Other kinds of work are missing.
- `design` (5) and `simple` (2) are too rare to calibrate on.
- The Haiku sample is too small to support a rule.

## Findings

1. **Sonnet pin ≈ code_complex** holds in about 70 % of cases.
2. **Opus pin ≠ planning.** Plan reviews ("verify the plan") and router output
   checks make up most of the Opus pins. The taxonomy classifies a plan check
   as code_complex, so the owner must decide whether that is the intended label.
3. **Continuation pins form their own class.** Short "please carry on" /
   "start over please" requests (paraphrased; owner prompt texts removed
   before commit) pinned to a model mean "keep this model", not a
   category. The continuation pins sit in the continue category (9 total).
4. **Mistral pins are mostly code_complex (26 of 32).** They were used as the
   workaround when the Claude path failed, so the category comes from the
   task, not from the model.
5. **Routing is not affected by the category of a pinned turn** (the pin
   decides the model), but the category feeds the next turn's inheritance and
   the calibration labels.

## Continuation gap in the code (read, not reproduced)

- `inheritPreviousCategory` (`src/content-classifier.ts:589`) already lets an
  unpinned `continue` inherit the previous category.
- The memory is updated only when the classifier returns a category
  (`src/stream-orchestrator.ts:418-419`). A pinned turn returns none, so
  `lastClassifiedCategory` keeps the value from before the pin.
- Example: planning turn → Sonnet-pinned "Tippfehler beheben" (code_simple,
  by content) → unpinned "danke, weiter" inherits planning, not code_simple.

Not yet reproduced in a live session.

## Options (not decided)

- **A. Pinned turns still classify their content** (keep the pin for the model)
  and write the category to the memory. Smallest change, fixes the gap above.
  Needs a red-first test (AGENTS.md §4).
- **B. Use pins as owner labels** only, in the decision log, separate from model
  predictions (`owner_label`). Gives calibration data, no routing change.
- **Not proposed:** a routing rule "Opus pin = planning". The data above does
  not support it.

## Open questions for the owner

- Is a plan check code_complex or planning?
- Should a continuation pin keep the category of the previous task (option A)?
- Labels for `design` and `simple` are still missing; more pins will not supply
  them, since the owner pins mainly for debugging.
