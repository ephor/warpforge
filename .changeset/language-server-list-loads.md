---
"warpforge": patch
---

The language server list in Settings now loads in the installed app instead of spinning forever. Version checks are also bounded: a server that stops responding shows up as "not found" or without a version rather than holding up the whole list, and it no longer leaves stray processes running in the background. If a request to the workspace ever does go unanswered, the app now tells you instead of leaving a spinner on screen.
