# Architecture decision records

Decisions that are **not recoverable from the code**: what was chosen, what was
rejected, and which invariants a future change must not break. If something can
be learned by reading the code, it does not belong here — that duplication goes
stale and then misleads.

- One file per decision or per coherent cluster of decisions, numbered:
  `NNNN-short-slug.md`.
- Records are append-only. Don't rewrite a decision that changed — add a new
  record and mark the old one `Superseded by NNNN`.
- Keep each one short enough to read in full before touching the subsystem.
  The **Invariants** section is the part that prevents regressions; put real
  effort there and name the module it applies to.

| ADR | Subject |
| --- | --- |
| [0001](0001-workflow-pipelines.md) | Workflow pipelines: deterministic engine, project-configured |
| [0002](0002-daemon-concurrency.md) | Daemon concurrency: non-blocking mailboxes, sharded per task |
| [0002](0002-issue-tracker-integration.md) | Backlog ↔ issue trackers: one table, daemon-owned links |
| [0003](0003-workflow-agent-loss.md) | Losing a stage's agent pauses a pipeline, it does not fail it |
| [0004](0004-project-page-surfaces.md) | The project page is surfaces, and the backlog is a list |
| [0005](0005-chat-transcript-scrolling.md) | The virtualiser owns the chat scroll, and the transcript arrives whole |
| [0006](0006-explicit-port-pinning.md) | Ports are pinned explicitly, not derived from list positions |
