---
"warpforge": patch
---

Keep the desktop app light when a project has large build directories. The file
tree and mention picker no longer list `node_modules`, `target`, `dist`, `.next`
or `.git` at any depth — on a Rust + Node project that is 162,000 entries down
to under 1,000 — while other `.gitignore`'d files such as `.env` stay listed and
openable. Mission Control session tiles also stop refetching a project's file
list on every task update, so their data is reused instead of rebuilt.
