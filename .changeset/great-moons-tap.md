---
"warpforge": patch
---

The app now handles several requests at once instead of one at a time. A single
slow action — listing a large project, loading a diff, scanning for agents —
used to hold up everything else you did, so a tool approval could sit waiting
until the slow one finished. Requests that only read now run alongside each
other, and replies are sent without waiting on the network's send delay, which
takes tens of milliseconds off routine actions.
