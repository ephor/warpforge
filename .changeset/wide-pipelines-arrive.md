---
"warpforge": minor
---

Adds configurable workflows: a task can now run as a pipeline of agent stages
instead of a single session. A workflow is a YAML file in your project's
`.warpforge/workflows/`, and it decides which agent and model runs each stage,
what each stage is told to do, what the reviewers see, and how many review
rounds are allowed. Two built-in templates ship with the app — "Implement +
review loop" and "Plan + implement + review loop" — and either can be copied
into a project in one click to customize.

Pick a workflow in the New Task dialog and the daemon drives the run: it plans
(if the workflow asks for it), implements, then loops review and repair until
the reviewers approve or the round limit runs out. Reviewers can be several
different agents at once and return structured verdicts, and a repeat round
continues in the same reviewer's session so it verifies its own findings
instead of reviewing from scratch.

The pipeline reports to the parent task as a timeline of stages, each with the
agents that ran it — click one to open that agent's own session. It also stops
for you when it needs to: a stage can ask a question, and running out of review
rounds asks whether to grant more, finish as is, or stop. Pipelines can be
paused between stages and resumed with extra guidance, survive a daemon restart
by parking at their last safe point, and never commit anything — a finished run
lands in Needs review for you to inspect.

Reviewers can pin each finding to a line and a short code excerpt, so the
repair stage goes straight to the right place instead of searching, and the
summary a stage hands to the next one is its closing message rather than the
whole turn's tool narration.
