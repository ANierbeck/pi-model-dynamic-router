# HINT pins vs. the classifier's group (taxonomy reference, 2026-11-14)

Status: research note, not a decision. No code changed. Counts only; prompt
texts stay in the owner's private session logs and in `~/.laya-ft/taxonomy-replay/`
(mode 600).

## Question

Does the model a user pinned with `HINT:` belong to the group the classifier
puts the prompt's category into? Follow-up to `2026-10-22-hint-category-signal.md`
(option B: pins as a check signal, not as labels).

## Method

1. **Unique pinned prompts:** 126 (SHA-256 of the full user text, same key in
   every step). Source: local Pi session files.
2. **Reference category:** the taxonomy classifier, run offline on the router's
   own classifier prompt (`buildClassificationPrompt` over `stripHintHead`
   output, so the pin does not reach the model). Model: `z-ai/glm-5.3` via
   OpenRouter, temperature 0, no conversation context. Cost: 0.027 USD.
3. **Group:** `CATEGORY_TO_GROUP` (default mapping; the owner's config has no
   `category_groups` override).
4. **Pinned model:** the target token after `HINT`, normalized to
   (family, version).
5. **Membership:** the union of candidate refs in the pool records
   (`stage: pool`) per group, window 2026-10-28 .. 2026-11-14.

## Result

### Reference categories (126 prompts, no context)

| Pin family | n | code_complex | planning | design | continue | standard | simple / code_simple | not valid (`hint:`) |
|---|---|---|---|---|---|---|---|---|
| Sonnet | 35 | 21 | 7 | 1 | 4 | 1 | 0 | 1 |
| GLM | 13 | 7 | 0 | 0 | 5 | 0 | 0 | 1 |
| Haiku | 7 | 2 | 0 | 0 | 0 | 3 | 1 (simple) + 1 (code_simple) | 0 |
| Mistral | 43 | 26 | 1 | 4 | 5 | 4 | 1 (simple) + 1 (code_simple) | 1 |
| Opus | 17 | 11 | 4 | 0 | 0 | 0 | 1 (code_simple) | 1 |
| Other / group pins | 11 | 7 | 0 | 2 | 0 | 1 | 1 | 0 |

The `hint:` results are the classifier echoing the pin instead of classifying
the content. They are excluded, not counted as disagreement.

### The join is only usable for 13 of 126 pins

The pool logs start 2026-10-28; the decision logs start 2026-10-09. Group
membership for the other 113 pins (pinned before 2026-10-28) is not in any log
and cannot be reconstructed from the current scan. These pins are reported as
"no pool data", not as disagreement.

Within the window (13 pins with a usable pin and category):

| Class | Meaning | n | Examples |
|---|---|---|---|
| A | pinned model is a member of the classifier's group | 3 | opus-5-5 on code_complex; mistral-large-4 on standard (2) |
| B | pinned model is in the pool, but not in that group | 6 | mistral-large-4 on code_complex (4) and design (1); haiku-5-5 on simple (1) |
| C | pinned model is not in the pool at all | 4 | claude-fable-5-1 on code_complex (2) and design (2) |

Pool membership over the window for the pinned families: mistral-large-4 is in
the `standard` and `bulk_reader` groups only; claude-fable-5-1 appears in no
group. A pin bypasses the group selection by design, so class B and C are
information about the router's own rules, not errors in the pin.

### Across all 126 pins (no pool data needed)

- `mistral-medium-3.5`: 31 pins. 25 are class B (in the pool, not in the
  classifier's group), and none of those 25 is inside the window. 20 of the 31
  sit on code_complex prompts. The pool lists this model in `standard` and
  `bulk_reader` only, never in `code_complex`, `planning` or `design`.
- 30 pins name version `5` without the `-5` (`claude-sonnet-5`, `claude-opus-5`,
  `sonnet-5`, `opus-5`, plus two `pi-claude/…` and one `claude-bridge/…` form).
  The pool does not contain that version, so their group membership cannot be
  decided. Two pins name only a family (`sonnet`, `opus`); the `mistral` pins
  name no version either and count as unparsed.

## Reading the numbers

- **Class B is the Mistral workaround pattern, seen in one place.** The
  mistral-large-4 pins on code_complex prompts are the same workaround cause
  as in the October note (Mistral used while the Claude path failed). The group
  rule did not select the model; the pin did.
- **`continue` is not a group check.** `CATEGORY_TO_GROUP` maps `continue` to
  `standard`, and a continuation pin means "keep this model" (October note,
  finding 3). A continuation pin that lands in `standard` says nothing about the
  model. A continuation pin signals a router problem when the previous turn was
  routed wrongly; that is a comparison with the inherited category, which this
  run cannot make (no context was given to the reference classifier).
- **Reference labels are one model's opinion.** GLM 5.3 labelled all 126
  prompts. A disagreement with a pin is a candidate for review, not a count of
  classifier errors.

## Limits

- 13 usable pins (10 % of the sample). No trend or rate can be stated.
- Pool membership is a union over 2.5 weeks, not a time-exact check.
- Reference categories were produced without conversation context, which
  matters most for `continue` (14 of 126).
- The four `hint:` reflections were excluded, so the reference set is 122 prompts.

## Open for the owner

1. Whether the owner's own labels for 20–30 pinned prompts should be made with
   the conversation context (the reference run has none).
2. Whether `continue` pins should be judged against the inherited category
   (needs the previous turn's category, which the decision log does not keep for
   pinned turns).
3. Whether pool data should be kept for the pre-2026-10-28 period. It does not
   exist as far as the logs show.

## Files (private, not in the repo)

- `~/.laya-ft/taxonomy-replay/items.jsonl` (prompts, mode 600)
- `~/.laya-ft/taxonomy-replay/results.jsonl` (categories and token counts)
- `~/.laya-ft/taxonomy-replay/join.jsonl` (ids, categories, classes)
- scripts: `build_items.ts`, `run_taxonomy.py`, `extract_pin_targets.py`, `join_groups.py`
