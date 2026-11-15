<!-- Generated from src/config-keys.ts by scripts/config-reference.ts. Do not edit by hand:
     run `node scripts/config-reference.ts --write` after changing the key table. -->

# Config reference

Every key in the table that `/router config` documents. Defaults are the shipped
`router-config.json` values; keys the shipped file does not set show the code default.
Concepts (order, privacy, when cloud is used) are in `README.md` and
`docs/config-override.md`; this page lists the keys.

## Classifier chain (computed from the shipped config)

The order is fixed in code: Laya, then the local Ollama leg, then the cloud leg, then
the static rules. The config only switches legs on and off and names their models.

- **Laya** — off: integration not enabled
- **Local (Ollama)** — on: models derived from what Ollama reports
- **Cloud** — on: when local gives no answer; probe-verified list
- **Static rules** — off: only for the :use-static model variant; not set by the config

## Keys

### `classifier.local.model`

- Shipped: `unset, derived from the models Ollama reports (code default)`
- Set by: `/router config set classifier.local.model <value>`
- Meaning: Pinned local classifier model (`ollama/<name>:<tag>`). Unset: the scan probe derives it.
- Pre-2.0 name, read for one release with a warning: `classifier_model`

### `classifier.local.fallback`

- Shipped: `unset, derived (code default)`
- Set by: `/router config set classifier.local.fallback <value>`
- Meaning: Pinned second local classifier model, tried when the primary gives no answer.
- Pre-2.0 name, read for one release with a warning: `classifier_fallback`

### `classifier.cloud.enabled`

- Shipped: `true (code default false)`
- Set by: `/router config set classifier.cloud.enabled <value>` (also in the guided menu)
- Meaning: Use cloud models for classification when the local chain gives no answer. Off keeps prompt text on the machine.
- Pre-2.0 name, read for one release with a warning: `classifier_cloud_chain`, `classifier_cloud_fallback`

### `classifier.cloud.model`

- Shipped: `unset (code default)`
- Set by: `/router config set classifier.cloud.model <value>`
- Meaning: Pinned cloud classifier (`provider/id`), tried first, before the probe-verified list.
- Pre-2.0 name, read for one release with a warning: `classifier_cloud_model`

### `classifier.cloud.candidates`

- Shipped: `unset, automatic chain (code default)`
- Set by: `/router config set classifier.cloud.candidates <value>` (also in the guided menu)
- Meaning: Ordered cloud candidates (`provider/id`). Replaces the automatic chain. Each entry must be a model pi knows.
- Pre-2.0 name, read for one release with a warning: `classifier_cloud_candidates`

### `classifier.cloud.escalate_low_confidence`

- Shipped: `false (code default)`
- Set by: `/router config set classifier.cloud.escalate_low_confidence <value>`
- Meaning: Send a local reply below the confidence gate (0.5) to the cloud chain once. Then prompt text leaves the machine.
- Pre-2.0 name, read for one release with a warning: `classifier_escalate_low_confidence`

### `classifier.log.enabled`

- Shipped: `true`
- Set by: `/router config set classifier.log.enabled <value>`
- Meaning: Write the classifier decision log (`~/.pi/logs/classifier-decisions.jsonl`).
- Pre-2.0 name, read for one release with a warning: `classifier_log.enabled`

### `classifier.log.store_text`

- Shipped: `none`
- Set by: hand-edit the user layer (`router-config.user.json`)
- Meaning: How much prompt text a decision record keeps. `full` keeps prompts; hand-edit only.
- Pre-2.0 name, read for one release with a warning: `classifier_log.store_text`

### `classifier.log.max_bytes`

- Shipped: `20971520 (code default)`
- Set by: hand-edit the user layer (`router-config.user.json`)
- Meaning: Rotation size of the decision log file in bytes.
- Pre-2.0 name, read for one release with a warning: `classifier_log.max_bytes`

### `classifier.log.keep`

- Shipped: `3 (code default)`
- Set by: hand-edit the user layer (`router-config.user.json`)
- Meaning: Number of decision log files kept, including the live one.
- Pre-2.0 name, read for one release with a warning: `classifier_log.keep`

### `exclude.models`

- Shipped: `[]`
- Set by: `/router config exclude | config unexclude`
- Meaning: Model refs or globs removed from routing.

### `exclude.providers`

- Shipped: `[] (code default)`
- Set by: `/router config exclude | config unexclude`
- Meaning: Providers removed from routing.

### `context_budget.enabled`

- Shipped: `false (code default)`
- Set by: `/router config compaction on|off`
- Meaning: Cache-aware auto-compaction. Only the switch is command-settable.

### `integrations.laya.enabled`

- Shipped: `false`
- Set by: `/router config integration laya on|off`
- Meaning: Use the local Laya classifier sidecar. Needs a checkpoint when on.

### `integrations.laya.mode`

- Shipped: `shadow (code default)`
- Set by: `/router config integration laya active|shadow`
- Meaning: `active` routes on Laya results; `shadow` only records them for comparison.

### `integrations.laya.checkpoint`

- Shipped: `unset (code default)`
- Set by: hand-edit the user layer (`router-config.user.json`)
- Meaning: The model the sidecar is expected to serve, e.g. `router@1.0.0`. Required when on.

### `integrations.laya.endpoint`

- Shipped: `http://127.0.0.1:8089 (code default)`
- Set by: hand-edit the user layer (`router-config.user.json`)
- Meaning: Loopback endpoint of the Laya sidecar. Remote hosts are rejected.

### `integrations.laya.timeout_ms`

- Shipped: `1500 (code default)`
- Set by: hand-edit the user layer (`router-config.user.json`)
- Meaning: Timeout for one Laya call in milliseconds.

### `integrations.laya.confidence_threshold`

- Shipped: `0.8 (code default)`
- Set by: hand-edit the user layer (`router-config.user.json`)
- Meaning: Minimum Laya confidence for a result to enter the chain.

### `integrations.laya.compare_in_background`

- Shipped: `false (code default)`
- Set by: hand-edit the user layer (`router-config.user.json`)
- Meaning: In active mode, still run the replaced chain detached and log it as a comparator record (ADR-0027).

### `integrations.laya.observe_momentum`

- Shipped: `false (code default)`
- Set by: hand-edit the user layer (`router-config.user.json`)
- Meaning: Log detached answers for short momentum prompts (can incur classifier spend).
