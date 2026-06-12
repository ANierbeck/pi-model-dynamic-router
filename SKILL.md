---
name: pi-model-router
description: Dynamically routes model groups (strategic/tactical/operational/scout/fallback) to concrete models. Balances intelligence, cost, and availability.
---

# pi-model-router

**Purpose**: Routes model group names (e.g., `strategic`, `tactical`) to concrete provider/model pairs. Auto-discovers models, pricing, and GDPval scores to balance intelligence, cost, and availability.

## Features
- **Auto-Discovery**: Scans for models from 20+ providers (Anthropic, OpenAI, Mistral, etc.).
- **Dynamic Routing**: Uses content-based classification to select the best model group for a prompt.
- **Rate Limits**: Automatic key rotation and exponential backoff on 429 errors.
- **Cost Optimization**: Prefers subscription models and applies cost multipliers to rate-limited providers.

## Commands
| Command | Description |
|---------|-------------|
| `/router` | Show status of all model groups. |
| `/router <group>` | Details for a specific group (e.g., `/router strategic`). |
| `/router scan` | Re-scan models and GDPval scores. |
| `/router reload` | Reload config and cache. |

## Tools
- `set_model_from_group`: Switch to the best model from a group.
- `resolve_model_group`: Preview what a group resolves to.
- `update_model_metrics`: Manually override model metrics.

## Files
- `index.ts`: Core router logic.
- `router-config.json`: Provider and group configuration.
- `model-map.yaml`: Model to GDPval slug mappings.
- `src/dynamic-classifier.ts`: Content-based prompt classification.