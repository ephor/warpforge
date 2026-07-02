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

### 2. Board (the planning view)

The Kanban from the original spec — queued / running / needs-review / done /
blocked, filterable by project, agent, tag. Used to review the queue and
history, not to operate. Already scaffolded.

### 3. Projects (the infrastructure view)

Services, ports, port-forwards per project — the TUI's operational feature
set, kept intact but demoted from "the whole app" to one view. Already
scaffolded.

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
