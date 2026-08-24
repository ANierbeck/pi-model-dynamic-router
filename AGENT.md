# AI Agent Quick Reference: pi-model-dynamic-router

## What This Extension Does

This Pi extension dynamically routes model group names to concrete provider/model pairs, balancing intelligence (GDPval), cost, and availability.

### Key Features

- **Dynamic Routing**: Automatically classifies prompts and selects optimal models
- **Cascading Fallback**: Automatic recovery from model failures, rate limits, and unavailability
- **Cost Optimization**: Intelligent model selection based on task complexity
- **Model Momentum**: Maintains consistency after context compaction
- **Status Line Integration**: Shows accurate active model in real-time

## Quick Start for Agents

### 1. Understanding the Model Groups

| Group | Purpose | Typical Models |
|-------|---------|----------------|
| **strategic** | Best models by GDPval | Claude Opus, Mistral Medium |
| **tactical** | Top quality, cost-optimized | Claude Sonnet, Mistral Medium |
| **operational** | Good quality, cheapest | Ollama, Mistral Small |
| **scout** | Acceptable quality, cheapest | Free tier models |
| **fallback** | Any available model | Last resort |
| **dynamic** | Auto-classifies prompts | Uses content-based routing |

### 2. Dynamic Routing Categories

The `dynamic` group classifies prompts into these categories:

| Category | Maps To | Example Use Cases |
|----------|---------|-------------------|
| `code_simple` | operational | Syntax fixes, typos, 1-10 line changes |
| `code_complex` | tactical | Refactoring, debugging, >50 line changes |
| `design` | strategic | Architecture, system design, API design |
| `planning` | tactical | Project planning, roadmaps, task breakdown |
| `exploration` | scout | Research, brainstorming, unclear requirements |
| `fallback` | fallback | Unclear or multi-category requests |

### 3. Requirements

For **dynamic routing** to work:
- Ollama must be installed and running (`ollama serve`)
- Required models: `gemma4:12b-mlx` (primary) and `gemma2:2b` (fallback)
- Install models: `ollama pull gemma4:12b-mlx` and `ollama pull gemma2:2b`

### 4. Common Commands

| Command | Description |
|---------|-------------|
| `/router` | Show status of all model groups |
| `/router <group>` | Detailed view of a specific group |
| `/router scan` | Re-scan models and GDPval scores |
| `/router reload` | Hot-reload config and cache |

### 5. Tools for Agents

| Tool | Purpose |
|------|---------|
| `set_model_from_group` | Switch to best model from a group |
| `resolve_model_group` | Preview what a group resolves to |
| `update_model_metrics` | Manual metric override |

### 6. Configuration Files

- **`router-config.json`**: Main configuration (providers, groups, metrics)
- **`.cache/scan-cache.json`**: Persistent cache (GDPval, pricing, models, **per-model capabilities**)
- **`model-map.yaml`**: Model to GDPval slug mappings

### Provider Registration (how the router talks to Pi)

- **Never overwrites**: the router only registers a provider with Pi when Pi does **not** know it yet. `models.json` entries (with `compat` flags), extension providers, and Pi-native providers are protected.
- **Real capabilities**: when registering, uses the real per-model capabilities the scan captured (Mistral `capabilities.*`, OpenRouter `architecture.input_modalities`, Ollama `/api/show` `model_info.*.context_length`) — not hardcoded defaults. Conservative: `vision: false` unless confirmed (prevents 422 errors from false claims).
- **Ollama setup-independent**: scrapes `/api/show` live for real `num_ctx` so prompts >32K don't truncate; works with or without any specific Ollama extension.
- **Optional `modelFilter`**: `PROVIDER_MAP` entries may set a regex to constrain which scanned model ids are kept (generic, user-configurable).

### 7. Troubleshooting

#### Issue: Model gets stuck in repetition loop
**Solution**: The router now includes a **repetition guard** that detects when a model repeats the same phrase 6+ times and automatically switches to the next candidate.

#### Issue: Rate limits or subscription errors
**Solution**: The router automatically detects rate limit errors and falls back to the next model in the group, then cascades to fallback groups if needed.

#### Issue: Context overflow errors
**Solution**: The router detects context overflow and triggers Pi's native compaction before trying the next model.

### 8. For More Information

- **Full Documentation**: See [README.md](README.md)
- **PI Integration**: See [PI.md](PI.md)
- **Skill Reference**: See [SKILL.md](SKILL.md)
- **Architecture**: See [docs/architecture.md](docs/architecture.md)

## Best Practices for Agents

1. **Use the `dynamic` group** for general-purpose tasks - it automatically selects the best model based on content
2. **Use specific groups** when you know the task type (e.g., `strategic` for design, `operational` for simple code)
3. **Check `/router`** to see available models and their status
4. **Use `/router reload`** after configuration changes
5. **Monitor the status line** to see which model is actually active

## Example Workflow

```
User: "Help me design a new API architecture"
Agent: Uses `/router dynamic` to classify as `design` → routes to `strategic` group
Router: Selects best strategic model (e.g., Claude Opus)
Result: High-quality architectural design response
```

## Support

For issues or questions:
- Check the [TODO.md](TODO.md) for known issues
- Review the [CHANGELOG.md](CHANGELOG.md) for recent changes
- See [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) for deployment notes
