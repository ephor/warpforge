# 0002 — Daemon concurrency: non-blocking mailboxes, sharded per task

**Status:** accepted (2026-08-15)

## Context

The daemon started as one actor: a single `tokio::select!` loop in
`daemon/actor.rs`, owning all state and draining one `mpsc` mailbox. For the
scale it was written at — a couple of projects, one agent session — that was the
right call, and it made every state transition trivially race-free.

It stopped holding. `actor.rs` is past 7000 lines, `handle_command` awaits each
command inline, and the work behind those commands grew: worktree creation,
subprocess `git`, filesystem walks, SQLite writes. What users hit: starting a
task stalls the conversation, approving a tool call waits behind unrelated work
in a different task, the title generator delays the first turn. One queue for
everything.

Every source of head-of-line blocking below was confirmed in the code, not
inferred:

- **Blocking `rusqlite` on the actor's thread.** `emit_session` persists on
  *every* streamed chunk from an agent, and `emit_session_unless_last_duplicate`
  reads the last row back from disk before each one. While an agent streams, the
  actor hammers the disk and nothing else in the daemon advances.
- **A second queue above the actor.** The WebSocket read loop in
  `daemon/server.rs` awaits `dispatch` inline, so one connection serves one
  request at a time. A tool approval is not even read off the socket until the
  file search ahead of it returns.
- **Inline I/O in `handle_command`** — worktree create, diff, branch operations.
  `diff::search_files` is a fully synchronous tree walk that reads every file.
- **A latent self-deadlock.** The actor sends to its own bounded mailbox
  (`Command::ProbeAgent`). If that mailbox ever fills, the actor blocks on its
  own send with nobody left to drain it.

ADR 0001 invariant 9 — "waits on a child's exit are bounded … the daemon actor
is single-threaded and awaits handlers inline" — is a workaround for this
architecture, not a property worth keeping.

## Decisions

**The actor loop never blocks and never awaits I/O.** A handler may read and
mutate in-memory state, then it either replies or hands the work to a task.
Results come back as ordinary messages. *Rejected:* case-by-case `tokio::spawn`
where a handler looks slow — that is what produced today's state, where four
handlers spawn and thirty do not, and no reader can tell which rule applies.

**Persistence is a write-behind actor on its own blocking thread.** It owns the
`rusqlite` connection, coalesces streamed session updates in memory, and flushes
batched transactions. Callers get fire-and-forget. *Rejected:* `spawn_blocking`
per write — it keeps one disk round-trip per streamed chunk, which is the actual
cost; the fix is batching, not moving the same work sideways. *Rejected:* an
async SQLite wrapper — same round-trip count, plus a dependency.

**Reads do not enter a mailbox.** Diffs, file listings, search, file contents and
snapshots are served from an `ArcSwap` state snapshot plus I/O on a worker. They
need a consistent *view*, not exclusive access. This removes roughly half the
`Command` variants from the write path. *Rejected:* keeping reads in the mailbox
for strict read-your-writes ordering — the UI already tolerates eventual
refresh, and it is what makes polled reads (the diff panel) cost the whole
daemon.

**Requests are concurrent per connection.** `server.rs` spawns each dispatch,
bounded by a semaphore, rather than awaiting it in the read loop.

**State is split by ownership, then sharded per task.** Global state (projects,
accounts, configured agents, services, port forwards) stays in one actor. Per-task
state (agent session, pending permissions, workflow run, worktree) moves to a
task actor with its own mailbox, supervised so a wedged task cannot take the
daemon with it. The global actor routes. *Rejected:* one actor with finer-grained
locks — it trades a queue for a lock graph and loses the property that makes the
actor model worth having.

**Control-plane messages never share a queue with data-plane.** Permission
answers, cancels and stops ride a separate channel, drained first in a `biased`
select. A user answering a permission prompt must not wait behind a stream of
agent output.

**Every message that mutates task state carries the task's epoch.** Handing work
to a task means results arrive after the world may have moved on; a result whose
epoch does not match is dropped. *Rejected:* checking only that the task still
exists — an id is reused across cancel-and-restart, and the stale write lands on
the new run.

**New machinery grows beside the old, and ownership moves in one step per
piece.** The new runtime lives under `daemon/runtime/`; the existing actor
delegates into it as each piece lands. *Rejected:* a parallel implementation kept
running alongside the old one behind a flag — two owners of the same mutable
state diverge, and the resulting bug reports are unreadable. Alongside means
*not yet wired*, never *wired twice*.

## Invariants

Named by module, because each one fails quietly.

1. **`daemon/actor.rs` handlers hold no `.await` on I/O.** git, filesystem,
   subprocess and store calls are handed off. A handler that awaits I/O
   reintroduces the whole class of bug this record exists for, and it will look
   local and harmless in review.
2. **Nothing calls `store::*` from an actor loop.** The store is reachable only
   through the persistence actor's channel. A direct call compiles, runs, and
   silently puts a blocking disk write back on the hot path.
3. **An actor never `.await`s a send to its own mailbox.** Use `try_send` and
   handle the full case, or a dedicated unbounded self-channel. This is a hard
   deadlock, not a slowdown.
4. **Every reply path stays total.** Handing work to a task adds paths where a
   `oneshot` sender can be dropped — a task that panics, an epoch mismatch, a
   shard that was torn down. A dropped reply is a client promise that never
   settles: a spinner that spins forever. Every early return sends something.
5. **Epoch is checked before mutation, not before dispatch.** The gap between
   accepting a result and applying it is where the stale write lands.
6. **Snapshot publication is atomic per command.** Readers must never observe a
   half-applied transition — publish once, after the handler completes, not on
   each field it touches.
7. **Ordering guarantees are per task, not global.** Two commands for the same
   task keep their order; commands for different tasks do not, and nothing may
   assume they do. Workflow stage transitions are the place this will be
   assumed by accident.
8. **A task shard's death is contained and observable.** Supervision restarts it
   from persisted state and marks the task; a silent restart that loses queued
   commands is worse than the freeze it replaced.

## Consequences

- ADR 0001 invariant 9 (bounded waits on child exit) loses its original
  justification once handlers stop blocking the daemon. Bounded waits stay —
  they are good hygiene — but they are no longer load-bearing for liveness.
- Read-your-writes is no longer automatic. A mutation followed immediately by a
  read may observe the prior snapshot; flows that depend on it must await the
  mutation's reply, not re-read.
- `actor.rs` stops being one file. Splitting by ownership is what makes the
  400–500 line rule in `CLAUDE.md` reachable here; the file size is a symptom of
  the undivided state, not a formatting problem.
- Debugging changes shape: a stall is no longer "the actor is busy" but "which
  shard, which channel". Shard identity belongs in log lines from the start.
- More moving parts. This is only worth it because the single queue is now the
  user-visible bottleneck; it would have been premature a year ago.

## Out of scope, deliberately

Event sourcing (replay, audit, undo) — a different investment with a different
payoff, and not a latency fix; the write-behind persistence actor here is a
prerequisite for it, not a competitor. Multi-process daemons. Distributing work
across machines. Replacing the broadcast event bus, which is not a bottleneck.
