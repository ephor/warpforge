---
"warpforge": patch
---

Approving a tool call, sending a message, or starting a task no longer waits on
whatever else is happening. Previously, while an agent was streaming its answer,
the app saved every fragment as it arrived and everything else queued up behind
that — so an approval prompt could sit unresponsive for as long as the agent
kept typing, even in a different task. Saving now happens out of the way, and
the interface stays responsive while agents work.
