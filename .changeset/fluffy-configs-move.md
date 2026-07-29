---
"warpforge": patch
---

The workspace config has a new preferred home at `.warpforge/workspace.yaml`,
alongside the new `.warpforge/workflows/` directory. Existing config files in
the project root keep working exactly as before; only newly generated configs
land in the `.warpforge/` directory.
