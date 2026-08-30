# Project: Warpforge

Read [CLAUDE.md](./CLAUDE.md) — it is the single source of truth for this repo (architecture, conventions, build, and commit rules).

Two rules that are easy to miss and are enforced on review:

- **Files stay under 400–500 lines.** Split a module into a directory (`foo.rs` → `foo/mod.rs` + topic files) before adding to a file that is already at the cap.
- **Clean up your scratch files.** Scripts, dumps and logs go under `$TMPDIR`, never into the repo, and you delete the ones you created before reporting done. Files you did not create are not yours to remove.