---
"warpforge": patch
---

The demo iframe on the marketing page now loads the desktop app's own
stylesheet directly. The app's Tailwind v4 entry is self-contained (it scans
its own source for classes), so the separate `app-theme.css` that used to point
at the app's old v3 config is gone.
