---
"warpforge": patch
---

Unified diff now uses CodeMirror's `unifiedMergeView` instead of the custom `<pre>` renderer, so wrapping tracks the container width, syntax highlighting and collapsed-unchanged handling match the split view, and backgrounds no longer clip on long lines.
