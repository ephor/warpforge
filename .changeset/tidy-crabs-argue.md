---
"warpforge": patch
---

Viewing changes no longer slows the rest of the app down. The changes panel
refreshes on a timer, and each refresh used to hold everything else up while it
inspected the repository — with a task open, that was a steady drip of pauses
affecting agent replies and approvals. Reading diffs, file contents, file lists
and branches now happens alongside the rest of the app instead of in front of
it.
