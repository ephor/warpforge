---
"warpforge": minor
---

Code editor selections now offer a floating "Send to chat" action (and a
Cmd/Ctrl+L shortcut) that drops the selected lines into the task chat as a file
reference. The popover sits below a single-line selection so it no longer covers
the selected text. Also fixes the editor's focused-selection flash on dark
themes, where CodeMirror's built-in light rule painted near-white over text — the
selection tint now always follows the app theme.