
## Project: Warpforge

TUI-based workspace orchestrator. Manages multiple dev projects: isolated services with auto-resolved ports, embedded agent terminals (claude, codex), instant context switching.

### Architecture

- **Language:** Rust
- **Async runtime:** Tokio
- **TUI:** Ratatui + Crossterm
- **PTY:** `portable-pty` — real TTY for spawned agents
- **Terminal emulation:** `vt100` crate — parses ANSI into screen buffer, rendered cell-by-cell into ratatui `Buffer` via `TerminalPane` widget
- **CLI:** `clap` derive API
- **Config:** `.workspace.yaml` per project (serde_yaml), registry in `~/.warpforge/projects.json`
- **Port isolation:** each project gets 100-port range (4000+), `${svc.port}` interpolation in env vars
- **Binary:** `cargo build --release` → `target/release/warpforge`

**Key crates:** ratatui 0.29, crossterm 0.28 (event-stream), portable-pty 0.8, vt100 0.15, tokio, clap 4, serde, anyhow

### Source layout (`src/`)

```
main.rs          — CLI entry (clap), subcommands: add, remove, list, ui
app.rs           — TUI event loop (tokio::select), AppState, InputMode (Navigate/Terminal), key handling
agent.rs         — AgentManager: PTY spawn via portable-pty, vt100 parser, input/output channels
service.rs       — ServiceManager: sh -c spawn, stdout/stderr log capture, process-group kill, port allocation
config.rs        — .workspace.yaml parsing + auto-detect (package.json scripts, docker-compose)
registry.rs      — ~/.warpforge/projects.json CRUD
ports.rs         — Port range allocation (4000+), ${svc.port} env interpolation
tui/
  mod.rs         — render dispatch (Dashboard vs Project screen)
  dashboard.rs   — Project list with service/agent status, j/k nav, Enter to open
  project.rs     — Split layout: sidebar (services + agents) + right pane (terminal or logs)
  terminal.rs    — TerminalPane widget: vt100 Screen → ratatui Buffer (cell-by-cell, colors, cursor)
```

### What Works (Rust)

- **CLI:** `warpforge add/remove/list` — project registry CRUD
- **TUI dashboard:** project list with service status, agent elapsed time, j/k navigation
- **TUI project view:** sidebar (services + agents list) + agent terminal or logs pane
- **Agent terminal:** portable-pty + vt100 renders full-color terminal with cursor, bold, italic, underline, inverse
- **Agent input mode:** `i` enters terminal mode (all keys forwarded to PTY), `Esc` exits
- **Multi-agent tabs:** `Tab` cycles, `1-9` direct switch, `n` spawns new claude session, `x` kills
- **Service management:** auto-start on project open (from .workspace.yaml), `u/d` start/stop individual services
- **Service logs:** `l` toggles logs pane, scroll with j/k, `[/]` switch between services
- **Port isolation:** per-project 100-port ranges, env interpolation
- **Process cleanup:** process-group kill (`kill -9 -<pgid>`) for service subtrees, PTY drop on agent kill

### Known Issues / TODO

- **Agents killed on Esc (back to dashboard):** `handle_project_key` calls `agents.kill_project_agents()` + `services.stop_project()` when pressing Esc. Agents and services should persist across screen navigation.
- Process cleanup may not catch all orphans in edge cases
- No `wf up/down/status/ports` CLI commands yet (only TUI + add/remove/list)
- Config auto-detection limited to package.json `dev` script and docker-compose
- No state persistence between separate warpforge processes

### Key Design Decisions

- **Ratatui + vt100** for terminal-in-terminal: native cell-by-cell rendering with zero translation layer. Previous TypeScript/OpenTUI attempt couldn't render ANSI properly.
- **vt100 + TerminalPane:** Agent PTY output → `vt100::Parser::process()` → `Screen` → iterate cells with colors/attributes → write directly to ratatui `Buffer`. Cursor rendered via `Modifier::REVERSED`.
- **portable-pty:** Cross-platform PTY. Reader/writer in `spawn_blocking` tasks, input via `mpsc::unbounded_channel`.
- **Process groups:** Services spawn with `process_group(0)` so `kill -9 -<pgid>` kills sh→npm→node tree.
- **Event-driven rendering:** `tokio::select!` on crossterm events + agent PTY data + service log events. No polling.
- **`sh -c "<command>"`** for services — commands can contain pipes, `&&`, `cd`, etc.
- **Navigate/Terminal input modes:** Navigate = TUI keys (j/k/Tab/n/x), Terminal = raw PTY forwarding. `Esc` always exits terminal mode, `Ctrl+C` always quits app.

### Build & Run

```bash
cargo build --release
# or during dev:
cargo run
```
