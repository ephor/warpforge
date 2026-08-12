---
"warpforge": patch
---

Branch Delete now force-deletes (`git branch -D`, equivalent), so deleting an
unmerged local branch from the branch-switcher context menu no longer fails
with "not fully merged". The dialog already confirms the action is
irreversible, matching the force semantics.