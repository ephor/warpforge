---
"warpforge": patch
---

Searching for files no longer freezes the rest of the app. On a large project
the search reads through every file, and until now everything else — agent
replies, approvals, service controls — stopped until it finished. Search now
runs out of the way, so the app keeps responding while it works.
