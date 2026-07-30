# Changelog

## 0.2.0

### Minor Changes

- [#20](https://github.com/ephor/warpforge/pull/20) [`0a54151`](https://github.com/ephor/warpforge/commit/0a541513290253b98f651a2c058823b939013795) Thanks [@ephor](https://github.com/ephor)! - Lets you clear a session out of the way without finishing it. Snooze it for an
  hour, this evening, tomorrow morning, or until next Monday and it comes back
  when the time is up, or settle it to acknowledge it now and keep it quiet until
  something new happens. A running session cannot be settled, and a session
  waiting on a permission request can be neither settled nor snoozed, so nothing
  that needs an answer is silently dismissed.

- [#20](https://github.com/ephor/warpforge/pull/20) [`0a54151`](https://github.com/ephor/warpforge/commit/0a541513290253b98f651a2c058823b939013795) Thanks [@ephor](https://github.com/ephor)! - Keeps an orchestration in the Active lane while any of its agents is still
  running. A review-ready or blocked child no longer pulls the whole group out of
  Active; it stays visible through the group summary and the attention filter.

- [#20](https://github.com/ephor/warpforge/pull/20) [`0a54151`](https://github.com/ephor/warpforge/commit/0a541513290253b98f651a2c058823b939013795) Thanks [@ephor](https://github.com/ephor)! - Keeps the sessions rail beside your work instead of over it. On wide windows it
  is a persistent sidebar that stays open when you enter a task, and it can be
  dragged or keyboard-resized to a width that is remembered between launches. Its
  filter bar is now a Working, Needs you, and All switch with sorting and grouping
  tucked into icon buttons, and session cards show the agent running them.

- [#20](https://github.com/ephor/warpforge/pull/20) [`0a54151`](https://github.com/ephor/warpforge/commit/0a541513290253b98f651a2c058823b939013795) Thanks [@ephor](https://github.com/ephor)! - Gives the rail and the board one shared view of what still needs you. A session
  snoozed for later or settled lands in the same place in both, and the board
  gains Needs attention, Later, and Handled filters with live counts beside each
  group.

### Patch Changes

- [`000aa0d`](https://github.com/ephor/warpforge/commit/000aa0dfc64c3cbdb347bc33ebe25f7dbd2b2305) Thanks [@ephor](https://github.com/ephor)! - Fix port-forward reconnection. Now verifies port is actually bound before reporting active, reclaims stale kubectl processes blocking the port, and uses exponential backoff (2s→30s cap) with a 15-attempt limit before giving up instead of the previous blind retry that would permanently fail after 10 attempts.

- [`1424955`](https://github.com/ephor/warpforge/commit/1424955dd42ab4cf3504f7d02915b5e7ffe79a33) Thanks [@ephor](https://github.com/ephor)! - Refreshes task diffs, project files, and open file contents as soon as an agent
  reports a file edit, so newly changed files can be opened from the conversation
  without manually refreshing the desktop app.

- [#20](https://github.com/ephor/warpforge/pull/20) [`0a54151`](https://github.com/ephor/warpforge/commit/0a541513290253b98f651a2c058823b939013795) Thanks [@ephor](https://github.com/ephor)! - Generates release versions and release notes from changesets, so every release
  carries the notes its contributors wrote instead of hand-maintained version
  metadata.

## [0.1.2]

- Fixes file-type icons and attachment previews in packaged desktop builds by
  allowing only the local, inlined, and object-URL image sources the app uses.
- Adds a release preflight check so an incompatible image content security
  policy cannot reach another packaged release.

## [0.1.1]

- Fixes the macOS application bundle and DMG to display the Warpforge icon
  instead of the generic application placeholder.
- Fixes Claude Code, Codex, OpenCode, and Qwen logos in packaged desktop builds.
- Explains when the published update feed is not available before the first
  signed desktop release instead of exposing a low-level manifest error.

## [0.1.0]

- Introduces the Warpforge desktop app: a local meta-harness for running projects, services, and coding agents from one workspace.
- Adds project management for registering, opening, and removing workspaces without manual setup.
- Moves long-running services and agent sessions into a local daemon so work can continue independently of the desktop window.
- Brings Codex, Claude Code, OpenCode, and custom ACP-compatible agents together with multi-agent orchestration and shared project context.
- Assigns predictable per-project port ranges, allowing multiple projects and agent-built previews to run side by side without port conflicts.
- Implements and delivers application updates with a versioned desktop/daemon protocol and bundled runtime. Windows and Linux builds remain unvalidated previews, and the first end-to-end N→N+1 update test requires a published release.
