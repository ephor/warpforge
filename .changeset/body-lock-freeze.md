---
"warpforge": patch
---

Fixes the whole UI freezing after closing a dialog. Creating a project, opening settings, or any other modal could leave the page unclickable and text unselectable until restart.

The freeze came from Radix shipping several copies of `@radix-ui/react-dismissable-layer` with different versions, each keeping its own lock on the page body. When a dialog and a dropdown or selector overlapped, the copies fought over the body's pointer-events and one of them never let go. Bumping the Radix packages and pinning `@radix-ui/react-dismissable-layer` to a single version so only one copy ships, removing the conflict at the root.
