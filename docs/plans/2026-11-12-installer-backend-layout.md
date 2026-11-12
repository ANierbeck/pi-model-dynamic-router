# Installer: one backend per version — MLX leaves the installer

**Status:** in progress 2026-11-12 — owner decided both open questions the same day (see Decisions). Steps 1–4 are built on `feat/laya-installer-onnx-only`; the staging directory of the weights release still holds four MLX files (step 5, owner action).

**Problem:** The install layout `<root>/<model>/<version>/` holds one install per version (decision 3 of `docs/plans/2026-11-08-laya-model-artifact.md`), but the manifest offered two artifact sets for `router@1.0.0` (`onnx` and `mlx`). A second backend was refused with a message that hid the installed one, and `--force` replaced the whole version directory without saying so (reproduced in `docs/research/2026-11-12-installer-backend-repro.md`). The layout can still change without a migration only until the weights are published.

## Decisions (owner, 2026-11-12)

1. **One backend per version.** Side-by-side installs (`<model>/<version>/<backend>/`) are not built.
2. **MLX is not an installer target.** "The ONNX path is sufficient." The MLX reference server `spikes/laya-http/server.py` stays in the repository as the parity reference (`laya-sidecar/scripts/record-reference.mjs`), but its checkpoint is no longer part of the weights release.

**Solution:** Decision 2 removes the cause, so the visibility fix this plan first proposed (message naming the installed backend, a `replaced` result) is dropped: with one backend in the shipped manifest a second backend cannot be requested. It would be code for a case that cannot happen; if a second backend is ever shipped, that is a new plan.

1. `laya-models/manifest.json`: `router@1.0.0` ships the `onnx` set only. The MLX set (643 MB `model.safetensors`, `questions.json`, `encoder-config.json`, `tokenizer_config.json`) leaves the release assets.
2. `pi-laya-model --help` offers `--backend onnx` only. The schema keeps `mlx` as a known backend name (`LAYA_BACKENDS`), so an older or custom manifest still validates; the installer answers `--backend mlx` with "has no mlx artifact set (known: onnx)".
3. `skills/router-laya-install/SKILL.md`: no backend choice, no MLX path; Intel Macs stop because ONNX Runtime has no darwin/x64 binding.
4. README and `docs/config-override.md` name the ONNX sidecar as the installable one.
5. The release staging directory (`~/.laya-ft/artifacts/r2-1.0.0/release`) holds `encoder-config.json`, `model.safetensors`, `questions.json` and `tokenizer_config.json`, which `laya-release-check` now reports as "would be uploaded". They are hard links; the owner removes them before the weights release.

Red first (observed before the change): the shipped manifest lists exactly `onnx`; the usage text has no `mlx`; the skill has no `mlx`. Each fails against the previous manifest, help text and skill.

**Open decisions (owner):** none for this plan. Whether the weights release stays a 2.0.0 blocker is tracked in `docs/plans/2026-11-08-laya-model-artifact.md`.

**Verified against:** `main` @ `cb15ee2`. `laya-models/manifest.json`, `src/laya-model-install.ts`, `skills/router-laya-install/SKILL.md`, the tests named above, and `scripts/laya-release-check.ts` run against the real staging directory (four unexpected files).

**Not checked:** an ONNX install end to end from a published release (weights unpublished).

## Steps

- [x] Step 1: red tests (manifest, usage text, skill), confirmed red.
- [x] Step 2: MLX set removed from the manifest; usage text; skill; README; `docs/config-override.md`.
- [x] Step 3: suites green (manifest, installer, skill, release-check, identity).
- [x] Step 4: CHANGELOG entry.
- [ ] Step 5: owner removes the four MLX files from the staging directory; `laya-release-check` then passes.
