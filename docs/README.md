# Documentation map — one owner per fact

Every fact the project documents has exactly one owning document. Everything
else **links** to it; nothing copies it. When a fact changes, exactly one file
changes, and no second copy can go stale (hygiene Phase 3,
`docs/plans/2026-10-29-repo-hygiene.md`; enforced for shipped docs by
`scripts/redundancy-report.ts`).

| Kind of fact | Owning document |
|---|---|
| What the router does for a user, install, config keys, commands, tools | [`README.md`](../README.md) |
| The shipped user view that travels in the npm package | [`PI.md`](../PI.md) |
| How routing works end to end (classification → group → model → stream) | [`routing-flow.md`](routing-flow.md) |
| Module responsibilities and the internal wiring | [`architecture.md`](architecture.md) |
| Every configuration key and its override layer | [`config-override.md`](config-override.md) + [`router-config.example.json`](router-config.example.json) |
| Why a decision was made (immutable, never edited — §12) | [`adr/`](adr/) |
| What is being worked on and why (one problem per plan — §11) | [`plans/`](plans/) + [`plans/README.md`](plans/README.md) |
| Measurements, experiments, evaluations | [`research/`](research/) |
| Mutation-testing triage and survivors | [`mutation-triage.md`](mutation-triage.md) |
| Release steps | [`../RELEASE_CHECKLIST.md`](../RELEASE_CHECKLIST.md) |
| Release history | [`../CHANGELOG.md`](../CHANGELOG.md) |
| Open work and the owner backlog | [`../TODO.md`](../TODO.md) |
| Rules that govern agents working in this repo | [`../AGENTS.md`](../AGENTS.md) |
| Finished work, superseded roadmaps, old release plans | [`archive/`](archive/) — history, never edited |

## Conventions

- **Shipped documents** are the `files` list of `package.json` plus
  `README.md`. They must describe the *current* layout: a removed group or
  category name in one of them fails `test/redundancy-baseline.test.ts`
  (`staleNames` is pinned at 0).
- **Historical documents** — `adr/`, `plans/`, `research/`, `archive/`,
  `CHANGELOG.md` — are never edited for tidiness. They may name anything.
- **Plans** start with `Status`, `Problem`, `Solution`, `Open decisions`,
  `Verified against` (§11). A new plan without a `Status` line fails the
  ratchet.
- **New top-level file?** It needs an entry in the `ROOT_ALLOWLIST` of
  `scripts/redundancy-report.ts` in the same change, which forces the question
  "which document owns this fact?".
