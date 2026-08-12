---
"warpforge": patch
---

Native OS context menus now back the two main git surfaces, so the desktop app finally feels like an IDE:

- **Changes rail** — right-click a changed file/folder for Stage/Unstage, Open in Diff, and Copy Path.
- **Branch switcher** — right-click any branch for Rename Branch…, Delete Branch… (non-checked-out only), Rebase Onto…, and Merge Branch Into…, each via a small dialog. New daemon ops: `git.branchRename`, `git.branchDelete`, `git.rebase`, `git.merge`, all rollback-safe (stash/abort/restore on conflict) like the existing `git.switchBranch`.

Reusable infra underneath: a Tauri `show_context_menu` command + `useNativeContextMenu` hook for wiring future right-click menus.