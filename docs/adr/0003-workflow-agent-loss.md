# 0003 — Losing a stage's agent pauses a pipeline, it does not fail it

**Status:** accepted (2026-08-15)

## Context

A workflow stage whose child session ended called `workflow_finalize` with an
error. `RunState::Failed` is terminal: `is_active()` is false, and
`workflow_resume` answers "the pipeline is not paused". The run was over.

That is the wrong response to the failure that actually happens. The reported
case: an agent process was killed mid-stage by something unrelated to the work
(warpforge's own test suite, which kills every listener in the project's port
range — see the *Consequences* below). The user re-prompted the stage's task,
the session reconnected, and the agent finished the implementation. The work was
done and reviewable. The pipeline was still dead, and the only way forward was
to start a new task.

Losing the agent process is an infrastructure failure. The stage never got to
say whether the work was good, so the pipeline has no verdict — but it also has
no reason to conclude the run failed.

## Decisions

**A stage that loses its agent parks the run at the pause barrier**
(`RunState::Paused { next: <that stage> }`) instead of finalizing it. Resume
re-runs the stage. This applies to a stage child whose session ended, and to a
review round where every reviewer's agent died before producing a verdict —
both are the absence of a verdict, not a rejection.

*Rejected:* a new `WorkflowWaitKind` with retry/accept/stop controls. It is the
better long-term shape — in the reported case the work was already finished, so
"accept this stage and move to review" would have been the right answer — but it
needs a protocol addition and desktop work, and the pipeline being unrecoverable
at all is the part that hurts. The pause barrier already exists, the desktop
already renders it, and resuming already works.

*Rejected:* automatically retrying the stage. A dead agent is often dead for a
reason that will repeat, and a pipeline that silently re-runs stages burns
tokens without telling anyone.

**The re-run is told the working copy may already contain partial work**, via
`pending_guidance` — the same warning `restore_workflow_runs` gives a stage
interrupted by a daemon restart. A stage that assumes a clean tree will redo
work that is already there, or worse, conflict with it.

## Invariants

1. **This path is for a lost agent, not a bad outcome.** A stage that finishes
   and produces a poor verdict goes through `workflow_stage_finished`. Only
   `workflow_child_failed` — reached when a child's session ends — parks. Widen
   it and a genuinely failing pipeline becomes an infinite pause loop.
2. **Parking must clear the stage's bookkeeping.** `active_children`, and for a
   review round `review_pending` / `review_collected` / `reasked`. A resumed run
   that still lists the dead child waits for a turn that will never end.
3. **The review round counter is given back when a review round parks**, for
   the same reason `restore_workflow_runs` gives it back: spawning re-increments
   it, and without the decrement a re-run reports "round 3/2" and lands straight
   on the limit decision.
4. **ADR 0001 invariant 6 still holds and is narrower than it looks.** A stage
   whose session *fails to start* must fail the run — no handle is inserted, so
   no `TurnEnded` will ever arrive and nothing else would notice. A stage whose
   session started and *then* died is this record's case.

## Consequences

- A pipeline can now sit paused indefinitely after an agent dies. That is
  visible on the board (the parent goes to `Waiting` with pause controls) and is
  the intended trade against silently burning tokens on retries.
- Resuming re-runs the whole stage. When the lost agent had already finished the
  work — the reported case — the re-run is redundant. The rejected barrier
  design is what fixes that; this record does not.
- Worth fixing separately: `cargo test` in this repo kills every process
  listening on the project's port range (`kill_listeners_in_ranges`, reached
  from the daemon teardown that tests exercise). That is what killed the agent
  in the reported case, and it kills unrelated processes on the developer's
  machine too.
