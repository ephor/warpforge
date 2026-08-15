---
"warpforge": patch
---

A workflow no longer ends for good when one of its agents is lost. If an agent
process dies part-way through a stage — killed by something outside the run,
not by anything wrong with the work — the pipeline now pauses at that stage
instead of finishing as failed. Press Resume and it runs the stage again,
warned that the working copy may already hold partial changes. Previously the
run was over: resume was refused and the only way forward was a new task, even
when the work was already done.
