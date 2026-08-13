---
"warpforge": patch
---

Show remote-tracking branches correctly in the branch tree. Git can emit the
remote name itself (for example `origin`) alongside `origin/main`; the branch
list now filters that namespace marker so remote branches are not hidden.
