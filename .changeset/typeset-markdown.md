---
"warpforge": patch
---

Rendered markdown now uses the shadcn `typeset` style system. Chat messages get
a tight `typeset-chat` rhythm and the editor's markdown preview a roomier
`typeset-docs` one, so headings, lists, code, and links read consistently and
follow the active color theme. This replaces the old `prose` classes, which
depended on a typography plugin the app did not ship.
