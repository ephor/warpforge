---
"warpforge": patch
---

IntelliSense is now one install away. When a language server is missing—say you open a `.ts`, `.py`, or `.rs` file and the server isn't on your machine—the editor shows a one-click **Install** banner instead of silently falling back to plain syntax highlighting. Install (or update) any supported language server from **Settings → Language servers**, where each language shows its status: installed, update available, or not found, with a single button to fix it. Warpforge picks the right package manager for your setup (npm, bun, pnpm, or Homebrew) and refreshes the editor automatically once the server is ready, so completion, diagnostics, hover, and go-to-definition just start working.