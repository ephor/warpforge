---
"warpforge": patch
---

Show nested git repositories properly in the Files tree. Folders containing
their own git repo (or newly created, still-untracked folders) used to render
as plain file rows and could not be expanded; their contents are now listed.
