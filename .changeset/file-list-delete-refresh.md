---
"warpforge": patch
---

Project Files now removes physically deleted tracked files from its listing.
The file list explicitly refetches after filesystem mutations instead of only
marking the query stale.
