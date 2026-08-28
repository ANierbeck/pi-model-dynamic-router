# Agent Rules — pi-model-dynamic-router

> These are **hard rules** for any AI agent working in this repo. Pi loads
> `AGENTS.md` (and `CLAUDE.md`) automatically at session start, so these apply
> to every session, every agent, every fork. Violating them is a process
> failure, not a style preference.

## 1. Release & Publish — REQUIRES EXPLICIT USER APPROVAL

**The user decides when software is released. Not the agent.**

- **Never** create a git tag, a GitHub Release, or run `npm publish` (directly
  *or* via a workflow trigger such as `gh release create`) without the user's
  **explicit, release-specific** approval. The approval must name the concrete
  release (e.g. "release 1.5.1"). General agreement like "weiter so", "yes do
  it", "ok", "like last time", or a clean CI is **NOT** approval.
- The normal flow **stops after** "commit + push + verify CI green". The next
  step (tag / release / publish) is **always a question to the user**, never an
  action. Ask with the concrete version number, not a generic "shall I tag?".
- A published npm version **cannot be deleted**. Treating a silent
  auto-publish as recoverable is wrong — the damage is permanent. This is why
  the rule exists. (Incident 2026-08-28: v1.5.0 was published to npm without
  approval; the rule already existed in memory but was ignored. Hence this
  file.)
- If unsure whether something counts as a release action: **ask first, do not
  act.** Tagging, `gh release create`, `npm publish`, and triggering a publish
  workflow are all release actions.
- **Roborev review must be clean before a release is even *proposed*** to the
  user. But a clean roborev is NOT itself approval to release — it's a
  prerequisite, not a substitute for the user's go-ahead.
- Use `roborev ... --agent claude-code` for reviews in this repo. The default
  `pi` agent hangs here.

## 2. Single source of truth for rules

- Rules that govern agent behavior belong **here** (versioned, reviewable,
  loaded every session) — not only in agent memory (which is per-context and
  can be missed). The release rule above is the canonical source. Memory
  entries may reinforce it but do not replace it.
- If a rule needs to change, change this file in a commit — don't quietly
  update only memory.

## 3. Documentation language

- **All documentation and comments must be in English** — code comments,
  JSDoc, Markdown (README, TODO, CHANGELOG, this file), commit messages, type
  definitions. Rationale: international project. (Existing German prose was
  translated to English in v1.4.0-era cleanup; new German comments are a
  regression.)
- Exception: short project shorthand tokens (`Ü1`, `A2`, `F3`, etc.) stay as-is
  — they're names, not prose. User-facing chat in German is fine (that's the
  user's language, not project documentation).

## 4. Tests & verification before push

- `npx tsc --noEmit` must pass before committing non-test-only changes.
- `npx vitest run` must be green (existing count: 515+ passing). Don't lower
  the `coverage.thresholds` in `vitest.config.ts` to unblock a red run — fix
  the actual regression.
- New features/fixes get a regression test that actually exercises the fix
  (non-vacuous — see the "Ü1 invariant test" incident where a test passed
  vacuously and had to be rewritten, roborev job 308).

## 5. Commit conventions

- Conventional-Commits-style prefixes: `fix:`, `feat:`, `test:`, `docs:`,
  `refactor:`, `chore:`, `release prep:`.
- Batch related fixes into one commit where they belong; don't split a single
  logical change across many tiny commits.
- Commit message body explains *why* (the bug, the symptom, the evidence),
  not just *what*.

## 6. Don't touch Pi's models.json / don't overwrite existing registrations

- `pi.registerProvider` REPLACES the provider's `models` array wholesale (it
  does not merge). Never register a provider with a partial model list when it
  might already be registered with more models — check
  `getRegisteredProviderIds` first (the Ü1 invariant). This bit us in v1.5.0
  development (roborev job 302) and is now enforced in
  `registerFreeModelOnDemand`.
