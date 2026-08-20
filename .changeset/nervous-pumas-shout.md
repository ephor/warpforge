---
"warpforge": patch
---

MCP tool names no longer show as raw `mcp__server__tool` strings in the
transcript, permission prompts, or notifications. `mcp__warpforge__list_runtime`
now renders as "Warpforge · List runtime".

The orchestrator's `spawn_agent` title now surfaces who is being spawned and on
what ("Spawn agent codex: Refactor the auth module") immediately, so a
sub-agent dispatch is visible without expanding the tool.