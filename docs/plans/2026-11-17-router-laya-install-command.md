# `/router laya` — install the Laya classifier from inside pi

**Status:** in progress 2026-11-17 — plan written, tests not yet red. Owner asked
for the command after the container work showed that the installer exists only as
a separate CLI (`pi-laya-model`), which a user inside pi never sees.

**Verified against:** `main` @ `110d13a` (merge of PR #185). `src/laya-model-install.ts`
(`installModel`, `verifyInstall`, `listInstalls`, `loadManifest`), `src/laya-runtime-install.ts`
(`installRuntime`, `verifyRuntime`), `src/commands.ts` (`setIntegration`,
`commitConfigPatch`, the `/router` dispatch), `skills/router-laya-install/SKILL.md`
(the confirmed-step procedure this command follows), `laya-models/manifest.json`
(`router@1.0.0`, `published: false`). Not checked: a real download (the release
is unpublished, so none is possible).

## Problem

The Laya install is a multi-step procedure (platform, offer, download, verify,
ONNX runtime, config block, sidecar) that today lives in an agent skill and a
standalone CLI. Inside pi, `/router` has no way to start it, so a user has to
leave pi, find `pi-laya-model`, and copy the config block by hand.

## Solution

Two subcommands on the existing `/router` handler, following the `/router config`
pattern (one handler, `ctx.ui` dialogs, `commitConfigPatch` for the write):

- **`/router laya`** — status only, never changes anything, works in every mode:
  platform verdict, the offered version and whether it is published, what is
  installed and whether it verifies, runtime state, the `integrations.laya`
  block in the user layer, and the next step.
- **`/router laya install`** — the wizard, TUI only. Every step asks first:
  1. platform: Intel Mac stops; Linux and Windows continue with a note that they
     are untested;
  2. offer: an unpublished version stops with "needs the owner's release
     approval" — the command has **no** `--allow-unpublished` path (skill rule);
  3. existing install: verifies → skip the download; does not verify → show the
     problems, ask before a forced reinstall;
  4. confirm download (version, size, target dir) → `installModel`, then `verifyInstall`;
  5. ONNX runtime, if not verified → confirm (about 115 MB) → `installRuntime`;
  6. confirm the `integrations.laya` block (shadow mode; existing user keys such as
     `mode`, `endpoint`, `timeout_ms` are kept) → write it to the user layer;
  7. print the command to start the sidecar in the user's own terminal.

The router never starts the sidecar (skill step 8, unchanged).

Pure logic lives in `src/laya-install-command.ts` with injected dependencies, so the
wizard is tested with fakes (the real installer cannot publish in a test). The
handler is tested through the real `/router` path with the shipped, unpublished
manifest, which proves the refusal without network access.

## Open decisions

- **Sidecar start in `/router`?** Not built: the skill and the router's design say
  the user starts it in their own terminal. Owner decides if that changes.
- **Legacy `classifier_laya` block** (renamed to `integrations.laya` in 2.0): the
  skill offers to migrate it; this command does not touch it yet.
- **Publishing `router@1.0.0`** stays a separate owner decision (AGENTS §1). Until
  then the install step stops at the offer, and the rest of the wizard is only
  reachable with a locally published manifest.

## Steps

- [ ] Red tests: `test/laya-install-command.test.ts`
- [ ] `src/laya-install-command.ts`: platform verdict, offer, config merge, status, wizard
- [ ] `/router laya` wired into `src/commands.ts` and the subcommand table
- [ ] CHANGELOG, `docs/plans/README.md` row, plan Status → done
- [ ] Gates: tsc, lint, format, full vitest, PR
