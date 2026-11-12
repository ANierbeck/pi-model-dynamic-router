# Installer: one backend per version, and --force replaces it silently

**Status:** proposed 2026-11-12 — not started. One owner decision is open (see Open decisions); the minimal fix needs none.

**Problem:** The install layout `<root>/<model>/<version>/` holds one install per version (decision 3 of `docs/plans/2026-11-08-laya-model-artifact.md`). The manifest offers two artifact sets for `router@1.0.0` (`onnx` and `mlx`), so a user can ask for either, but only one can be installed:

1. A second backend without `--force` is refused with `exists`. The message names the directory, not the backend that is installed, and does not say that `--force` would replace it.
2. With `--force` the whole version directory is replaced. Nothing reports what was removed: the ONNX install disappears and `list` shows only `mlx`.

Measured in `docs/research/2026-11-12-installer-backend-repro.md`. Nothing is lost for good (the artifacts download again), but the sidecar then serves a different backend than the user thinks. Because the weights are not published yet, the layout can still change without a migration; after the first publish it cannot.

**Solution (minimal, recommended):** keep one backend per version and make the rule visible.

1. The `exists` message names the installed backend and says that a reinstall with another backend replaces it (`… already installed as onnx in <dir>; installing mlx replaces it — use --force`).
2. A forced install reports what it replaced: the result carries `replaced: 'onnx'` (or nothing when the same backend is reinstalled), and the CLI prints a line for it.
3. The skill (`skills/router-laya-install/SKILL.md`, step 5) and `laya-sidecar/README.md` state the one-backend rule and how to switch.

Red first: (a) the refusal message contains the installed backend — fails now; (b) a forced install over another backend returns `replaced` — fails now. Each is confirmed red before the code change, and the change is checked by a mutation (dropping the name from the message turns (a) red again).

**Open decisions (owner):**

1. **One backend per version (recommended for 2.0) or side-by-side?** Side-by-side means `<model>/<version>/<backend>/`: both can be installed, `list`, `verify` and `remove` take a backend, and the sidecar's `--model-dir` points at the backend directory. That changes the 2026-11-08 layout decision, the skill paths, the sidecar README and most installer tests. It has to be decided before the weights are published.
2. **Is MLX an installer target for 2.0 at all?** The Mac path runs the reference server from a checkpoint directory. If MLX stays outside the installer, the MLX set can leave the manifest and the question goes away.

**Verified against:** `main` @ `44417ca`. `src/laya-model-install.ts` lines 251–257 and 326–333; `test/laya-model-install.test.ts` (the "does not overwrite" case); `laya-models/manifest.json` (backends `onnx`, `mlx` for `router@1.0.0`). Reproduction: `docs/research/2026-11-12-installer-backend-repro.md`.

**Not checked:** a real MLX install end to end (weights unpublished); Windows behaviour of the directory rename in the forced path (the atomic rename is unchanged by this plan).

## Steps

- [ ] Step 1: red tests (a) and (b) in `test/laya-model-install.test.ts`, confirmed red.
- [ ] Step 2: message and `replaced` result in `src/laya-model-install.ts`; CLI line in `main`.
- [ ] Step 3: skill step 5 and `laya-sidecar/README.md` state the one-backend rule.
- [ ] Step 4: owner decision 1 recorded; if side-by-side, a new plan (one problem) replaces this step.
