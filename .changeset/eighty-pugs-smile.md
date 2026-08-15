---
"warpforge": patch
---

Starting a task no longer pauses while its name is written. Naming a task runs
a short agent in the background, and the app used to wait on it before handling
anything else — so the first message, tool approvals, and other tasks all sat
still until the name came back. Naming now happens alongside your work, as do
installing an agent or a language server, which had the same problem and could
hold things up for much longer.
