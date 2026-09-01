# 0007 — Scheduled automations: the mirror, the run, and the tick

**Status:** accepted (2026-09-01)

## Context

An automation is a persisted intent — run this prompt on this project on a
cron schedule, with a chosen agent and model. Each occurrence becomes a real
daemon task, so a scheduled run has the same transcript, diff and runtime
context as a hand-created task; the run row (`automation_runs`) is the
bookkeeping that links the two. The scheduler ticks once a minute from the
daemon actor; persistence is a write-behind queue (`Persist`), so the store
lags what the actor just wrote.

The first implementation of this landed with several review findings that
shared a root cause: parts of the system trusted state that a concurrent
path had already made stale. This record fixes the invariants so the same
mistakes are not re-made.

## Decisions

**The actor's in-memory mirror is authoritative; the store is eventual.**
Automations live in a `HashMap` on the daemon actor, loaded at spawn. Every
mutation (create, update, last-run bookkeeping, schedule advance) writes the
mirror first, then queues the store write. Every read path — list, show, the
tick, run-now — consults the mirror, never the store. *Rejected:* reading
through the store — a read right after a write would see pre-queue state,
and a blocking SQLite read on the actor loop is what ADR 0002 exists to
prevent.

**Run numbers come from an in-memory counter seeded at spawn.** *Rejected:*
`SELECT MAX(run_number)` per run — it races the write-behind queue (two runs
collide on a number), silently degrades to 1 when the store errors, and it is
a blocking call on the actor loop. The counter is seeded from the store once,
during startup, while the connection is still exclusive to the spawning
thread.

**A run is a real task.** It spawns through the ordinary task-create path and
closes when that task's turn ends. Consequences, all of which exist because
a turn end is not guaranteed:

- A dispatch whose session fails to start fails the run immediately
  (`start_session` reports failure by blocking the task and inserting no
  handle — no turn end will ever arrive; same shape as workflow stages,
  ADR 0001 invariant 6).
- Deleting the run's task fails the run (`automation_task_deleted`).
- The tick ages out `Pending` runs whose precheck never reported and
  `Running` runs whose task is gone. Without this, one stuck run wedges
  every future occurrence as `SkippedRunning` via the overlap guard.

**The next occurrence advances before dispatch.** The tick computes the next
occurrence and writes it through — mirror and store, even when the schedule
produces no next occurrence (then the automation is unschedulable, and the
cleared timestamp must persist) — before any precheck or spawn happens. A
slow precheck must never let the next tick re-fire the same occurrence.

**A precheck failure is a skip, not a fail.** A precheck that exits
non-zero, cannot spawn, or times out never authorized the run; the run is
recorded as `SkippedPrecheck`. Only work that actually started can fail.

**Last-run bookkeeping merges onto the current row.** `record_last_run`
carries only `last_run_at`, `last_status` and `last_task_id` onto the
automation as it exists in the mirror *now* — never a snapshot captured at
dispatch time, which would revert edits made while the run was in flight.

**Timezone is resolved at create time.** An empty timezone means "the host's
zone", so the host's IANA zone name is written into the row at creation
instead of being resolved lazily at every occurrence (where a moved host or a
read on another machine silently shifts the schedule). UTC remains only the
fallback when the host's zone cannot be determined.

## Invariants

1. **Update the mirror on every write path.** A mutation that persists but
   skips the mirror is invisible to list/show/tick until restart. Each of
   these was a real bug found in review: `automation_update` and the tick's
   next-run seeding both originally skipped it.
2. **`None` next-run must be written through.** Skipping the write when
   `next_occurrence` returns `None` makes the tick re-fire the same
   occurrence every minute.
3. **Every dispatch failure path clears the overlap guard.** `automation_active`
   (automation → run id) and `automation_run_owner` (run → automation) must
   both be cleaned on precheck failure, dispatch failure, start failure, task
   delete and age-out — or the automation can never run again.
4. **Do not persist runs of a deleted automation.** The store delete is
   already queued; a run write landing after it becomes an orphan row.
   `persist_run` drops writes whose automation is no longer in the mirror.
5. **The grace window has a floor of one tick.** `grace = 0` makes
   `now - due > grace` true for every due occurrence: the automation would
   never run.
6. **Deleting an automation cancels its in-flight task.** The task's owner is
   gone; letting it finish only produces a result nobody records.
7. **Retention prunes on final writes only.** Pruning on every interim write
   (pending → running) is wasted store work for rows retention would keep
   anyway, and goes through the persistence queue like every other write.

## Consequences

- Deleting the automation does not delete the task it started (before this
  record it was left running and orphaned); the task is cancelled like any
  other session stop.
- The run counter lives only in memory: two daemons sharing one store could
  reissue numbers. There is one daemon per store.
- Startup order matters: the failed-run sweep runs *before* automations load,
  and a `last_status` left mid-flight by the sweep is reconciled to `Failed`,
  so the UI never shows a running state the daemon cannot be in.
