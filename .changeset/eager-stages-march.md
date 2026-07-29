---
"warpforge": minor
---

Workflow pipelines now actually run. Creating a task with a workflow selected
drives it through a deterministic plan → implement → review ⇄ fix pipeline:
each stage is a child agent session, reviewers run in parallel and return a
structured verdict, and fix rounds are hard-capped by the workflow's limit.
The parent task narrates progress as a timeline, and the pipeline suspends
for you when it needs input: a stage can ask a question mid-run, and hitting
the review limit asks whether to grant more rounds, finish as is, or stop —
optionally with extra guidance for the next fix. Pipelines can be paused at a
stage boundary and resumed (with notes), survive daemon restarts by parking
at their last safe point, and never commit anything: a finished run lands in
Needs review for you to inspect and commit.
