---
"warpforge": patch
---

Committing, pushing, merging, switching branches, saving a file and opening a
pull request no longer pause the rest of the app while they run. Each of these
waits on git, and until now everything else — agent replies, approvals, your
other tasks — waited with it. They now run alongside your work, so a slow push
costs you the push and nothing else.
