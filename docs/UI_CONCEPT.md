# Desktop UI concept — Mission Control, not a TUI port

Design premise: with 5–15 agent sessions running across many projects, the
scarce resource is **developer attention**, not screen space. A Kanban board
answers "what is the state of work" (planning view). It does not answer the
operating question: **"what needs ME, right now, and what can I safely
ignore?"** The TUI fundamentally can't answer it either — it shows one
project, one agent terminal at a time. The desktop app must not inherit that
one-thread-at-a-time model.

So the default screen is not the board. It's **Mission Control**.

## The three views

### 1. Mission Control (default — the operating view)

Layout: **attention rail** (left) + **live session wall** (right), with a
**focus row** on top for pinned sessions.

**Attention rail — the triage queue.** Every item that is blocked on a human
decision, auto-sorted by priority then age:

- permission requests from agents ("run `npm install`?") — answerable
  **inline in the rail**, one keystroke, without opening the session;
- sessions that finished and wait for diff review;
- blocked/failed tasks and crashed services;
- interrupted sessions after a daemon restart (one-click re-queue).

When the rail is empty the UI says so explicitly: *"All quiet — 7 agents
working. Nothing needs you."* That sentence is the product: it's permission
to look away. The dock/tray badge mirrors the rail count, so you don't need
the window in the foreground at all.

**Session wall — the simultaneity surface.** Every non-done task is a live
tile (not a tab, not a list row — all visible at once, glanceable):

- color-coded status edge (working / waiting-for-you / blocked / done);
- the **current activity line** — the tool call or agent message happening
  right now, ticking live. Ten tiles = ten live threads in peripheral vision;
- project badge, agent badge, files-changed count, elapsed time;
- inline permission buttons when that tile is the one asking.

Clicking a tile never navigates away by default — it **pins** it.

**Focus row — the split.** Pinned sessions (up to ~4) expand into side-by-side
live panes showing the recent stream: supervise several delicate sessions
simultaneously, like a video wall. Full task detail (complete stream +
multi-file diff review) remains one more click away, for when a session
earns your full attention.

**Global everywhere:** a command palette (`⌘K`) that can spawn a task in any
project, jump to any session, restart any service — cross-project actions
never require "going to" the project first.

Agents are talked to, not just watched. Each focus pane carries an inline
"steer this session" composer; the full conversation + composer lives in Task
Detail (below). Both map to ACP `session/prompt`; permission requests map to
`session/request_permission` and are answerable from the attention rail
without opening anything.

### 2. Board (the planning view)

Queue + priorities + history + throughput in one screen. A throughput strip
(running now / in queue / awaiting review / done-24h) over four columns:
**Queue** (reorderable — priority is drag/Аrrow order, persisted daemon-side),
**Running**, **Review / blocked**, **History** (done tasks newest-first).
Filterable by project and agent. MC is "what needs me now"; Board is "what to
run next and what already shipped".

### 3. Projects (infrastructure + the bridge to agent work)

Per-project drilldown, not just a services table: services/ports,
port-forwards, and the project's tasks in one place, with **"New task here"**.

The load-bearing idea (from the owner): **running services are agent
context.** A callout — "Shared with new agent sessions" — lists the live
services and their URLs (`app → http://localhost:4001`), and the New Task
dialog carries a "Share running services with the agent" toggle. When on, the
daemon prepends a runtime-context block to the agent's first prompt so it
knows the app is already up, on which ports, and can hit real endpoints / run
tests. This is what stops Projects being a fifth wheel — infra flows into the
agent's working context. Protocol: `task.create { includeRuntimeContext }`;
the daemon composes the block from live `ServiceManager` state.

### 4. Task Detail (working inside one session)

Conversation (the ACP stream + a message composer, ⌘↵ to send) on the left,
multi-file diff with per-hunk accept/reject on the right. The composer is the
primary agent-interaction surface: send follow-ups, steer, answer questions.

## Component stack

Frontend is **React + TypeScript + Tailwind + shadcn/ui** (Radix primitives).
We don't hand-write design-system CSS — shadcn components are vendored into
`src/components/ui`, themed via CSS variables in `globals.css`. Semantic
status hues (ok / warn / destructive) are kept separate from the single blue
accent. The demo-review artifact is the same built `dist/` inlined into one
file — Tailwind compiles to static CSS, so it stays CSP-safe with no CDN.

## What this changes in the daemon API

Almost nothing — which is the point of the thin-client design:

- The attention rail is **derived client-side** from `task.updated` +
  `session.update` (permission requests) + `service.status` events.
- One addition earns its place later: a daemon-side `attention.count` event
  so the tray badge can update without the full subscription. Deferred.
- Tile activity lines come from the same `session.update` stream the detail
  view uses; no extra endpoints.

## Scaffold status

`desktop/src/views/MissionControl.tsx` implements the rail + wall + focus
row against the existing protocol types and is the app's default view. The
command palette, tray badge, and notification integration are listed as
follow-ups in DAEMON_PLAN stages 4–5, since they only become meaningful once
real sessions flow.
