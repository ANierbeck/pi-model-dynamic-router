# 0030 — Feedback-driven classification correction: first step

## Status

Accepted for Option 1 (2026-11-14). Revised after the review round on PR #175 (same day).
The owner said "Option 1 umsetzen". The open decisions were not answered one by one; they were
built at the recommended values listed at the end.

This ADR decides the order and the shape of the first step of ADR 0002
(learning from user feedback, Option B, accepted 2026-08-29, not implemented).
It extends ADR 0002 Option B in one place: the stored payload may be a
category. ADR 0002 is not changed.

## Context

The router picks one category per prompt (`src/classification-prompt.ts`) and
routes by that category. When the pick is wrong, the user has no way to say
so that the router remembers.

Verified against the code on 2026-11-14:

- **The HINT channel cannot name a category.** `detectHintDirectly`
  (`src/content-classifier.ts:443`) accepts the group, model and tier forms.
  The form is a colon after `HINT` or the word `use` or `modell` right after
  it, followed by a name. A HINT pins the model or group for one turn; it says
  nothing about the category. There is no category form.
- **No correction store exists.** Nothing under `src/` persists a
  prompt-to-target mapping. ADR 0002 Option B describes one (in `cache.json`),
  but it stores only `group` or `model` targets.
- **The decision log has no outcome join.** Phase 2 of
  `docs/plans/2026-10-08-classifier-decision-log.md` is not built.

## Decision drivers

- **Data minimisation** (ADR 0002): store only what the user typed as a
  correction, one entry per correction.
- **Auditability** (ADR 0002, ADR 0027): a stored correction must be visible
  and removable by the owner.
- **No silent misrouting:** a correction must not apply where the user did not
  mean it, and an unknown category must never route silently.
- **No hardcoded models** (ADR 0025): corrections name categories and groups
  that the taxonomy defines.

## Options

### 1 — Exact-match correction store, written only from an explicit HINT (recommended)

**Syntax.** A category form, for example `HINT: category planning`. It is
accepted only when the name is a category of the taxonomy in
`src/classification-prompt.ts`. Any other name is rejected with a message that
lists the valid names; the turn is then classified normally, with no correction.

**Where.** `cache.hint_corrections` in the existing `cache.json`, as ADR 0002
Option B describes. No new file, so the state-file list and the package
`files` allowlist do not change.

**Entry.** `{ hintType: 'category' | 'group' | 'model' | 'tier', target: string,
savedAt: string }`. The `hintType` field extends the ADR 0002 shape with
`category`. Only `origin: 'user'` HINTs are written; automatic hints such as
compaction continuity are not (ADR 0002).

**Key.** The exact prompt string after the HINT head is removed. Only trimmed
at both ends; no case folding and no whitespace collapsing. Code, identifiers
and literals differ in case and spacing, so folding would merge distinct
prompts. This is the exact-match rule of ADR 0002.

**Precedence.** One entry per key. A later correction of the same prompt
replaces the earlier one (last write wins, `savedAt` is updated).

**Lookup.** Before the classifier runs, after `detectHintDirectly`. A stored
category is applied only if it is still a category of the taxonomy; a stale
entry is ignored and the decision log records the step `correction-stale`.

**Short prompts.** A prompt under N words (default 5, owner decision) is never
stored and never matched. This is the case that matters: a prompt such as
`continue`, `ok`, `yes` or `keep going` has the same text in every session, but
its meaning depends on the previous turn. The check is syntactic, because the
classifier has not run yet when the lookup happens.

**Residual risk, named.** A long prompt that repeats exactly and whose meaning
changes with context can still match a stored correction. The exact-match rule
makes this rare; expiry (open decision 4) bounds it.

**Size.** The cap of ADR 0002 Option B: the same cap as the classification
cache in `src/cache.ts`. When the cap is reached, the least recently used entry
is dropped.

**Pros:** smallest change; no model-based matching; easy to audit
(`/router corrections list|clear`). **Cons:** helps only with repeated
identical prompts.

### 2 — Similarity matching (ADR 0002 Option C)

Nearest-neighbour matching over corrected prompts. Covers rewordings, but can
apply an unrelated correction silently (ADR 0002 Option C). No data yet to set
a threshold. Not recommended now.

### 3 — Outcome join first (decision-log Phase 2), learning later

Build Phase 2 so the router sees which classifications were overridden, then
decide on learning from measured data. Evidence before any learning; no
user-visible effect for a long time.

## Recommendation

Option 1, as specified above. Build order if the owner agrees:

1. The category form of `HINT`, red-first in the HINT tests, including the
   rejection of an unknown category.
2. The store in `cache.hint_corrections`: exact key, last write wins, cap,
   stale-entry check, short-prompt exclusion. Red-first on each of these.
3. `/router corrections list|clear`.
4. Decision-log step `correction` and `correction-stale`. This is the only link
   to Phase 2 of the decision-log plan, and it needs no outcome data.

Option 2 starts only when the owner re-types HINTs for reworded requests of the
same intent. Count them from the HINT log before starting it; do not start it
on a feeling.

## Consequences

- The correction store is user data inside `cache.json`. The owner can list and
  clear it. The file keeps its existing mode.
- The `HINT` category form is a new user-visible syntax; the README documents it
  when it is built.
- Until the owner decides, routing does not change.

## Decisions taken for the build (2026-11-14)

1. **Syntax:** `HINT: category <name>`. Owner: "Option 1 umsetzen".
2. **Key:** the prompt text, not a hash (recommendation; `/router corrections list` shows it).
3. **Short-prompt threshold:** 5 words (recommendation).
4. **Expiry:** none; the LRU cap of 64 is the only bound (recommendation).
5. **Relation to decision-log Phase 2:** built independently (recommendation). Phase 2 is not started.

A different value for 2 to 5 is a new ADR that cites this one; this ADR is not edited after acceptance.
