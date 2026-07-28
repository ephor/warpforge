# Changesets

Warpforge ships as one product, so this directory versions a single package:
the root `package.json`. Every user-facing change should carry a changeset that
describes it in release-note language.

Add one before opening a pull request:

```bash
bun install            # once, at the repository root
bun run changeset
```

Choose `patch`, `minor`, or `major`, then write the summary the release notes
should contain. The generated Markdown file is committed with the change.

The **Version release** workflow consumes every pending changeset: it bumps the
root `package.json`, rewrites `CHANGELOG.md`, propagates the new version to the
Rust, Tauri, and desktop manifests via `scripts/sync-version.mjs`, and pushes
the immutable `vX.Y.Z` tag that **Draft release** builds from. See
`docs/RELEASING.md`.
