---
"warpforge": patch
---

Discovered follow-up work can now be saved directly to the local backlog as a
todo item without starting an agent. The new `create_backlog_task` action
supports a title, details, priority, and status; the older `create_task` name
continues to work as a deprecated compatibility alias.
