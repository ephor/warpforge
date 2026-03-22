# warpforge

**The missing workspace layer for AI-assisted development.**

You're coding with AI agents — claude in one window, codex in another, services in a third, logs in a fourth. Constant cmd+tab. Lost context. Every project fighting over port 3000.

warpforge puts it all in one terminal.

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/ephor/warpforge/main/install.sh | bash
```

Or build from source:

```bash
cargo build --release
ln -sf "$(pwd)/target/release/warpforge" ~/.local/bin/wf
```

## Quick Start

```bash
wf add ~/projects/my-app
wf add ~/projects/my-api
wf
```

## Configuration

`.workspace.yaml` in your project root:

```yaml
name: my-app

services:
  db:
    command: docker compose up postgres
    readyPattern: "database system is ready to accept connections"

  app:
    command: bun run dev
    dependsOn: [db]
    env:
      DATABASE_URL: postgres://localhost:${db.port}/myapp

portforwards:
  - name: staging-db
    namespace: postgres
    pod: postgres-cluster-pooler
    localPort: 5432
    remotePort: 5432

agentTemplates:
  dev:
    command: claude
  codex:
    command: codex
```

Port isolation is automatic — each project gets a dedicated 100-port range. `${db.port}` resolves to the allocated port, no manual config.

## Keys

| Key | Action |
|---|---|
| `j/k` | Navigate |
| `Enter` | Open project / service detail |
| `s` | Services mode |
| `p` | Port-forwards mode |
| `n` | New agent |
| `i` | Type into agent |
| `Esc` | Back |
| `q` | Quit |

## Stack

Rust · Ratatui · portable-pty · vt100 · Tokio
