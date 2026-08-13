---
"warpforge": patch
---

Rollback and git operations (commit, update, switch, branch, rebase, merge)
now run against the task's worktree instead of the project root, so changes
are applied where the diff is shown.
