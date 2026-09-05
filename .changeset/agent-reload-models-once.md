---
"warpforge-desktop": patch
---

One "Reload models list" button reloads every enabled agent at once, next to Save. The label used to repeat down the column, once per agent, which is the wrong shape for the job — you reload because a provider or model changed outside Warpforge, and you rarely know which harness saw it. Agents are re-read together, each row shows "reloading models…" while it waits, and a harness that fails to answer reports on its own row without disturbing the lists that came back fine.
