# Remnants of the retired category `fallback` (meaning E) — finding list

Round 1 of `docs/plans/2026-10-25-fallback-naming.md`: the category `fallback`
was replaced by `continue` in v2-r3 (2026-10-13). This is the list of use
sites found by reading each hit, **before** anything is deleted. Nothing is
changed yet. Search: every `fallback` hit in `src/`, `index.ts`, `scripts/`,
`test/`, `README.md`, `docs/routing-flow.md` that sits next to category
vocabulary. Checked against the tree at `999245f`.

## 1. User-facing documentation that is wrong today (fix first)

These describe a category that no longer exists and a default that no longer
applies.

| where | what it says |
|---|---|
| `README.md:121` | "when the classifier … returns `fallback`" inherits the previous category; default "`fallback` → `tactical`" |
| `README.md:184` | category list item "`fallback`: Unclear or multiple categories apply" |
| `README.md:218-220` | no static path and no model → "the category `fallback` is returned" |
| `docs/routing-flow.md:28` | category output list ends in `exploration · fallback` |
| `docs/routing-flow.md:34` | decision node "fallback category or low confidence?" |
| `docs/routing-flow.md:116` | "`fallback` ('ambiguous, or a short continuation/confirmation') inherits …" |

The real category is `continue`; the default group is today `tactical`
(`CATEGORY_TO_GROUP`, `src/content-classifier.ts:1269`), which the 5-group plan
changes to `standard` (D6). The README and flow text must change in the same
round as D6, so they are written once.

## 2. Stale comments and messages in `src/`

| where | problem |
|---|---|
| `src/content-classifier.ts:749` | comment "map to fallback"; the code two lines below warns and uses `continue` |
| `src/commands.ts:186` | example string "60% fallback" in a comment about the category mix |
| `src/content-classifier.ts:1269` | trailing comment "was fallback:" — a history note; keep or drop |

## 3. A data value that still carries the retired name

`src/content-classifier.ts:556` writes the step name **`fallback-inherit`** into
the decision log (`steps`) when a raw `continue` inherits the previous
category. It is the retired label embedded in log data, pinned by
`test/classifier-decision-log.test.ts:173-181`. Renaming it changes the log
vocabulary: older records keep the old name. **Owner decision** (see below).

## 4. Tests with stale wording (names, comments — behavior is right)

- `test/fallback-inherits-category.test.ts` — file and `describe` name
  ("fallback classification inherits…"); the tests drive `continue`.
- `test/classifier-fallback-chain.test.ts:93,492` — titles "returns the fallback
  category" (the result is `continue`; titles also say "fallback" for the
  chain, which is meaning C and stays for Round 2).
- `test/classifier.test.ts:86`, `test/classifier-cloud-candidate-timeout.test.ts:86`
  — comments "fall back to fallback" / "a routed fallback category".
- `test/category-taxonomy-v2.test.ts:8,34` — history comments ("the group the old
  fallback category used"); accurate, can stay.

## 5. Looks like E but is legitimate — keep

- `src/laya-classifier.ts:235` and the tests `test/laya-chain.test.ts:135`,
  `test/laya-lifecycle.test.ts:155`: the legacy answer `fallback` is **rejected**
  by `vetAnswer` as outside the taxonomy. The comment explains exactly that, and
  the tests pin the veto.
- `test/laya-shadow-stats.test.ts:13,16`, `test/laya-pair-stats.test.ts`: legacy
  decision-log records with `"category":"fallback"` as fixtures — the log really
  contains such records.
- `docs/adr/0001-*.md`: an ADR (immutable, plan §12).
- `~/.laya-ft` (outside the repo): the label mapping `fallback → None`; the plan
  says to name it `legacy_fallback` there. Not touched here.

## 6. Not E — belongs to other rounds

The group `fallback` (meaning A, goes with D4), the stage name `fallback` in the
decision log and `README.md:92` (cloud chain exhausted, meaning C → Round 2), the
`fallback_groups` key (B/F) and `?? 'fallback'` at `content-classifier.ts:1306`
(group A).

## Proposed red-first test (needs the owner's nod)

The plan asks for a taxonomy test that fails while code still accepts
`fallback` as a category. Code does **not** accept it any more (item 5: it is
vetoed), so that test would be green at birth. Honest alternatives, in order of
cost:

1. A docs pin: `README.md` and `docs/routing-flow.md` must not describe
   `fallback` as a category (red today: items in section 1). Cheap, and it covers
   the part that is actually wrong.
2. A comment/step pin for the `fallback-inherit` name, only if the owner decides
   to rename it.

A repo-wide "no word `fallback` near `category`" scan stays out: it is fragile
and would flag section 5.

## Decisions for the owner

- Rename the log step `fallback-inherit` (section 3)? Cost: old and new records
  coexist; tools reading `steps` must accept both.
- Fix the README and flow text in Round 1 (section 1, wrong now) or together
  with D6 in the 5-group round (written once)? Recommended: Round 1 for the
  facts that are wrong regardless of D6 (the category name), D6 text later.
- Section 4: rename the test file and titles in the same commit, or leave history
  alone? Recommended: rename (boyscout rule, same commit as section 1).
