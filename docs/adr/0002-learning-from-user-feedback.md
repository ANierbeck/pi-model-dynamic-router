# 0002 — Learning from user feedback

## Status

Accepted (2026-08-29) — Option B.

## Context

The router has no interactive UI (no chat window, no thumbs-up/down button)
— it's a background Pi extension that intercepts model-selection calls. The
only mechanism by which a user currently expresses "the classifier's
routing choice was wrong for this prompt" is the deterministic `HINT: ...`
prefix (`detectHintDirectly()` in `src/content-classifier.ts`), which forces
a specific group or model and bypasses classification entirely for that
turn.

Today, a HINT override is used once and forgotten — the next structurally
similar prompt goes through the LLM classifier again from scratch, with no
memory of the earlier correction. "Learning from user feedback" as
originally scoped in `TODO.md` means: when the user overrides the
classifier via HINT, remember that correction so a similar future prompt
routes correctly without needing the HINT again.

What already exists that's adjacent but NOT this:

- **Passive logging** (`appendRawLog()`, called at every classification
  decision site in `index.ts`) — every resolved category/group/model is
  already written to a log file with the prompt excerpt. This is an audit
  trail, not a feedback loop: nothing reads this log back into future
  classification decisions.
- **`SessionEscalation`** (`src/escalation.ts`) — detects repeated
  loops/thrash within a SINGLE session and escalates the routing tier. This
  is reactive and session-scoped; it resets every session and never
  persists a specific prompt→category correction.
- **Classification cache** (`classifyCacheGet`/`classifyCacheSet`,
  v1.5.0) — an in-memory LRU+TTL cache keyed by exact prompt string, purely
  a performance optimization to skip redundant LLM calls for identical
  prompts within a short window. Not persisted across sessions, not
  similarity-aware, and doesn't special-case corrected results differently
  from any other cached result.

None of these give the classifier durable memory of a specific correction.

## Decision Drivers

- **Data minimization is an established, deliberate principle in this
  codebase already** — see `classifier_cloud_fallback` in `src/types.ts`
  (opt-in, off by default) and the local-only `callLocalLlm` used for
  GDPval matching being explicitly justified as "no user data is involved."
  Persisting raw prompt corrections (even locally) is a new category of
  data retention this project hasn't done before and needs an explicit,
  deliberate choice, not an implicit one.
- **No embeddings/similarity infrastructure exists today.** Any "learn from
  a correction and apply it to a SIMILAR future prompt" design needs some
  notion of similarity beyond exact string match (the classification cache
  already covers exact-match). Building or depending on an embedding model
  is new infrastructure, not a small addition.
- **A silently-wrong persisted correction is worse than no correction.** If
  a stored correction is applied to a prompt that only superficially
  resembles the one that was corrected, the failure mode is silent
  misrouting with no obvious cause days or weeks later — much harder to
  debug than "the classifier guessed wrong this one time," which
  self-corrects via escalation logic already.
- **Auditability.** Per this repo's testing/documentation discipline
  (`AGENTS.md` §4–5), any persisted state that changes routing behavior
  needs to be inspectable and explainable — "why did it route here" must
  stay answerable from logs, not require reverse-engineering a learned
  weight.

## Options Considered

### A — Do nothing beyond existing passive logging

Leave `appendRawLog()` as the only feedback trail; a human can grep the log
manually if curious why a route was chosen, but nothing feeds back into
future routing automatically.

- **Pros:** Zero new complexity, zero new data retention question, zero new
  failure mode. Consistent with the project's existing data-minimization
  posture without having to make a new privacy decision at all.
- **Cons:** Doesn't address the actual ask — a HINT correction today has to
  be repeated every time a similar prompt recurs; there's no reduction in
  that repeated friction over time.

### B — Exact-match correction store (recommended)

Extend the existing classification cache mechanism: when a turn resolves
via an EXPLICIT user HINT (not an auto-hint like compaction continuity —
`origin: 'user'` already distinguishes this in `HintClassificationResult`),
persist `(exact prompt string) → (resolved group/model)` to a small
on-disk store (reusing the router's existing `cache.json` pattern, same as
`gdpval_scores`/`exhausted_keys`). Before running the LLM classifier, check
this store first — same lookup shape as the in-memory classification
cache, but (a) persisted across sessions, (b) exact-match only, no
similarity matching, (c) only ever populated by explicit user corrections,
never by ordinary LLM classifications.

- **Pros:** No new infrastructure — reuses the cache-persistence pattern
  already in `src/cache.ts`. No similarity/embedding question to answer, so
  no silent-misapplication failure mode: it only ever fires for the EXACT
  prompt text the user corrected, which mostly matters for recurring
  boilerplate prompts ("run the tests", "commit and push") where exact
  repetition is actually common in this kind of session. Small, auditable:
  the store IS the explanation for why a route was chosen.
  Fully consistent with the existing data-minimization posture, since it's
  strictly a subset of prompts the user ALREADY chose to send with a HINT
  (no new category of data collected, just persisted instead of
  logged-and-forgotten).
- **Cons:** Doesn't generalize — "run the tests" corrected once helps every
  future EXACT "run the tests," but "run the test suite" (worded
  differently) gets no benefit. This may undershoot what the user actually
  wants from "learning" if the goal is generalization across phrasing, not
  just literal repeats.

### C — Similarity-based correction store

Same as B, but match future prompts against stored corrections by semantic
similarity (embeddings, or a cheaper proxy like token-overlap/Jaccard
similarity against the corrected prompt) instead of exact string match, so
paraphrased prompts also benefit.

- **Pros:** Actually generalizes across phrasing — closer to what "learning
  from feedback" implies. Would meaningfully reduce repeated HINT usage for
  recurring TYPES of requests, not just byte-identical ones.
- **Cons:** Needs a similarity method. Embeddings mean a new
  model/dependency (and a decision about whether that call is local-only or
  another `classifier_cloud_fallback`-style opt-in, given it still touches
  raw prompt content). A cheap lexical proxy (token overlap) risks false
  positives — two structurally different requests sharing several words
  could silently inherit an unrelated correction. Per the Decision Drivers
  above (silent misrouting is worse than no correction), this needs a
  confidence threshold and a way to audit/undo a bad similarity match,
  which is real design work, not a small addition on top of B.

### D — Few-shot prompt injection from recent corrections

Instead of a lookup-and-short-circuit store, feed the N most recent
corrections into the LLM classifier's own prompt as few-shot examples,
letting the LLM itself generalize from them on every call.

- **Pros:** No exact/similarity matching logic needed at all — offloads
  generalization to the LLM, which is already the general-purpose reasoning
  component in this pipeline.
- **Cons:** Grows the classifier prompt (already timing-sensitive — see the
  existing cold-start/timeout handling for `gemma4:12b-mlx`), directly
  working against the classification-cache's whole purpose (avoiding slow
  local-LLM calls). Also non-auditable in the same way as a trained weight
  would be: "why did it classify this way" becomes "because of some
  interaction between N few-shot examples and this specific prompt," which
  is much harder to explain after the fact than B's direct lookup.

## Decision

**Recommendation: Option B** (exact-match, HINT-sourced correction store).
It's the option that best respects this project's existing data-minimization
stance (persists nothing beyond what the user already explicitly typed via
HINT), has no new failure mode beyond "doesn't generalize as far as C/D
would," and is fully auditable — which matters given this router's existing
emphasis on explainable routing decisions (dynamicLabel logging at every
resolution point).

Option C is the natural next step IF exact-match correction turns out to be
too narrow in practice (i.e. if the user finds themselves re-typing HINTs
for recognizably-the-same-but-reworded requests) — worth revisiting with
real usage data rather than speculatively building similarity matching now.

**Confirmed by user (2026-08-29): Option B.** Rationale matches the
recommendation above — respects the project's existing data-minimization
stance, has no silent-misapplication failure mode, and is fully auditable.

## Consequences

If B is accepted:

- New persisted store, e.g. `cache.hint_corrections: Record<string, {
  target: string; hintType: 'group'|'model'; savedAt: string }>`, following
  the existing `Cache` type conventions in `src/types.ts`.
- `classifyPrompt()` gains an early-return check (before the LLM call, after
  `detectHintDirectly()`) that looks up the exact prompt in this store.
- Only `origin: 'user'` hints get persisted — `origin: 'auto'` hints
  (compaction continuity) must NOT be written here, since those aren't user
  corrections.
- Needs a bound (LRU-style cap, similar to the classification cache) so the
  store doesn't grow unbounded over long-lived installs.
- Test coverage needed: a HINT-corrected prompt is persisted and short-
  circuits the LLM on exact repeat; an auto-hint (compaction) is NOT
  persisted; the store respects its size cap.
