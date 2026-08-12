---
"warpforge": patch
---

Rebase actions now update the selected branch without checking it out first,
matching WebStorm's `Rebase '<branch>' onto '<target>'` behavior. The daemon
uses `git rebase --onto ... ... <branch>` and restores the current working tree.
