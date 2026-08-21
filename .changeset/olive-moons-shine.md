---
"warpforge": patch
---

Connect Warpforge's service tools to your terminal agent once, and they follow you
between projects. Previously a hand-configured connection had to name a single
project up front, so an agent started in any other repository read the wrong
runtime — or refused to start at all. Now the project is picked from the folder
the agent runs in, including task worktrees, so one setup covers every project you
have registered. Agents launched from Warpforge itself are unchanged.
