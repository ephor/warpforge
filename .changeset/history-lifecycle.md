---
"warpforge": minor
---

Faster cold start and automatic history cleanup. The app now loads only a small recent slice of each task's chat on connect, so starting after a while no longer hangs on a large database. Closed tasks keep their chat for 30 days, waiting tasks with no changes settle themselves after 2 weeks, and untouched closed tasks are removed after 90 days. Each step is visible with a notice, and all three windows are adjustable in Settings → Task history.
