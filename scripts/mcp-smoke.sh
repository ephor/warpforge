#!/usr/bin/env bash
# Smoke-test the orchestrator MCP server (`wf __mcp-orchestrator`) against a
# running daemon. Feeds MCP JSON-RPC on stdin, prints the server's replies.
#
# Prereqs:
#   1. Build:  cargo build
#   2. Run the daemon in another terminal:  ./target/debug/warpforge daemon
#      (publishes ~/.warpforge/daemon.json — the bridge connects back to it)
#
# Usage:
#   scripts/mcp-smoke.sh [project]            # read-only: initialize, tools/list, read_inbox
#   scripts/mcp-smoke.sh [project] --spawn    # ALSO calls spawn_agent (creates a real task!)
#
# Env overrides: WF_BIN (path to the binary).
set -euo pipefail

BIN="${WF_BIN:-./target/debug/warpforge}"
PROJECT="${1:-demo}"
SPAWN="${2:-}"

if [ ! -f "$HOME/.warpforge/daemon.json" ]; then
  echo "✗ no ~/.warpforge/daemon.json — start the daemon first: $BIN daemon" >&2
  exit 1
fi
if [ ! -x "$BIN" ]; then
  echo "✗ binary not found at $BIN — run: cargo build" >&2
  exit 1
fi

export WF_ORCH_TASK="smoke-$$"       # dummy parent id; read_inbox on it returns empty
export WF_ORCH_PROJECT="$PROJECT"

# Build the request sequence.
reqs=(
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_inbox","arguments":{}}}'
)
if [ "$SPAWN" = "--spawn" ]; then
  echo "⚠ --spawn: this will create a real sub-agent task in project '$PROJECT'." >&2
  reqs+=('{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"spawn_agent","arguments":{"agent":"claude","task":"reply with the single word: pong"}}}')
fi

echo "→ WF_ORCH_TASK=$WF_ORCH_TASK  project=$PROJECT" >&2
printf '%s\n' "${reqs[@]}" | "$BIN" __mcp-orchestrator | (
  if command -v jq >/dev/null 2>&1; then jq -c .; else cat; fi
)
