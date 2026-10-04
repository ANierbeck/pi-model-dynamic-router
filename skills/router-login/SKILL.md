---
name: router-login
description: Guide through adding a new AI provider to pi-model-router. Keys live with Pi (ADR-0022) - this is about picking the right storage method, validating connectivity, and confirming group selection. Use when user runs /router login or wants to add a new provider.
---

# Router Login — Add a New Provider

## Overview

Walk the user through connecting a new AI provider to the model router. The
router auto-discovers models and pricing — the only thing it needs is that
**Pi can resolve an API key for the provider**.

> **ADR-0022 (2026-10-04): the router has NO credential storage of its own.**
> It never reads or writes Pi's auth store and never resolves keys itself —
> Pi resolves the key (`modelRegistry.getApiKeyForProvider`) whenever a
> request needs one. So "adding a provider to the router" is really "giving
> the key to Pi". Do not instruct users to put keys, key references, or
> `!command` entries into `router-config.json` — legacy `keys` arrays there
> are ignored.

## Steps

### 1. Identify the provider

Ask which provider to add. Show the known providers from `PROVIDER_MAP` in
`src/providers.ts` that Pi does not yet have a key for.

### 2. Obtain the API key

Guide based on provider type:

| Provider | How to get a key |
|----------|------------------|
| anthropic | https://console.anthropic.com/settings/keys — or OAuth via `pi auth anthropic` |
| openai | https://platform.openai.com/api-keys |
| google | https://aistudio.google.com/apikey |
| openrouter | https://openrouter.ai/keys |
| mistral | https://console.mistral.ai/api-keys |
| deepseek | https://platform.deepseek.com/api_keys |
| groq | https://console.groq.com/keys |
| cerebras | https://cloud.cerebras.ai/platform |
| xai | https://console.x.ai |
| chutes | https://chutes.ai/app/api-keys — subscription required |
| huggingface | https://huggingface.co/settings/tokens |

For CLI-auth providers (qwen-cli, gemini-cli):
- These use OAuth via their CLI tools, not API keys
- Auth is stored in `~/.qwen/oauth_creds.json` or `~/.gemini/oauth_creds.json`
- First-time setup: run `qwen auth login` or `gemini auth login`
- Tokens auto-refresh via the refresh_token when the CLI runs — no manual re-auth needed

For providers not listed, ask the user for:
1. The API key
2. The base URL (if non-standard)

### 3. Store the key where Pi looks for it

Any ONE of these is sufficient — Pi resolves it, the router picks it up:

**Pi's built-in auth (recommended)**
```bash
pi auth <provider-name>
```
Pi stores it in `~/.pi/agent/auth.json`. An entry may also be a `!`-prefixed
secret-manager command (e.g. `!pass show api/openrouter`) — Pi executes it.

**Environment variable**
```bash
export <PROVIDER_ENV_VAR>=sk-...   # e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY
```

**Never** store keys in `router-config.json`, and never edit Pi's auth files
by hand unless the user explicitly asks — `pi auth` is the supported path.

### 4. Restart / reload and validate connectivity

Ask the user to run `/reload` in pi (or restart). The router scans local
daemons and cloud catalogs, and every provider Pi has a key for participates
automatically. Then check:

- Does the provider appear in `/router` output?
- Are models listed for the provider?
- If models are missing: for providers without a scannable catalog
  (qwen-cli, gemini-cli, antigravity), the models must be registered in
  Pi's `models.json` (the router only uses what Pi knows — ADR-0021).

### 5. Verify pricing

Models should appear with pricing. Pricing sources (in priority order):
1. `cost_per_m` set in `model_metrics` config
2. Direct pricing from the provider's API
3. Backfill from OpenRouter's paid pricing for the same model name

If pricing still shows `$0.0` for a paid model, set `cost_per_m`
($/1M input tokens) in `model_metrics` in `router-config.json`.

### 6. Confirm group selection

The new models automatically participate in group selection based on their
quality scores (GDPval + AA capability columns):

- **strategic**: best available model (GDPval-ranked, quality window)
- **planning**: top tier only (GDPval ≥ 1700, ranked by AA-Briefcase Elo)
- **tactical**: daily coding tier (600–1700, ranked by SciCode/Terminal-Bench)
- **operational / scout / fallback**: billing-preference-ranked cheap tiers

Ask: "Run `/router` to verify the new models appear in the appropriate groups."

## Checklist

- [ ] Provider identified
- [ ] API key obtained (or CLI OAuth completed)
- [ ] Key stored with Pi (pi auth / env var / CLI auth) — NOT in router-config.json
- [ ] Connectivity validated — models discovered or present in Pi's models.json
- [ ] Pricing verified — not showing $0.0 for paid models
- [ ] Group selection confirmed — models appear in expected tiers
