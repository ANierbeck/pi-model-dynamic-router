# Claude Model Support in pi-model-dynamic-router

## Claude-bridge Extension Integration

The router works seamlessly with the **claude-bridge** Pi extension to provide access to Claude models via subscription.

### Key Features

- **No Double Registration**: The router does NOT register claude-bridge providers itself
- **Automatic Discovery**: Claude-bridge models appear in `/router` when the extension is loaded
- **Seamless Fallback**: Rate limit/subscription errors trigger automatic fallback to next model
- **GDPval Scores**: Built-in scores for new Claude models

### Supported Claude Models

| Model | GDPval Score | Notes |
|-------|-------------|-------|
| claude-sonnet-5 | 1603 | Available in Pro tier |
| claude-fable-5 | 1747 | Available in Max tier |
| claude-opus-5 | 1860 | Available in Max tier |
| claude-3-sonnet | 1450 | Legacy model |
| claude-3-haiku | 1200 | Legacy model |

### Subscription Tiers

| Tier | Models Available | Notes |
|------|-----------------|-------|
| **Pro** | Claude 3.5 Sonnet, Haiku | Basic subscription |
| **Max** | All models including Fable 5, Opus 5 | Premium subscription |

### Configuration

The router automatically discovers claude-bridge models when the extension is installed. No additional configuration is required.

### Rate Limit Handling

The router recognizes Claude subscription/rate limit errors:

- "Warning: [rate-limit] Claude five_hour rate limit hit"
- "You've hit your monthly spend limit"
- "Claude rate limit warning"
- "Claude Code returned an error result"

These errors are treated as **soft failures** and trigger automatic fallback to the next model.

### Usage

1. Install the **claude-bridge** extension
2. Set up your Claude subscription
3. Use the router as normal - Claude models will appear automatically
4. Monitor `/router` to see available Claude models

### Troubleshooting

#### Issue: Claude models not appearing
**Solution**: 
- Ensure claude-bridge extension is installed
- Check that your subscription is active
- Run `/router reload` to refresh the model list

#### Issue: Rate limit errors
**Solution**: 
- The router automatically falls back to next model
- Check your subscription tier and usage
- Consider upgrading to Max tier for more capacity

### For More Information

- **Full Documentation**: See [README.md](README.md)
- **PI Integration**: See [PI.md](PI.md)
- **Skill Reference**: See [SKILL.md](SKILL.md)

## Example Configuration

```json
{
  "model_groups": {
    "strategic": {
      "description": "Best models by GDPval",
      "method": "best",
      "models": [
        "claude-bridge/claude-opus-5",
        "claude-bridge/claude-fable-5",
        "claude-bridge/claude-sonnet-5",
        "anthropic/claude-3-sonnet",
        "mistral/mistral-medium-3.5"
      ],
      "fallback_groups": ["tactical", "operational", "scout", "fallback"]
    }
  },
  "gdpval_builtin": {
    "claude-sonnet-5": 1603,
    "claude-fable-5": 1747,
    "claude-opus-5": 1860
  }
}
```

## Best Practices

1. **Order models by preference** in your groups (most preferred first)
2. **Include fallback models** from different providers
3. **Use cascading fallback groups** for maximum reliability
4. **Check `/usage-credits`** if you consistently hit limits
5. **Monitor `/router`** to see which models are available and healthy
