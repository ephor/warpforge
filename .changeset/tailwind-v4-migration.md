---
"warpforge": patch
---

The desktop app now builds on Tailwind CSS v4, replacing the v3 PostCSS
pipeline with the dedicated Vite plugin. The theme (colors, radii, fonts, and
animations) moved into a single CSS `@theme` block, and the shadcn enter/exit
animations are defined as native CSS keyframes instead of a plugin. The app's
unified-diff and markdown surfaces now use the shadcn `typeset` typography
system, giving chat and preview text a consistent, container-aware rhythm that
follows the selected color theme.
