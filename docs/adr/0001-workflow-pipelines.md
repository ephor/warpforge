# 0001 — Workflow pipelines: deterministic engine, project-configured

**Status:** accepted (2026-07-30) · introduced in `ephor/warpforge#21`

## Context

"Process" used to mean one **Orchestrator** toggle: a hardcoded prompt plus
three MCP tools handed to an LLM, which then decided for itself what to
delegate. There were no roles, no review, no iteration limit, and nothing a
user could configure. Making the process better meant editing a prompt string
in the binary.

## Decisions

**The engine is deterministic. The model never decides what happens next.**
Transitions live in `daemon/workflow.rs` + the workflow block of
`daemon/actor.rs`. *Rejected:* a manager agent driving the pipeline through
tools — it reintroduces exactly the "process is whatever the model felt like"
problem, and its failures are unreproducible.

**A workflow is a YAML file in the project** (`.warpforge/workflows/*.yaml`),
not UI state or a DB row. It lives with the code it reviews, is diffable, and
travels with the repo for the whole team. Built-ins ship in the binary and can
be copied into a project to edit.

**The pipeline shape is fixed** (`plan? → implement → review ⇄ fix`) and the
YAML configures those stages. *Rejected for the first iteration:* an arbitrary
stage DAG with activation conditions and gate expressions. The fixed shape
covers the real cases, and a DAG can be added later without changing the file
format for existing workflows.

**Each stage is a normal child task with its own agent session.** It appears on
the board, its chat can be opened, and a human can intervene in it. *Rejected:*
one long session with role-switching prompts — the roles then share context and
a reviewer inherits the implementer's blind spots.

**The parent task has no agent session.** It is the pipeline's record: a
timeline of stages, plus the place where the engine asks the user something.
Consequence: the parent's composer can only be an answer box at a barrier, and
**everything that routes composer input must go through `useWorkflowSend`** —
prompting the parent directly fails with a raw daemon error.

**The user is asked at structured decision points, not in free chat.** A stage
can suspend the run with a `need_user_input` marker; exhausting the review
rounds asks extend/finish/stop. Control is by button, free text is payload with
one unambiguous addressee. *Rejected:* interpreting free text as commands —
that needs an LLM in the control path, which decision 1 rules out.

**Repeat review rounds continue in the same reviewer's session** by default
(`review.reask`). The reviewer remembers its own findings and can verify each
one, and it costs a delta instead of a full re-read. The cost is anchoring
bias, mitigated in the prompt ("defending your earlier verdict is not a goal")
and by an explicit regression check. A dead session falls back to a fresh one
carrying the previous findings.

**Agents talk to the engine through fenced JSON** (verdict, `need_user_input`),
appended to every stage prompt including custom ones. Machine-readable output
from a text model is the weakest link in the design, so every parse path has a
fallback rather than a hard failure.

**A finished pipeline commits nothing.** It lands in `NeedsReview` for a human.
*Rejected:* an `on_success: commit` option — it makes an unattended pipeline
able to write history.

**Pause is soft, at stage boundaries.** The running stage finishes its turn and
the next one does not start. This is what makes pause survive a daemon restart:
no barrier state depends on a live session. *Rejected for now:* interrupting a
turn mid-flight.

## Invariants

Break one of these and the failure is quiet. Each was a real bug found in
review.

1. **`workflow_runs` take/put.** Methods `remove` the run and must re-insert on
   *every* exit path, including early returns and error branches. A dropped run
   leaves the parent stuck in "running" with no controls.
2. **`AcpHandle::prompt` is not a liveness check.** Its channel belongs to the
   driver task, which outlives the child process, so it returns `Ok` for a dead
   agent and the prompt vanishes. Ask `is_alive()` before treating a follow-up
   as delivered — otherwise the same-session and dead-session fallbacks are
   unreachable exactly when they are needed.
3. **A stage's output is its closing message** — the text after its last tool
   call — not the whole turn. The full turn is only a parsing fallback. This
   keeps tool narration out of reviewer prompts and stops a JSON block quoted
   mid-turn from being read as the protocol payload.
4. **`request_changes` must never finish the run as a success.** A reviewer that
   asks for changes but produces no parseable findings has its prose salvaged
   into one finding. The "only low-severity notes remain" shortcut is valid
   *only* when findings were actually parsed and all were low.
5. **A reviewer that cannot produce a verdict abstains.** Only "no reviewer
   produced one" fails the run. Failing a complete implementation because one
   agent wrote prose twice is not acceptable.
6. **A stage whose session fails to start must fail the run.** `start_session`
   reports failure by blocking the child and inserting no handle, so no
   `TurnEnded` will ever arrive and nothing else will notice.
7. **Stage sessions stay alive for the whole run** (same-session re-review needs
   them) and must *all* be swept at finalize — `active_children` is not enough.
8. **The round counter increments only when a new review round starts.**
   Re-entering the same round after a restart must not re-count it, or the run
   reports "round 3/2" and jumps straight to the limit decision.
9. **Waits on a child's exit are bounded.** The daemon actor is single-threaded
   and awaits handlers inline; an unkillable child would otherwise freeze every
   project.
10. **Everything persisted in a run snapshot carries `serde(default)`.** A field
    that is required on load turns every in-flight pipeline unreadable after an
    upgrade.

## Consequences

- Roughly 3–4× the tokens and wall-clock of a single-agent run, and stages are
  serial. Worth it for review-worthy changes, not for trivial ones.
- `max_rounds` counts **reviews**; a fix runs between them, so N rounds buy N−1
  repair attempts (default 3 = two attempts).
- Usefulness depends on how well agents follow the JSON protocols. The prompts
  are load-bearing: treat them as code, not copy.
- Reviewers see the working-copy diff, so a dirty tree or an agent that commits
  its own work distorts what they review.

## Out of scope, deliberately

Finding ledger and cross-round dedup, deterministic build/lint/test gates
(agents run their own checks), separate tester and final-acceptor roles, global
`~/.warpforge/workflows/`, template versioning, auto-commit. The richer
reference design these were pruned from is kept outside the repo.
