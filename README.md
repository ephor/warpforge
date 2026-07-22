<h1 align="center">Warpforge</h1>

<h2 align="center">Run parallel coding agents without losing the workspace.</h2>

<p align="center">
  A local-first desktop command center for Claude Code, Codex, OpenCode, and other coding agents—across projects, worktrees, dev services, logs, ports, diffs, permissions, and review.
</p>

<p align="center">
  <a href="https://github.com/ephor/warpforge/actions/workflows/ci.yml"><img src="https://github.com/ephor/warpforge/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/status-early_preview-7c9cff" alt="Early preview">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-8bcf6a" alt="MIT license"></a>
</p>

<p align="center">
  <a href="#getting-started-from-source">Build from source</a> ·
  <a href="#why-warpforge">Why Warpforge?</a> ·
  <a href="#bring-your-own-agents">Supported agents</a> ·
  <a href="#architecture">Architecture</a>
</p>

Warpforge keeps parallel agent work and the development environment around it in one operating layer. Run tasks across repositories, see what needs human attention, and review the commands, files, and diffs before changes move forward.

> [!TIP]
> **Agents plus their working environment.** Many tools stop at orchestrating agent sessions. Warpforge also orchestrates the runtime those agents need: `.warpforge.yaml` can declare app and dev-service commands, service dependencies, readiness signals, environment variables, and Kubernetes port-forwards. Warpforge starts configured services in dependency order, launches the declared application commands, then starts the project's port-forwards. Managed port-forwards are watched and retried with backoff if they drop, while running service URLs and resolved ports can be supplied to each new agent in its initial project context.

> [!IMPORTANT]
> Warpforge is currently an early desktop preview. The app works from source, while signed installers, automatic updates, and polished release packaging are still in progress. The Rust TUI remains available as a companion/legacy interface.

## Why Warpforge?

AI-assisted development quickly turns into window management: an agent in one terminal, another agent in a second, app servers elsewhere, logs hidden in tabs, and multiple projects competing for the same ports.

Warpforge gives that work a shared operating layer:

- Keep every active agent session visible in Mission Control instead of hunting through terminal tabs.
- Turn agent work into a cross-project task board you can queue, filter, and review.
- Bring project services and port-forwards online without reconstructing the runtime by hand.
- Give each new agent the live URLs and ports it needs, so it can work against the running app rather than guess at its environment.
- Isolate parallel tasks in git worktrees so agents can move quickly without editing the same checkout.
- See the full trail—conversation, tool calls, commands, files, and diff—before trusting the result.
- Take work from diff to branch in one place: accept or reject hunks, edit files, commit, update, preview, and push.
- Hand a larger objective to a lead agent that can delegate bounded work to visible sub-agents.

Warpforge does not replace the coding tools you already use. It is a **hybrid meta-harness** around them: the agent CLIs still do the coding, while Warpforge supplies shared workspace context, parallel execution, isolation, runtime visibility, review, and an optional lead agent that can delegate to sub-agents.

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

Warpforge keeps the whole loop—from opening a repository to shipping reviewed agent work—in one shared context:

1. **Add a project once.** Choose a folder in the desktop app. Warpforge reads or creates its `.warpforge.yaml`, registers it locally, and gives it an isolated port range.
2. **Bring its real runtime online.** Services start in dependency order with captured logs, interpolated environment variables, and readiness detection. Kubernetes port-forwards can live beside local processes.
3. **Give the agent the environment, not just a prompt.** Choose a project and agent, attach files or images when supported, share live service context, and optionally isolate the task in a git worktree.
4. **Stay in control while work runs.** Pin live sessions in Mission Control, move between tasks on the board, answer permission requests, or steer an agent with another prompt.
5. **Review before you trust.** Browse changed files, inspect unified or split diffs, accept or reject hunks, edit, commit, update the branch, and preview before pushing.

Agent work is not tied to an open window. A Rust daemon owns projects, services, sessions, task state, and the local WebSocket API, so closing or restarting the thin Tauri UI does not tear down the working context. Task history and agent configuration are persisted in `~/.warpforge/warpforge.db`.

## Getting started from source

### Prerequisites

- Rust and Cargo
- [Bun](https://bun.sh) 1.3 or newer — the desktop app's package manager and script runner
- Git
- The [Tauri 2 system prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system
- At least one supported coding-agent CLI, installed and authenticated
- Optional: Docker Compose for containerized services and `kubectl` for port-forwards

### 1. Clone and build the daemon

```bash
git clone https://github.com/ephor/warpforge.git
cd warpforge
cargo build
git config core.hooksPath .githooks   # pre-commit: fmt/clippy/lint/typecheck
```

`bun install` in `desktop/` wires the hook up too. It runs the fast CI checks
against staged files only; `git commit --no-verify` bypasses it.

### 2. Start the desktop app

```bash
cd desktop
bun install
bun run tauri dev
```

The Tauri shell starts or reuses the local Warpforge daemon. On first use, select the installed agents you want Warpforge to enable.

### 3. Add a project

Open **Projects**, select **Add Project**, and choose the project folder. The name is optional. If the project does not have a config yet, Warpforge creates `.warpforge.yaml` and can prefill basic services from a `package.json` `dev` script or a Docker Compose file.

Removing a project from Warpforge only unregisters it: it does not delete the project directory or its configuration.

The CLI remains available as an alternative:

```bash
./target/debug/warpforge add ~/projects/my-app
```

You can also initialize the current directory and register it in one step:

```bash
./target/debug/warpforge init --add
```

### Build a local release binary

```bash
cd desktop
bun install
bun run tauri build
```

Release bundles/installers are not enabled in the current Tauri configuration, so this is a developer build rather than the final distribution experience.

## Workspace configuration

Warpforge keeps project-specific runtime configuration in `.warpforge.yaml`. The alternative `.wf.yaml` and `.workspace.yaml` names are also supported:

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

### Conflict-free dev environments

Warpforge gives every project its own predictable 100-port range beginning at `4000`, so multiple projects can keep their frontend, API, database, and other services running at the same time without fighting over `3000`, `5173`, or other common defaults. For each service with a configured `port`, Warpforge picks an available port, sets `PORT`, and expands `${service.port}` references in environment variables.

Those resolved URLs become part of the live project context shared with agents. You can switch projects—or let several agents work in parallel—without stopping services, rewriting local configuration, or chasing `address already in use` errors.

## CLI and TUI

The Rust binary still provides project management and the original terminal UI:

```bash
warpforge add <path>        # register a project
warpforge remove <name>     # unregister it
warpforge list              # list projects and port ranges
warpforge init [path]       # create .warpforge.yaml
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
