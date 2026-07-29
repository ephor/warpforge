---
"warpforge": minor
---

Workflows are now selectable and steerable from the app. The New Task dialog
gets a Workflow picker listing your project's templates alongside the built-in
ones — a built-in can be copied into the project in one click so you can edit
it, and a template with a broken YAML is listed with its error rather than
quietly missing. Picking a workflow runs the task as a pipeline instead of a
single agent session, and the agent chip becomes the lead agent for any stage
the workflow doesn't assign.

A running pipeline shows its stage, round, and latest review verdict above the
composer, with Pause and Resume. When it needs you — a stage asked a question,
or review rounds ran out — the task surfaces in "Needs you" and the composer
turns into the answer box: typing replies to the asking stage, resumes a pause
with your note as guidance, or buys another fix round. Board cards carry a
stage badge that turns amber when the pipeline is waiting on you.
