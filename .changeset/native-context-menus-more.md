---
"warpforge": patch
---

More native right-click menus, extending the context-menu foundation to the rest of the desktop surfaces:

- **Project files panel** — right-click a file for Open or Copy Path; right-click a folder to Expand/Collapse or Copy Path.
- **Chat transcript** — right-click any user or assistant message to Copy it as plain text.

Infra unchanged: all three surfaces reuse the existing Tauri `show_context_menu` command and `useNativeContextMenu` hook.