# Warpforge

**One desktop command center for your projects, dev services, and coding agents.**

Warpforge is a local-first workspace orchestrator for developers who use more than one coding agent. It brings Claude Code, Codex, OpenCode, and other ACP-compatible agents into the same desktop workflow as your repositories, services, logs, ports, diffs, and git branches.

Instead of replacing the tools you already use, Warpforge is a **hybrid meta-harness** around them: your agent CLIs still do the work, while Warpforge supplies the shared workspace context, parallel execution, isolation, review surface, and an optional lead agent that can delegate to sub-agents.

> [!IMPORTANT]
> Warpforge is currently an early desktop preview. The app works from source, while signed installers, automatic updates, and polished release packaging are still in progress. The Rust TUI remains available as a companion/legacy interface.

## Why Warpforge?

AI-assisted development quickly turns into window management: an agent in one terminal, another agent in a second, app servers elsewhere, logs hidden in tabs, and multiple projects competing for the same ports.

Warpforge gives that work a shared operating layer:

- See every active agent session from Mission Control.
- Queue, filter, and review work on a task board across projects.
- Start project services and port-forwards without leaving the app.
- Give new agents the live URLs and ports of already-running services.
- Run tasks in isolated git worktrees so parallel agents do not edit the same checkout.
- Inspect the conversation, tool calls, commands, files, and diff for each task.
- Accept or reject individual diff hunks, edit files, commit, update, and push from one place.
- Let a lead agent act as an orchestrator and delegate bounded work to sub-agents.

## Bring your own agents

Warpforge does not introduce another model account or API-key layer. It discovers supported CLIs on your `PATH`, connects to them over the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/), and stores your enabled-agent selection locally.

If a supported CLI is already installed and authenticated, Warpforge can reuse that setup—no separate Warpforge credentials required.

| Agent | Detected binary | ACP command used by default |
| --- | --- | --- |
| Claude Code | `claude` | `npx @agentclientprotocol/claude-agent-acp@latest --acp` |
| Codex | `codex` | `npx @agentclientprotocol/codex-acp@latest` |
| OpenCode | `opencode` | `opencode acp` |
| Qwen Code | `qwen` | `qwen --acp` |
| Goose | `goose` | `goose acp` |

Claude Code and Codex currently use ACP adapter packages through `npx`, so their first session may need network access to fetch the adapter. Authentication behavior ultimately depends on the underlying CLI and adapter.

## The orchestrator agent

A normal Warpforge task is one conversation with one coding agent. Turn on **Orchestrator** when you want the selected agent to become a lead instead.

The lead receives two Warpforge tools:

- `spawn_agent` dispatches a sub-agent in its own session and returns immediately.
- `read_inbox` collects completed results so the lead can integrate them and decide what comes next.

This keeps orchestration inside a real agent conversation: you can continue steering the lead while its sub-agents work. Child tasks appear in Warpforge alongside the parent task, so delegation remains visible rather than disappearing into a black box.

The daemon also contains an experimental planner → worker → reviewer task-graph pipeline. Both orchestration paths are under active development.

## Core workflow

1. **Register a project.** Warpforge reads its `.workspace.yaml` and assigns it a dedicated 100-port range.
2. **Start the runtime.** Services run with dependency ordering, captured logs, interpolated environment variables, and readiness detection from ports or log patterns. Kubernetes port-forwards can live beside them.
3. **Create a task.** Choose a project and agent, attach files or images when supported, and optionally share the running-service context or create an isolated git worktree.
4. **Stay at the control layer.** Pin live sessions in Mission Control, move between tasks on the board, answer permission requests, or steer an agent with another prompt.
5. **Review the result.** Browse changed files, inspect unified or split diffs, accept/reject hunks, edit, commit, update the branch, and preview before pushing.

The Tauri desktop shell is intentionally thin. A Rust daemon owns projects, services, agent sessions, task state, and the local WebSocket API, which allows sessions to outlive a UI restart. Task history and agent configuration are persisted in `~/.warpforge/warpforge.db`.

## Getting started from source

### Prerequisites

- Rust and Cargo
- A recent Node.js/npm toolchain
- Git
- The [Tauri 2 system prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system
- At least one supported coding-agent CLI, installed and authenticated
- Optional: Docker Compose for containerized services and `kubectl` for port-forwards

### 1. Clone and build the daemon

```bash
git clone https://github.com/ephor/warpforge.git
cd warpforge
cargo build
```

### 2. Register a workspace

```bash
./target/debug/warpforge add ~/projects/my-app
```

`add` creates `.workspace.yaml` when one does not exist. Warpforge can prefill a basic configuration when it finds a `package.json` `dev` script or a Docker Compose file.

You can also initialize the current directory and register it in one step:

```bash
./target/debug/warpforge init --add
```

### 3. Start the desktop app

```bash
cd desktop
npm install
npm run tauri dev
```

The Tauri shell starts or reuses the local Warpforge daemon. On first use, select the installed agents you want Warpforge to enable.

### Build a local release binary

```bash
cd desktop
npm install
npm run tauri build
```

Release bundles/installers are not enabled in the current Tauri configuration, so this is a developer build rather than the final distribution experience.

## Workspace configuration

Warpforge keeps project-specific runtime configuration in `.workspace.yaml`:

```yaml
name: my-app

services:
  db:
    command: docker compose up postgres
    readyPattern: "database system is ready to accept connections"

  app:
    command: npm run dev
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
  custom:
    command: my-acp-agent
    description: Custom project agent
```

Each registered project receives a range beginning at port `4000`. When a service starts, Warpforge picks the first available port in that project's range, sets `PORT`, and expands `${service.port}` references in configured environment variables.

## CLI and TUI

The Rust binary still provides project management and the original terminal UI:

```bash
warpforge add <path>        # register a project
warpforge remove <name>     # unregister it
warpforge list              # list projects and port ranges
warpforge init [path]       # create .workspace.yaml
warpforge ui                # launch the TUI (also the default command)
warpforge daemon            # run the local daemon explicitly
```

The existing `install.sh` installs this Rust CLI/TUI as `wf`; it does not install the desktop app. Its published-artifact path currently supports macOS arm64 and Linux arm64 only.

## Architecture

- **Desktop:** Tauri 2, React, TypeScript, Vite, Tailwind CSS, CodeMirror
- **Core and daemon:** Rust, Tokio, SQLite, local WebSocket protocol
- **Agents:** ACP over stdio, with persisted sessions and permission flow
- **Runtime:** process-group service management, log capture, port isolation, readiness detection, Kubernetes port-forwards
- **Git workflow:** optional worktrees, file browser/editor, structured diffs, hunk resolution, commit/update/push controls
- **Terminal UI:** Ratatui, Crossterm, `portable-pty`, and `vt100`

## Current limitations

- The desktop release pipeline, signed installers, and in-app updates are not complete yet.
- Agent capabilities vary. Image input, session resume, slash commands, and permission semantics are negotiated with each ACP implementation.
- Claude Code and Codex rely on third-party ACP adapter packages invoked through `npx`.
- Auto-detection currently covers only a `package.json` `dev` script and basic Docker Compose services.
- Runtime state is local to one machine. Running processes do not survive a machine restart, and interrupted tasks depend on the agent's session-load support to resume.
- Git worktrees and orchestration are active-development features; review branches before merging or pushing.

## Status and contributions

Warpforge is pre-release software built in the open. Bug reports, design feedback, and focused pull requests are welcome. If you try it on a real multi-agent workflow, sharing what felt smooth—and what still forced you back into terminal juggling—is especially useful.

## License

[MIT](LICENSE)
