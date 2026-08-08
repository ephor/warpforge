---
"warpforge": patch
---

Fix Codex refusing to start once an account was selected. Each account now keeps
its own Codex databases instead of sharing the ones in `~/.codex`, which failed
with "failed to initialize sqlite state runtime" and left every Codex task
unusable until the account was removed. Config, skills and session history are
still shared, so an account sees the same setup as a plain `codex` run.

Conversations also resume in the home they were started in. A chat older than
the accounts feature stays on your original login rather than being sent to
whichever account happens to be active, and a new chat keeps the account it
started on even after you switch.
