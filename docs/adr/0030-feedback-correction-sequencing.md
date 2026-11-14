# 0030 — Feedback-driven classification correction: first step

## Status

Proposed (2026-11-14). Open owner decisions are listed at the end. Builds on
ADR 0002 (learning from user feedback, Option B accepted, not implemented).
ADR 0001 (multi-label) is withdrawn by ADR 0031; this ADR does not depend on it.
ADR 0002 is not changed by this ADR.

## Context

The router picks one category per prompt (`src/classification-prompt.ts`) and
routes by that category. When the pick is wrong, the user has no way to say
so that the router remembers.

Verified against the code on 2026-11-14:

- **The HINT channel cannot name a category.** `detectHintDirectly`
  (`src/content-classifier.ts:443`) accepts `HINT: use <group>` and `HINT: use
  <model>` only (`hintType: 'group' | 'model' | 'tier'`). A HINT pins the model
  for one turn and says nothing about the category. ADR 0002 Option B assumed a
  category correction; that syntax does not exist yet.
- **No correction store exists.** Nothing under `src/` persists a
  prompt-to-category mapping.
- **The decision log has no outcome join.** Phase 2 of
  `docs/plans/2026-10-08-classifier-decision-log.md` is not built. Its
  "correction signal" (a HINT on the next turn) describes the same user action
  that this ADR would learn from.

## Decision Drivers

- **Data minimisation** (ADR 0002): store only what the user typed.
- **Auditability** (ADR 0002, ADR 0027): a learned correction must be visible
  and removable.
- **No silent misrouting** (ADR 0001 mitigation): a correction must not apply
  where the user did not mean it.
- **No hardcoded models** (ADR 0025): corrections name categories and groups.

## Options

### 1 — Exact-match correction store, written only from an explicit category HINT

A new syntax, for example `HINT: category planning`, sets the category of the
current prompt for future identical prompts. Each correction is one JSONL
line: `{ key, category, created_at }`, where `key` is a SHA-256 of the
normalised prompt (trimmed, lowercased, whitespace collapsed, HINT head
removed). A later prompt whose key matches takes the stored category before the
classifier runs; the decision log records origin `correction`.

- Pro: smallest change, no model-based matching, easy to audit (`/router
  corrections list|clear`).
- Con: it helps only with repeated identical prompts (see the collision issue
  below).

### 2 — Similarity matching (ADR 0002 Option C)

Nearest-neighbour matching over corrected prompts.

- Pro: covers rewordings.
- Con: silent misapplication; no data yet to set a threshold.

### 3 — Outcome join first (decision-log Phase 2), learning later

Build Phase 2 so the router sees which classifications were overridden, then
decide on learning from measured data.

- Pro: evidence before any learning.
- Con: no user-visible effect for a long time.

## Recommendation

Option 1, with one hard rule added: **no correction for continuation or very
short prompts.** Prompts such as "weiter", "ok", "ja", "mach weiter" have the
same text in every session, but their meaning depends on the previous turn.
An exact-match store would apply one correction to every later "weiter". The
continuation class already exists in the classifier (`continue`), so the rule
is: a prompt the classifier labels `continue`, or under N words (default 5, to
be set by the owner), is never stored and never matched.

Build order if the owner agrees:

1. `HINT: category <name>` syntax, red-first in the HINT tests.
2. The store with the continuation/short-prompt exclusion, red-first on the
   exclusion and on the "identical prompt matches" case.
3. `/router corrections list|clear`.
4. Decision-log origin `correction`. This is the only link to Phase 2 of the
   decision-log plan, and it needs no outcome data.

Option 2 starts only when the owner re-types HINTs for reworded requests of the
same intent. Count them from the HINT log before starting it; do not start it
on a feeling.

## Consequences

- A new persistent file in the state directory. It needs the `package.json`
  `files` negation and an entry in `test/package-contents.test.ts`
  (STATE_FILES).
- The store is user data. Owner can list and clear it.
- Until the owner decides, routing does not change.

## Open decisions for the owner

1. **Syntax:** is `HINT: category <name>` acceptable, or another form?
2. **Store the text or only the hash?** A hash is more private, but then the
   owner cannot see which prompt a correction matches. Storing a snippet follows
   the `store_text` setting of the decision log (`none` by default in shipped
   config).
3. **Short-prompt rule:** continuation class plus under 5 words, or another
   threshold?
4. **Expiry:** kept until cleared, or expire after N days?
5. **Relation to decision-log Phase 2:** build Phase 2 first (recommended, since
   the correction event is the same event), or independently?
