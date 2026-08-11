---
"warpforge": patch
---

Rebuilt the New Task screen around the prompt. The run context (project, harness, model, worktree, services) now sits as one quiet strip inside the composer instead of five bordered cards, and a diagram under it draws what Start will actually do — the selected pipeline's real stages and review rounds, or an example split for an orchestrator.

Changing the project no longer wipes your harness, model picks or the prompt you already typed; only the pipeline is dropped, because pipelines belong to a project. Switching modes no longer shifts the page around, and the pipeline menu is more compact, with the "save an editable copy into this project" action on the same row as each pipeline.
