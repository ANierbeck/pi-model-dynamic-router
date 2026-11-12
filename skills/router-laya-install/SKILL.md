---
name: router-laya-install
description: Guide the installation of the Laya classifier model for pi-model-router. Checks what is on offer, the platform and free space, asks before every step, runs pi-laya-model, writes the user-layer integrations.laya config and checks the identity the sidecar reports on /health. Use when the user asks to install, set up or verify the Laya classifier.
---

# Router Laya Install — Install the Laya Classifier Model

## Overview

Laya is an optional local classifier. The router never downloads weights
itself. This skill walks the user through the one command that does: `pi-laya-model`,
which ships with the router and runs without Pi.

**Every step is a confirmed step.** The skill does not download, write
config or start anything before the user says yes.

- Never download without a yes to the size and target shown in step 4.
- Never write the config without a yes to the key block shown in step 7.
- Never start a process. The router does not start a sidecar either.
- Never use the unpublished-release option. It exists for router development
  against a local release, not for users.
- Never edit files in the install directory by hand. Use the CLI.

## Current state

Two things limit what this skill can finish today. Say them to the user
before starting, so nothing surprises them later:

1. **The weights release is not published yet.** The manifest marks
   `router@1.0.0` as unpublished, and the installer refuses it (step 1). Once the
   owner publishes the release, the same steps work unchanged.
2. **The ONNX sidecar is not published yet.** `@anierbeck/laya-sidecar` ships
   with release 2.0.0, together with the weights. Until that release is
   published, the install command in step 8 does not resolve. The install,
   the verification and the config work without it, and the skill can finish
   them and then hand over.

## Steps

### 0. Find the installer

The installer ships with router 2.0.0 or later. Find it in this order:

1. `pi-laya-model` on the PATH (`command -v pi-laya-model`).
2. The package's own copy:
   `~/.pi/agent/npm/node_modules/@anierbeck/pi-model-dynamic-router/dist/laya-model-install.js`,
   called with `node`.

Call the chosen form PI_LAYA below. If neither exists, stop. Report the
installed router version (`package.json` in that package directory). It
predates the installer, and the user needs the release that ships it.

### 1. Read what is on offer

```bash
pi-laya-model models --json
```

The result lists each model version with `published`, the backends with
`files`, `bytes` and `artifact_sha256`. If the version the user wants is
`published: false`, stop here. Tell the user that the release is not out
yet, and that installing it needs the owner's release approval.

### 2. Check the platform

Check the platform with `uname -s -m`.

- **Apple Silicon (Darwin, arm64):** `onnx`. This is the tested platform.
- **Linux or Windows (x64 or arm64):** `onnx`. It should work there but is **not tested**; say so to the user.
- **Intel Mac (Darwin, x86_64):** Laya is **not supported**: ONNX Runtime has no darwin/x64 binding. Stop here and tell the user; the router keeps the classifier chain.

`onnx` is the only backend the installer offers. There is nothing to choose; say which one is installed.

### 3. Check what is installed and the free space

```bash
pi-laya-model list --json
```

- If the version is already installed, run
  `pi-laya-model verify router@1.0.0 --json`. If it passes, go to step 7. If it
  reports problems, show them and ask before any reinstall (step 5, `exists`).
- Check the free space on the install root (`<Pi agent dir>/laya-models`, where
  the Pi agent dir is `PI_CODING_AGENT_DIR` or `~/.pi/agent`) with `df -k`. The
  installer needs the download size plus about 256 MB and checks this itself.

### 4. Confirm the download

Show the user, in one message:

- model and version, backend,
- download size in MB (from step 1),
- the target directory `<Pi agent dir>/laya-models/<model>/<version>/`.

Ask: "Download and install now? (yes/no)" Continue only on a clear yes.

### 5. Install

```bash
pi-laya-model install router@1.0.0 --backend onnx --json
```

An interrupted download resumes when the same
command runs again. On success the JSON has `ok: true`, `model`, `version`,
`backend`, `dir`, `artifact_sha256`, `bytesDownloaded` and `resumed`. Keep
`artifact_sha256` for step 9.

On failure the JSON has `ok: false`, a `code` and an `error`, and the exit
status is 1. Exit status 2 means the command itself was wrong. Act on the
code as listed in the error codes section at the end of this file.

### 6. Verify

```bash
pi-laya-model verify router@1.0.0 --json
```

The result has `ok` and `problems`. Continue to the config only on `ok: true`.

### 7. Write the config (confirm first)

The config belongs in the user layer, `<Pi agent dir>/router-config.user.json`.
Merge only the `integrations.laya` block into the existing file. Keep every
other key, including other entries under `integrations`. Show the user the
resulting `integrations.laya` block and ask before writing it. If the file
still has an old top-level `classifier_laya` block (the key was renamed in 2.0
and the router now ignores it with a warning), offer to move its values into
`integrations.laya` and remove the old block.

<!-- laya-config-snippet -->
```json
{
  "integrations": {
    "laya": {
      "enabled": true,
      "mode": "shadow",
      "checkpoint": "router@1.0.0",
      "endpoint": "http://127.0.0.1:8089"
    }
  }
}
```

Shadow mode only logs Laya's answer and does not change the route. The user
can switch to `"active"` later, after reviewing `/router` and the
decision log.

### 8. Sidecar (not started by this skill)

The skill does not start a sidecar. Explain the options:

- **ONNX:** the sidecar ships as `@anierbeck/laya-sidecar` with release 2.0.0
  and is not published yet. Once it is, the user installs it with
  `ONNXRUNTIME_NODE_INSTALL=skip npm install -g @anierbeck/laya-sidecar` (the
  skip flag keeps the CUDA download off) and starts it with
  `laya-sidecar --model-dir "$HOME/.pi/agent/laya-models/router/1.0.0" --head-json "$HOME/.pi/agent/laya-models/router/1.0.0/head.json"`.
  It listens on port 8089 by default, which is the router's default endpoint.
  Windows PowerShell sets the variable with `$env:ONNXRUNTIME_NODE_INSTALL = "skip"`.
  The platform table is in `laya-sidecar/README.md`. Until the release, say the
  sidecar is not published yet and stop here; the install and config stay valid.

### 9. Check the identity the sidecar reports

Once the sidecar runs:

```bash
curl -s http://127.0.0.1:8089/health
```

Compare the answer with the install:

- `artifact_sha256` must equal the value from step 5. If it differs, a different
  model is being served. Tell the user and do not rely on it.
- `model` and `version` must read `router` and `1.0.0`.
- `head_sha256`: the router warns in `/router` if it differs from the
  router's own head.

The stage probes on first use. Before the first classified prompt, `/router`
says "not probed yet". After it, the Laya line shows
`laya:router@1.0.0 (reported by the sidecar, …)`.

## Checklist

- [ ] Installer found (router 2.0.0 or later)
- [ ] Model version is published (`published: true`)
- [ ] Free space and existing installs checked
- [ ] Download confirmed by the user
- [ ] Install succeeded, `artifact_sha256` recorded
- [ ] Verify passed
- [ ] Config block confirmed by the user and written in the user layer
- [ ] Sidecar: started by the user, or handed over with the reason
- [ ] `/health` identity matches the install

## Error codes

- `disk`: not enough free space. Tell the user how much is needed. Run again after freeing it.
- `download`: network or server failure. Run the same command again. It resumes.
- `checksum`: a file does not match the manifest. Nothing was installed. Do not retry blindly. Report it: either the download was corrupted or the release is wrong.
- `head`: the classifier head inside the artifact differs from the router's head. Nothing was installed. Report it. This is a release problem, not a user problem.
- `unpublished`: the release is not out yet (step 1). Stop.
- `exists`: already installed. Verify it, or ask before a reinstall with the force option.
- `not-found`: no such model or version in the manifest. Check the list from step 1.
- `manifest`: the manifest is invalid. Report it and suggest updating the router.
- `usage`: the command was wrong (exit status 2). Fix it and run again.
