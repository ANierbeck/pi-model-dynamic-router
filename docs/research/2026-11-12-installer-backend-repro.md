# Installer: second backend on the same version (reproduction, 2026-11-12)

Measurement for `docs/plans/2026-11-12-installer-backend-layout.md`.
Verified against `main` @ `44417ca`.

## Setup

A temporary vitest case (deleted after the run) used the installer's own
`installModel` and `listInstalls` against a local `file://` release with two
backend sets (`onnx` and `mlx`, same payload) for a model `r9@1.0.0`:

1. `installModel(backend: 'onnx')`
2. `installModel(backend: 'mlx')` without `force`
3. `installModel(backend: 'mlx', force: true)`

## Observed

```
AFTER onnx:      [{"model":"r9","version":"1.0.0","backend":"onnx"}]
MLX no force ->  exists: r9@1.0.0 is already installed in <root>/r9/1.0.0; verify it, or reinstall with --force
AFTER mlx --force: [{"model":"r9","version":"1.0.0","backend":"mlx"}]
files now:       head.json manifest.json w.bin
```

## Code locations (main @ 44417ca)

- `src/laya-model-install.ts:251` — `finalDir = <root>/<model>/<version>`: no backend segment.
- `src/laya-model-install.ts:253-257` — the `exists` refusal; the message does not name the installed backend.
- `src/laya-model-install.ts:326-333` — with `force`, the whole version directory is replaced; nothing reports what was removed.
- `test/laya-model-install.test.ts` ("does not overwrite an existing install unless forced") pins the refusal code, not its text, and never installs a second backend.

## Manifest

`laya-models/manifest.json`: `router@1.0.0` carries `onnx` and `mlx` artifact sets.
