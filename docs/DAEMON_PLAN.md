# Warpforge daemon/desktop pivot — audit & refactor plan

Status: proposal. Code in this branch: `crates/warpforge-protocol` (daemon API
wire types, compiling + tested) and `desktop/` (Tauri shell scaffold, thin
client only). The daemon itself is **not** implemented yet — the open
questions at the bottom gate that work.

---

## 1. Audit of the current codebase

~3,100 lines, one binary. Verdict up front: **the code splits cleanly; no
rewrite is needed.** The managers are already daemon-shaped. What has to
change is a handful of places where UI state is abused as system state, plus
one honest correction to the project brief:

### ⚠ There is no ACP integration today

The brief says ACP integration with Claude Code / Codex is "functionally
working already." It is not in this codebase. `src/agent.rs` spawns the agent
CLI (`claude`, `codex`, anything from `agentTemplates`) inside a **raw PTY**
and renders it via vt100. "Needs review" detection is substring matching on
scrollback (`REVIEW_PATTERNS`: `"[Y/n]"`, `"Do you want to"`, …). There is no
JSON-RPC, no session/update stream, no structured tool calls or file edits
anywhere.

Consequence for the plan: ACP is **new work, not extraction** (Stage 4 below).
The good news is that nothing needs to be untangled to add it — the PTY path
and the ACP path can coexist, and the PTY path stays useful for arbitrary
interactive tools. The bar "no bespoke per-agent code" is achievable because
ACP itself is the abstraction: one `AcpSessionManager` speaking the protocol
over the child process's stdio, agnostic to which agent binary is on the
other end.

### Already daemon-shaped (keep as-is, move behind the API)

| Module | Notes |
|---|---|
| `service.rs` (`ServiceManager`) | Owns child processes, process-group kill, log ring buffers, emits `ServiceEvent` over an mpsc channel. Zero TUI imports. |
| `portforward.rs` (`PortForwardManager`) | kubectl watcher tasks with retry/backoff, emits `PfEvent`. Zero TUI imports. |
| `ports.rs` | Global allocation map + bind-probe. Zero TUI imports. |
| `registry.rs`, `config.rs` | Pure persistence/parsing (`~/.warpforge/projects.json`, `.workspace.yaml`, auto-detect). |
| `agent.rs` (`AgentManager`) | PTY spawn/write/resize/kill is UI-free; the vt100 `Parser` behind `Arc<Mutex<…>>` exists *for* the renderer, but the daemon can own it and serialize screens to clients (see `TerminalScreen` in the protocol crate). |

The event-channel architecture (`managers → mpsc → event loop`) is exactly a
daemon's shape already; the refactor is mostly re-pointing where the channels
drain to.

### Tangled into the TUI (must move)

1. **Agent status transitions live in the UI event loop.** `app.rs:184-201`
   flips `Running ⇄ NeedsReview / Completed` when draining `agent_rx`. If no
   UI is attached, status never updates. → Move into `AgentManager` (the
   daemon actor drains the channel).
2. **Port-forward events are attributed to whichever project screen is
   open.** `PfEvent` carries no project key; `app.rs:209-213` does
   `portforwards.apply_event(state.active_project_name(), event)`. Events are
   *dropped* while on the dashboard and **misattributed** if you switch
   projects while a watcher emits. This is both a live bug and the hardest
   single-consumer assumption in the code. → `PfEvent` gains a `project`
   field (mirror of how `ServiceEvent` already keys by `project/service`).
3. **PTY size = TUI layout size.** `agent_pty_size()` (`app.rs:655`) derives
   agent PTY dimensions from `crossterm::terminal::size()` minus the TUI
   chrome, and the TUI resize event resizes *every* PTY. With two clients this
   is a fight over a global. → Daemon owns a default size; `terminal.resize`
   is an explicit client request (last-writer-wins is fine for v1).
4. **"Open project" = "start all services."** Business action bound to a
   navigation keypress (`app.rs:329-357`). → Becomes the explicit
   `service.startAll` RPC; clients decide when to call it.
5. **Orchestration helpers in `app.rs`** (`start_selected`, `restart_all`,
   template loading for the spawn picker) read `.workspace.yaml` and drive
   managers keyed off UI selection indices. → Move into the daemon behind
   `service.start/restart` etc.; selection state stays client-side.
6. **Process lifetime = UI lifetime.** `app::run()` tears down all services,
   port-forwards and agents when the TUI exits, then `std::process::exit(0)`.
   The entire point of the pivot is to invert this.

### Pure TUI (stays, becomes a client)

`tui/*` is genuinely render-only — every function takes `&AppState` and
`&Manager` immutably. `tui/terminal.rs` (vt100 → ratatui) keeps working
against the `TerminalScreen` DTO instead of a shared `vt100::Screen`.

### Pre-existing defects worth fixing during extraction (not caused by it)

- **Service exit is never detected.** The "monitor exit" task in
  `service.rs:197-207` is an explicit no-op; a crashed service keeps status
  `Starting`/`Running` forever. The `Child` is parked in the struct and never
  `wait()`ed until a manual stop. Fix in Stage 1: `spawn` a real waiter that
  emits `StatusChange { Failed | Stopped }`.
- **Killed agents leak processes.** `AgentManager::kill` only removes the map
  entry; the PTY child is never signaled and the blocking reader thread keeps
  the master fd alive. Today the final `std::process::exit(0)` covers it; a
  long-running daemon can't. Fix: keep the child handle, kill the process
  group, close the master.
- **`PortForwardManager::stop_all` runs `pkill -f "kubectl port-forward"`** —
  kills every kubectl port-forward on the machine, including ones warpforge
  didn't start. Fix: retain child handles and kill only our own.
- **Port ranges are keyed by registry index** (`ports.rs::port_range`), so
  removing a project silently reshuffles every other project's 100-port
  range. Fix: persist the assigned range per project in SQLite.
- **Registry is read once at startup**; `wf add` from another terminal is
  invisible until restart. Fix: `project.add/remove` RPCs mutate daemon state
  and re-persist (registry file stays as the storage format).

### Multi-client (TUI + desktop simultaneously) hazard list

Summarizing the items above that specifically break with two observers:

| # | Location | Assumption | Fix |
|---|---|---|---|
| 1 | `app.rs:209` | pf events belong to the on-screen project | key events by project |
| 2 | `app.rs:655`, resize handler | one terminal defines all PTY sizes | explicit `terminal.resize` RPC |
| 3 | `app.rs:131-138` | UI exit ⇒ stop the world | daemon lifetime decoupled; clients just disconnect |
| 4 | `agent.rs` `Arc<Mutex<vt100::Parser>>` | renderer shares memory with manager | daemon serializes `TerminalScreen` events |
| 5 | `ports.rs` in-process `OnceLock` map | exactly one warpforge process | single daemon instance enforced via lockfile + `daemon.json` pidfile |
| 6 | `app.rs:329` auto-start on open | "opening" is unambiguous | explicit `service.startAll` |

---

## 2. Refactor plan (stages, each independently shippable)

**Stage 0 — workspace + protocol (done in this branch).**
Cargo workspace; `crates/warpforge-protocol` defines the wire types shared by
daemon and all clients. Desktop scaffold builds against it.

**Stage 1 — core extraction, no networking yet.**
Move `agent/service/portforward/ports/registry/config` into a
`warpforge-core` crate (or `daemon/` module) owned by a single **daemon actor
task**: one tokio task owning all managers, driven by an
`mpsc<Command>` + `broadcast<Event>` pair. The TUI keeps linking it in-process
for now — behavior identical, but the UI already talks through the
command/event channels instead of `&mut` manager access. Fold in the defect
fixes above (pf project keying, service exit monitoring, agent kill, pkill
scoping, status transitions into managers).

**Stage 2 — the socket.**
`wf daemon` subcommand: the actor from Stage 1 plus a WebSocket server
(`tokio-tungstenite`, no framework) on `127.0.0.1`, endpoint + random token
written to `~/.warpforge/daemon.json` (schema: `DaemonEndpoint` in the
protocol crate). SQLite (`rusqlite`, owned by the actor thread) for projects,
port-range assignments, and tasks. `wf` (TUI) auto-spawns the daemon if
`daemon.json` is stale/absent.

**Stage 3 — TUI becomes a client.**
Replace the TUI's in-process managers with a WS client speaking the protocol
crate. Delete the in-process path. TUI over SSH now shows the same state as
the desktop app. Terminal panes render `TerminalScreen` events.

**Stage 4 — ACP + tasks (the new capability).**
`AcpSessionManager` in the daemon speaking ACP as a client over child-process
stdio (`claude-code-acp` / `codex acp` / any conforming agent). `task.create`
persists a task row, spawns the session, streams `session.update` events to
clients. Board lands in the desktop app (scaffold already renders it).
Permission requests round-trip via `session.permission`.

**Stage 5 — diff/review.**
`diff.get` computes the task's working-tree diff (git) server-side into the
`TaskDiff` DTO; `diff.resolveHunk` applies accept (keep) / reject (revert
hunk via reverse-apply) — Zed's agent-panel review UX is the bar. Desktop
diff pane is already scaffolded against these two calls.

Estimated churn: Stages 1–3 are moves plus the listed fixes (~the existing
3k lines re-homed, few hundred new). Stages 4–5 are genuinely new (~1–2k).

## 3. Local API

WebSocket + JSON envelope, RPC-style with server-push events — chosen because
the runtime is already tokio, `tokio-tungstenite` adds no framework, and a
webview client (Tauri) can speak it natively with zero Rust glue.
Full message set lives in **`crates/warpforge-protocol/src/lib.rs`** (typed,
tested); TS mirror in `desktop/src/protocol.ts`. Shape:

```jsonc
→ { "id": 7, "method": "task.create", "params": { "project": "my-app", "prompt": "…", "agent": "claude" } }
← { "id": 7, "result": { "taskId": "t_9f2c" } }
← { "event": "task.updated", "data": { "id": "t_9f2c", "status": "running", … } }
```

Clients call `state.subscribe` once and receive a full `Snapshot`, then
incremental events. Log lines carry per-stream sequence numbers so a client
that reconnects (or a slow consumer that gapped) backfills via `service.logs`
instead of the daemon retaining unbounded history per client.

## 4. Desktop shell (scaffolded in this branch)

`desktop/` — Tauri 2 + React/TS + Vite + **Tailwind + shadcn/ui**. Thin by
construction:

- The **only** Rust command is `daemon_endpoint()` (reads
  `~/.warpforge/daemon.json`, which the webview sandbox can't). Everything
  else is the frontend's WebSocket. `src-tauri` depends on
  `warpforge-protocol` only — importing daemon internals is structurally
  impossible (it's not even in the same cargo workspace).
- We don't hand-write design CSS: shadcn components are vendored into
  `src/components/ui`, themed via CSS variables in `globals.css`.
- Views (all built, exercisable via the demo build): **Mission Control**
  (default — attention rail + live session wall + pinnable focus panes with
  inline steer composers), **Board** (throughput strip + queue/priority +
  running + review + history), **Task Detail** (agent conversation + composer
  and multi-file per-hunk diff review), **Projects** (per-project drilldown:
  services/ports, port-forwards, project tasks, "New task here", and the
  running-services→agent-context callout).
- `npm run build` (typecheck + vite) passes. A `?demo` / `__WARPFORGE_DEMO__`
  mode seeds mock state so the whole UI runs with no daemon. `src-tauri` is
  `exclude`d from the root workspace because compiling Tauri needs GUI system
  libs (webkit2gtk on Linux); it builds on a normal dev machine with
  `npm run tauri dev`. Bundling is off (`bundle.active: false`) until icons
  exist.

## 5. Open questions — resolved

**All three recommendations below were confirmed by the project owner
(2026-07-02).** Additionally confirmed: ACP integration with permission
round-trips (approvals) and first-class diff review is core scope, not
optional — Stages 4–5 are the point of the pivot, not a stretch goal.

1. **Worktree model.** Recommend **shared worktree per repo** for v1, per the
   brief's own lean: single developer, and per-task worktrees buy parallelism
   at the cost of cleanup lifecycle, port-range multiplication, and "which
   copy is my editor open in" confusion. The schema keeps a nullable
   `worktree_path` per task so per-task isolation can be added without
   migration. Consequence to accept: one active (running) task per repo at a
   time; queued tasks wait.
2. **Project discovery.** Recommend keeping the **explicit registry**
   (`~/.warpforge/projects.json` + `wf add` / `project.add` RPC). It already
   exists, it's deliberate (no surprise scanning of `~/code`), and the
   desktop app can offer a folder picker that calls `project.add`. No
   filesystem scanning.
3. **ACP session resumption after daemon restart.** Recommend **out of scope
   for v1**. Tasks are persisted in SQLite, so nothing is lost from the
   board; in-flight sessions die with the daemon and the task lands in
   `interrupted` (surfaced in the Blocked column with a one-click re-queue).
   Session resumption depends on agent-side support (`session/load`) that is
   uneven across agents today.

These are recommendations, not decisions — daemon implementation (Stage 1+)
should start after they're confirmed. **Confirmed 2026-07-02**: all three as
recommended.

## 6. Deferred / noted for later

Flagged by the owner as future direction, explicitly **not** for this pass —
config-driven behaviour is fine for now. Recorded so they survive and so we
don't build anything that blocks them:

- **Multi-agent collaboration on one task.** Currently a non-goal (one task =
  one agent session), and the UI reflects that. The owner will spec this
  later. *Architectural caveat to honour now so it stays cheap to add:* don't
  hard-wire task↔session as 1:1 in the SQLite schema or the protocol. Keep a
  `session_id` distinct from `task_id`, and treat `session.update` / diff as
  per-session under a task, even while there's exactly one session per task in
  v1. Then collaboration becomes "N sessions under a task" rather than a
  migration.
- **Auto-detect installed harnesses.** Which agent CLIs are on the machine
  (claude, codex, …) could be probed and offered automatically. For now agents
  come from `.workspace.yaml` `agentTemplates` (config = source of truth). When
  added, auto-detect should *augment* the config list, not replace it — a
  `agent.list` RPC that merges detected binaries with configured templates.
