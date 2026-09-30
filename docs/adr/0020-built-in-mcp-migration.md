# ADR-0020: Migration to Pi Built-in MCP (Retiring pi-mcp-adapter)

## Status

Accepted (2026-09-30; migration executed — see the status block in `docs/plans/2026-09-30-pi-0.99.1-update-and-mcp-migration.md`)

## Context

Pi 0.87.1 had no built-in MCP support, so the **pi-mcp-adapter** extension wrapped the four MCP servers (home-assistant, apple-mcp-secure, playwright, ponymail) and exposed them to pi under `~/.pi/agent/mcp-adapter.json`, with tool names in the `mcp__<server>__<tool>` shape.

Pi 0.99.1 ships **built-in MCP**: server config lives in `~/.pi/agent/mcp.json` (`mcpServers` with `command`/`args`/`env` or remote `url` entries), tool names keep the same `mcp__<server>__<tool>` shape, `pi mcp list` shows connection state, and `~/.pi/agent/mcp-cache.json` is the built-in's tool cache.

During the update window both stacks ran in parallel (the adapter warned about `mcp.json` and tried to merge/remove it) — the runbook's Task 1 Step 0 (parking `mcp.json` before the update) was not executed, which made the parallel phase visible but caused no damage.

## Decision Drivers

- One canonical MCP stack; two parallel stacks produce merge warnings, stale tool caches, and ambiguous tool ownership.
- Tool references in skills and agent configs (e.g. the email skill's `mcp__apple-mcp-secure__mail`) must keep working — the naming must not change.
- home-assistant should be reachable via Tailscale from any network, not LAN-only (owner decision, 2026-09-30).
- Rollback to 0.87.1 must remain possible for a transition period.

## Options Considered

1. **Built-in MCP only (chosen).** Uninstall pi-mcp-adapter, move server config to `mcp.json`. Pros: canonical stack, one less extension to update on every pi upgrade, native remote-URL servers. Cons: none observed after migration; all four servers connected via `pi mcp list`.
2. **Keep the adapter.** Rejected: redundant with built-in, actively fights over `mcp.json`, one more moving part per upgrade.
3. **Run both in parallel.** Rejected: the exact state that produced merge warnings and ambiguous tool ownership during the window; also risks a stale adapter cache shadowing built-in tools.

## Decision

Built-in MCP only. pi-mcp-adapter is uninstalled (`pi uninstall npm:pi-mcp-adapter`); server config lives in `~/.pi/agent/mcp.json` with the same tool naming as before, so skill/agent references needed no renaming. Backups of the adapter state were kept (`~/.pi/agent/mcp-adapter.json.bak`, `~/.pi/agent/mcp-cache.json.bak`) for a 0.87.1 rollback. home-assistant uses the Tailscale MagicDNS webhook URL (owner decision). The email skill was migrated to the built-in naming (`mcp__apple-mcp-secure__mail`, backup `SKILL.md.bak-20260930`). No `mcp:` selectors exist in any agent config, so pi-subagents is unaffected.

## Consequences

- One MCP stack; `pi mcp list` is the health check; `mcp-cache.json` now belongs to the built-in (do not delete it thinking it is adapter leftover).
- Tool naming `mcp__<server>__<tool>` is now a **Pi contract**, not an adapter convention — agent/skill references depend on Pi keeping it stable across upgrades.
- On a 0.87.1 rollback the adapter must be reinstalled and its `.bak` configs restored (runbook rollback section).
- pi-work containers were unaffected (no `mcp:` selectors anywhere).
