---
"warpforge": patch
---

In the unified diff view, clicking a "changed lines" marker in a chat message
now scrolls the editor to the matching change instead of leaving you to hunt
for it. The move to a single CodeMirror editor had dropped that jump; it is
restored via the editor's own scroll, so the changed rows (which CodeMirror's
diff already tints) land in the center of the pane.
