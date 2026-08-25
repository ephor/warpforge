---
"warpforge": patch
---

Warpforge now actually asks before doing something you cannot take back. Deleting a task, quitting while services are running, closing a half-written work item, and switching memory search to the downloadable model all went ahead silently — the prompt they relied on never appeared. Each one now shows a real dialog naming what is about to happen, with the failure reported instead of passing for success.
