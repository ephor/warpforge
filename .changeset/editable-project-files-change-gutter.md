---
"warpforge": patch
---

Project Files is now editable: the sidebar's file tree opens any checkout file
in a write-enabled editor (⌘S to save), with `file.save` and `git.commit`
addressed by project name when no task owns the file. Project files picked from
the tree also open with the same WebStorm-style change gutter as task files —
thin colored bars for added (green) and modified (blue) lines, a marker for
deleted lines, and a click-to-revert / per-file commit popup.
