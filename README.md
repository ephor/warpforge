<h1 align="center">Warpforge</h1>

<h2 align="center">Run parallel coding agents without losing the workspace.</h2>

<p align="center">
  An open-source, local-first agentic development environment for Claude Code, Codex, OpenCode, and other coding agents — one workspace for agent workflows, projects, dev services, ports, files, diffs, and human review.
</p>

<p align="center">
  <a href="https://github.com/ephor/warpforge/releases/latest"><img src="https://img.shields.io/github/v/release/ephor/warpforge?display_name=tag&label=download%20for%20macOS&color=7c9cff" alt="Latest release"></a>
  <a href="https://github.com/ephor/warpforge/actions/workflows/ci.yml"><img src="https://github.com/ephor/warpforge/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-8bcf6a" alt="MIT license"></a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#why-warpforge">Why Warpforge?</a> ·
  <a href="#bring-your-own-agents">Agents</a> ·
  <a href="#the-orchestrator-agent">Orchestrator</a> ·
  <a href="#workflow-pipelines">Workflows</a> ·
  <a href="#projects-and-their-runtime">Projects &amp; runtime</a> ·
  <a href="#build-from-source">Build from source</a>
</p>

<p align="center">
  <img src="docs/images/task-detail.png" alt="Warpforge task view: agent conversation, live diff, and staged changes" width="100%">
</p>

Warpforge is an **agentic development environment (ADE)**: the operating layer around your coding agents. Agent conversations, project runtime, isolated worktrees, live services, configurable multi-agent workflows, and human review live in one place — so running several agents does not turn into managing several terminals.

It does not replace Claude Code, Codex, or OpenCode; those tools still do the coding. Warpforge gives them shared project context, parallel execution, runtime visibility, and a reviewable path from prompt to commit. Everything runs on your machine: there is no separate Warpforge account or API key, and your existing agent authentication stays with the underlying CLI.

## Install

### macOS Apple Silicon

1. Open the [latest Warpforge release](https://github.com/ephor/warpforge/releases/latest).
2. Download `Warpforge_<version>_aarch64.dmg`.
3. Open the DMG and drag **Warpforge** into **Applications**.
4. Launch it and select the coding agents you want enabled.

The build is signed with a Developer ID certificate and notarized by Apple, so it opens without Gatekeeper workarounds. It needs macOS 11 or newer on an Apple Silicon Mac and ships its own daemon — no Rust toolchain or source checkout required.

**Updates are built in and signed.** Warpforge checks the release feed shortly after its daemon comes up, and on demand from the app. Downloading and installing are always explicit actions — nothing installs in the background. An update carries both the desktop UI and its matching daemon, verifies an exact version and protocol handshake, and is refused with a clear list of blockers while agent tasks or runtime transitions are still active rather than interrupting work.

> [!NOTE]
> macOS on Apple Silicon is the validated desktop target. Windows and Linux packaging exists as an opt-in release preview, but those platforms have not been tested on real machines and are not claimed as publicly supported.

### Reuse your existing agent login

Warpforge adds no model account or API-key layer. It looks for supported agent binaries on your `PATH`, speaks the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) to them over stdio, and stores your enabled-agent selection locally. If Claude Code, Codex, or OpenCode is already installed and authenticated, that setup is reused as-is — the CLI keeps owning authentication, model access, and the coding itself.

## Why Warpforge?

AI-assisted development becomes a coordination problem long before it becomes a model problem:

- one agent is editing while another waits for permission;
- a third needs the app server and its real URL;
- logs are hidden in terminal tabs;
- two projects both assume port `3000`;
- completed work is scattered across chats, worktrees, and diffs.

Warpforge turns that sprawl into one visible workflow:

- **Mission Control for active work.** Running, blocked, interrupted, and review-ready sessions across every project, with live conversation previews — no hunting through terminals.
- **The environment travels with the task.** Agents receive live service URLs, resolved ports, files, and project context instead of guessing how to run the app.
- **Parallel work without checkout collisions.** A task can run in its own git worktree while staying attached to the same project.
- **Human control at the moments that matter.** Permission requests, commands, tool calls, changed files, and diffs stay visible before work moves forward.
- **From agent output to a reviewed branch.** Unified or split diffs, hunk-level accept/reject, inline edits, commit, update, push, and pull request from the same workspace.
- **A lead agent when the task outgrows one session.** An orchestrator delegates bounded work to sub-agents, and every child task stays visible.
- **Repeatable workflows when a prompt is not enough.** Put different agents and models into explicit plan, implement, review, and fix stages; Warpforge drives the transitions and stops when a human decision is needed.

That combination is what makes Warpforge an ADE rather than another coding agent: part cross-harness orchestrator, part project runtime, part review surface.

## Bring your own agents

Warpforge detects agents as globally installed binaries and spawns them directly — no `npx` at session start, so the first prompt is never blocked on a package download.

| Agent | Binary | Default ACP command | Install integration |
| --- | --- | --- | --- |
| Claude Code | `claude-agent-acp` | `claude-agent-acp --acp` | `npm install -g @agentclientprotocol/claude-agent-acp` |
| Codex | `codex-acp` | `codex-acp` | `npm install -g @agentclientprotocol/codex-acp` |
| OpenCode | `opencode` | `opencode acp` | `npm install -g opencode-ai` |
| Qwen Code | `qwen` | `qwen --acp` | `npm install -g @qwen-code/qwen-code` |
| Goose | `goose` | `goose acp` | `brew install block-goose-cli` |

Claude Code and Codex reach ACP through small adapter binaries. Warpforge shows whether each agent is present, which version is installed, and whether a newer one exists — and installs or updates it in one click from the agent panel. Any other ACP-compatible agent can be added with a custom command, globally or per project through `agentTemplates`.

Agent capabilities vary. Image input, session resume, slash commands, model selection, and permission semantics are negotiated with each ACP implementation.

## Orchestration and workflows

Warpforge supports two complementary ways to coordinate agents.

<p align="center">
  <img src="docs/images/new-task.png" alt="New task composer in orchestrator mode, choosing the lead agent and previewing the delegated split" width="100%">
</p>

### The orchestrator agent

A regular Warpforge task is one conversation with one coding agent. Enable **Orchestrator** and that agent becomes a lead with three Warpforge tools:

- `spawn_agent` — dispatch a bounded task to Claude Code, Codex, OpenCode, or any configured harness, and return immediately;
- `message_agent` — send a follow-up into an existing sub-agent's session, in context;
- `read_inbox` — drain finished results and decide what happens next.

Orchestration stays inside a real conversation you can keep steering while child agents work. Sub-agents appear as normal Warpforge tasks linked to their parent, so you can see which harness is running, what it changed, and where human attention is needed instead of sending work into a black box.

### Workflow pipelines

For repeatable work, choose one of the built-in **Plan + implement + review loop** or **Implement + review loop** workflows. The daemon—not a manager model—drives the fixed `plan? → implement → review ⇄ fix` sequence. Each stage is a visible child task with its own agent session, and each stage can use a different configured agent and model. Multiple reviewers can run in a review round, findings can point to exact lines, and repair rounds continue until approval or a configured limit.

Workflows pause at safe boundaries, survive a daemon restart, and stop for structured human input when an agent asks a question or the review limit is reached. A completed pipeline never commits automatically; it lands in **Needs review** with its chats, timeline, and diff available for inspection.

<p align="center">
  <img src="docs/images/workflow-pipeline.png" alt="Workflow pipeline with implement, review, and fix stages and a reviewer verdict" width="100%">
</p>

Workflow definitions are versioned YAML files in `.warpforge/workflows/`. Built-ins can be copied into a project and customized there, so the process travels with the code instead of living in one person's UI settings.

## Projects and their runtime

**Register a project once.** In **Projects → Add Project**, pick a folder. Warpforge keeps a local registry and reads or creates `.warpforge/workspace.yaml` — optionally prefilled from a `package.json` `dev` script or a Docker Compose file, or generated interactively by an agent in the bootstrap wizard. Existing `.warpforge.yaml`, `.wf.yaml`, and `.workspace.yaml` files remain supported. Removing a project only unregisters it; the directory and its config stay untouched.

**Bring the real runtime online.** Services start in dependency order with captured logs, interpolated environment variables, and readiness detection. Kubernetes port-forwards run alongside local processes and are watched and retried with backoff when they drop. Each project also has interactive terminals inside the app, so a quick `git log` or one-off script does not need another window.

**Work survives the window.** A local Rust daemon owns projects, services, sessions, and task state behind a WebSocket API; the Tauri app is a thin client. Close or restart it and long-running work continues. Task history and agent configuration persist in `~/.warpforge/warpforge.db`, the project registry in `~/.warpforge/projects.json`.

**Review, commit, ship.** Browse changed files, read unified or split diffs, accept or reject individual hunks, edit files inline, draft a commit message, commit or amend, update the branch, push with `--force-with-lease`, and open a pull request through the GitHub CLI.

### No port roulette

Every registered project gets a predictable 100-port range beginning at `4000`. That is not a registry detail — it is what makes parallel work practical: multiple projects, and multiple agent-built previews inside them, stay online together without fighting over `3000`, `5173`, or other common defaults.

For services with a configured port, Warpforge selects an available value in the project's range, sets `PORT`, and expands references such as `${app.port}` in environment variables. The resolved URLs become part of the live context handed to new agent sessions. You can switch projects and come back without stopping unrelated services, rewriting configuration, or chasing `address already in use`.

### Workspace configuration

Project runtime lives in `.warpforge/workspace.yaml`. The legacy `.warpforge.yaml`, `.wf.yaml`, and `.workspace.yaml` names are also supported.

```yaml
name: my-app

services:
  db:
    command: docker compose up postgres
    port: 5432
    readyPattern: "database system is ready to accept connections"

  app:
    command: npm run dev
    port: 3000
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

## Build from source

Only needed to develop Warpforge itself or to run it where no build is published. The [installer](#install) is the recommended path.

### Prerequisites

- Rust and Cargo
- [Bun](https://bun.sh) 1.3 or newer
- Git
- [Tauri 2 system prerequisites](https://v2.tauri.app/start/prerequisites/)
- At least one supported coding-agent CLI, installed and authenticated
- Optional: Docker Compose, `kubectl`, and `gh` for pull requests

### Run the desktop app

```bash
git clone https://github.com/ephor/warpforge.git
cd warpforge/desktop
bun install
bun run tauri dev
```

The Tauri shell builds and starts the matching Rust daemon as a sidecar. `bun install` also wires up the pre-commit hook that runs the fast CI checks against staged files.

### Run the checks

```bash
cargo test --locked

cd desktop
bun run test
bun run typecheck
bun run lint
```

### Build a local desktop bundle

```bash
cd desktop
bun run tauri build
```

Official releases additionally use protected updater signing keys, Developer ID signing, Apple notarization, immutable release tags, and draft-asset verification in GitHub Actions — see [docs/RELEASING.md](docs/RELEASING.md).

## CLI and terminal UI

The Rust binary also manages projects directly and can run the daemon by hand:

```bash
warpforge add <path>        # register a project
warpforge remove <name>     # unregister it
warpforge list              # list projects and port ranges
warpforge init [path]       # create workspace config (--add also registers it)
warpforge bootstrap [path]  # generate a config interactively with an agent
warpforge daemon            # run the local daemon explicitly
warpforge ui                # terminal UI companion
```

`install.sh` installs this CLI as `wf` from published archives; it does not install the desktop app, and the current release publishes a macOS Apple Silicon archive only. The Ratatui terminal UI is kept as a companion — the desktop app is where development happens.

## Architecture

- **Desktop:** Tauri 2, React, TypeScript, Vite, Tailwind CSS, CodeMirror, xterm.js
- **Core and daemon:** Rust, Tokio, SQLite, local WebSocket protocol, daemon bundled as a sidecar in packaged builds
- **Agents:** ACP over stdio, persisted sessions, capability negotiation, permission flow, orchestrator MCP tools
- **Runtime:** process-group service management, log capture, port isolation, readiness detection, Kubernetes port-forwards, interactive PTYs
- **Git workflow:** optional worktrees, file browser/editor, structured diffs, hunk resolution, commit/update/push, pull requests via `gh`
- **Release:** Developer ID signing, Apple notarization, signed updater artifacts, checksummed assets

## Current scope

Warpforge is young software, shipped and built in the open:

- macOS Apple Silicon is validated; Windows and Linux remain unvalidated previews;
- automatic config detection covers a `package.json` `dev` script and basic Docker Compose services, with the bootstrap wizard for anything richer;
- runtime state is local to one machine, and running processes do not survive a machine restart;
- interrupted task recovery depends on the underlying agent's session-load support;
- worktrees and multi-agent orchestration are powerful but still evolving — review branches before merging or pushing.

Bug reports, design feedback, and focused pull requests are welcome. If you use Warpforge on a real multi-agent workflow, sharing what felt smooth — and what still sent you back to terminal juggling — is especially useful. Release notes live in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
