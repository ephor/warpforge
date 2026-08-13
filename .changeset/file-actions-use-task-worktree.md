---
"warpforge": patch
---

File listing, reading, saving, and filesystem actions now resolve task
worktrees before falling back to the project checkout. This keeps Project
Files, diff state, editor writes, Finder actions, and delete/rename/create
operations pointed at the same working copy.
