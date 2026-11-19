# 0036 — Laya has no confidence gate by default

## Status

Accepted (2026-11-19, owner decision). Answers the open question of ADR 0035
("Open: the default confidence gate") and implements decision 1 of the plan
`docs/plans/2026-10-25-laya-sole-classifier.md` ("no confidence gate"). ADR
0035 is not edited.

## Context

ADR 0035 made an installed Laya the leading classifier. The stage still had a
default `integrations.laya.confidence_threshold` of 0.8: an answer below it
was vetoed and the prompt went on to the chain of ADR 0032, local Ollama first
and the cloud chain when no local model answers.

Laya's confidence is uncalibrated (ECE 0.466 in the spike), so 0.8 was not a
measured quality bar. It was a filter that let only part of Laya's answers
decide. For a user without a local model, the rest went to the cloud. More
than half of all prompts could take that path, which defeats the reason for a
local classifier: the prompt text stays on the machine.

## Decision

1. **The default gate is 0.** `confidence_threshold` defaults to `0` in code
   (`LAYA_DEFAULT_CONFIDENCE_THRESHOLD` in `src/laya-classifier.ts`), for every
   user. Every Laya answer with a valid category decides in active mode.
2. **One constant, every reader.** The config loader's default, the stage's
   veto (`vetAnswer`), the fallback for an invalid value and `/router status`
   all read the same constant. Before, each named 0.8 itself.
3. **The other vetoes stay.** An answer outside the production taxonomy, a NaN
   confidence, a timeout, an unavailable sidecar: the chain still decides that
   prompt (ADR 0035, decision 3).
4. **A user value is kept.** A block that sets `confidence_threshold` keeps
   it. A user who wants a gate sets one between 0 and 1.
5. **An invalid value falls back to 0**, the default, with the warning it had
   before.

## Consequences

- With Laya installed and active, the chain runs only when Laya fails or
  answers outside the taxonomy. The cloud chain sees a prompt only when, in
  addition, no local model answers.
- Users who installed Laya earlier and never set the key lose the 0.8 gate on
  the next start. Their routes now follow Laya's low-confidence answers too.
  The CHANGELOG names this.
- In shadow mode nothing changes for routing. The decision log records every
  answer as "would have decided" instead of only those above 0.8.
- The confidence is still logged with every answer (decision log `laya`
  record), so a later calibration can set a measured gate if one is needed.
