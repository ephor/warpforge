---
"warpforge": patch
---

Warpforge no longer stops processes it did not start. When shutting down it used
to clear everything listening on the project's port range, which could take down
a server you were running yourself — or, when running warpforge's own tests, the
agents of the warpforge you were running them from. It now only stops the
services it started.
