---
"warpforge": patch
---

Starting a task in its own workspace copy no longer holds up everything else.
Setting that copy up takes a moment, and until now the whole app waited on it —
your other tasks' replies and approvals paused until the new task's workspace
was ready. The task now shows up on the board immediately and begins work as
soon as its workspace lands, while the rest of the app keeps moving.
