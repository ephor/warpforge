---
"warpforge": minor
---

GitHub backlog now prefers a PAT (`repo` + `read:project`) stored in keychain (Settings → Trackers), with `gh` CLI as deprecated fallback for backlog only (PR creation still uses `gh`). Sync reconciles remote status, removes deleted issues, surfaces missing-scope warnings via toast, and no longer blocks the daemon (parallel checks, 30s global timeout, immediate spinner).
