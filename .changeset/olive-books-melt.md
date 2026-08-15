---
"warpforge": patch
---

Branching a conversation now carries your uncommitted work across, including
when the original task runs in the project folder itself rather than its own
workspace copy. The branch used to start from the last commit in that case, so
edits you had not committed were missing from the conversation meant to
continue them.
