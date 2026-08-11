# Changelog

## 0.4.2

### Patch Changes

- [`4710b8b`](https://github.com/ephor/warpforge/commit/4710b8b553381afbf246bfbca20948459d1b1237) Thanks [@ephor](https://github.com/ephor)! - Theme system for the desktop app: four workspaces of palettes (warm neutral, light/dark pairs) with a theme picker in Settings. Editor syntax highlighting now draws from each theme's own token palette instead of fetching a fixed editor theme, and agent logos get light/dark variants so they read on both modes.

## 0.4.1

### Patch Changes

- [`cf34477`](https://github.com/ephor/warpforge/commit/cf34477b063338cf8ac3b60a55fec2083766da5e) Thanks [@ephor](https://github.com/ephor)! - Fixed a bug that prevented dragging images into the chat composer's dropzone. Screenshots can now be dropped directly instead of saving them and using the image button.

- [`30ba568`](https://github.com/ephor/warpforge/commit/30ba5680dcb0d52d96cc763486c3ed4dcfc9ee9a) Thanks [@ephor](https://github.com/ephor)! - Rebuilt the New Task screen around the prompt. The run context (project, harness, model, worktree, services) now sits as one quiet strip inside the composer instead of five bordered cards, and a diagram under it draws what Start will actually do — the selected pipeline's real stages and review rounds, or an example split for an orchestrator.

  Changing the project no longer wipes your harness, model picks or the prompt you already typed; only the pipeline is dropped, because pipelines belong to a project. Switching modes no longer shifts the page around, and the pipeline menu is more compact, with the "save an editable copy into this project" action on the same row as each pipeline.

- [`30ba568`](https://github.com/ephor/warpforge/commit/30ba5680dcb0d52d96cc763486c3ed4dcfc9ee9a) Thanks [@ephor](https://github.com/ephor)! - New Task now remembers whether you start tasks in an isolated git worktree. The toggle stays off by default, but once you turn it on it stays on for the next task instead of resetting every time.

## 0.4.0

### Minor Changes

- [#26](https://github.com/ephor/warpforge/pull/26) [`2cc28d9`](https://github.com/ephor/warpforge/commit/2cc28d93d289f854265d6c5380682fd67e02541f) Thanks [@ephor](https://github.com/ephor)! - The desktop app has a new design. Navigation now lives in a persistent sidebar that lists your projects, their tasks and each task's subtasks, ordered so whatever you are working in stays on top; finished work moves behind a quiet "done" shelf instead of filling the tree. Opening a task shows the conversation beside one surface at a time — Files, Diff, Runtime or Pipeline — rather than several panels competing for the same space, and Pipeline now streams a child agent's live transcript so you can watch what it is doing without leaving the parent conversation.

  Task statuses are simpler: "idle" and "needs review" were the same thing — the agent finished, it is your turn — and are now a single "waiting" state, with a changed-file count telling you whether there is a diff to open. Mission Control's queue lists only work that genuinely cannot move without you, so its count means something again. The Board view is gone; the sidebar and Mission Control cover what it showed.

  The theme moves to a warm near-black with a peach accent, and status colours are kept distinct from it.

### Patch Changes

- [#24](https://github.com/ephor/warpforge/pull/24) [`56732f9`](https://github.com/ephor/warpforge/commit/56732f9f14ee6876cfdf35651d02abfe0c301b1d) Thanks [@ephor](https://github.com/ephor)! - Orchestrators can now dispatch a full plan/implement/review/fix workflow pipeline as a sub-agent (`spawn_workflow`), not just single agents. The pipeline's progress and final result show up through the same `list_agents` / `read_inbox` tools as a regular sub-agent, and `answer_workflow` / `decide_workflow` / `pause_workflow` / `resume_workflow` let the orchestrator respond to a pipeline's questions and review-limit decisions without derailing it.

## 0.3.3

### Patch Changes

- [#23](https://github.com/ephor/warpforge/pull/23) [`aa74c5d`](https://github.com/ephor/warpforge/commit/aa74c5dc8662efae75fd3d6f8ad17ddf84bda92d) Thanks [@ephor](https://github.com/ephor)! - Fix Codex refusing to start once an account was selected. Each account now keeps
  its own Codex databases instead of sharing the ones in `~/.codex`, which failed
  with "failed to initialize sqlite state runtime" and left every Codex task
  unusable until the account was removed. Config, skills and session history are
  still shared, so an account sees the same setup as a plain `codex` run.

  Conversations also resume in the home they were started in. A chat older than
  the accounts feature stays on your original login rather than being sent to
  whichever account happens to be active, and a new chat keeps the account it
  started on even after you switch.

## 0.3.2

### Patch Changes

- [#22](https://github.com/ephor/warpforge/pull/22) [`57baf2d`](https://github.com/ephor/warpforge/commit/57baf2dddcf680c39cc166609475f6ede312bcb6) Thanks [@ephor](https://github.com/ephor)! - Keep the desktop app light when a project has large build directories. The file
  tree and mention picker no longer list `node_modules`, `target`, `dist`, `.next`
  or `.git` at any depth — on a Rust + Node project that is 162,000 entries down
  to under 1,000 — while other `.gitignore`'d files such as `.env` stay listed and
  openable. Mission Control session tiles also stop refetching a project's file
  list on every task update, so their data is reused instead of rebuilt.

- [#22](https://github.com/ephor/warpforge/pull/22) [`f93391f`](https://github.com/ephor/warpforge/commit/f93391ffbdef8ed368113d56f9b8add557677000) Thanks [@ephor](https://github.com/ephor)! - Run several agent accounts and switch between them without logging in again.
  Register each login you already use from Settings → Accounts, then pick the
  active one from the chip in the header. Switching a Claude account applies to
  running sessions on their next request; Codex sessions keep the account they
  started with until restarted.

## 0.3.1

### Patch Changes

- [`208c4ec`](https://github.com/ephor/warpforge/commit/208c4ec438554502c243a76954be4eff01b739bb) Thanks [@ephor](https://github.com/ephor)! - Orchestrators can now list their sub-agents, stop individual sessions without
  losing their history, and permanently clean up completed sessions in bulk.
  Active sessions are protected by default, and cleanup can be previewed before
  anything is removed.

- [`f8cd422`](https://github.com/ephor/warpforge/commit/f8cd422c1e767a9b836854a060c32188df1b23d3) Thanks [@ephor](https://github.com/ephor)! - Keep the task agent picker within the available viewport and make long agent lists scrollable.

- [`def2ec8`](https://github.com/ephor/warpforge/commit/def2ec83d4efd412bce82ef850059dc2499b161f) Thanks [@ephor](https://github.com/ephor)! - Chat rendering is now identical between MissionControl and TaskDetail views
  by extracting a shared SessionChat component with LegendList virtualization,
  work-group toggles, MessageActions overlay, and unified composer routing.

- [`81105f4`](https://github.com/ephor/warpforge/commit/81105f4626391a58b7d9b6aba671a48b683fda0c) Thanks [@ephor](https://github.com/ephor)! - Remove focus mode from Mission Control pinned tiles. The feature hid other tiles and disabled grid resize — unnecessary complexity for a dashboard overview.

## 0.3.0

### Minor Changes

- [#21](https://github.com/ephor/warpforge/pull/21) [`efed85f`](https://github.com/ephor/warpforge/commit/efed85fc0046f164a51e4b24fd04820896d3c988) Thanks [@lapa2112](https://github.com/lapa2112)! - Adds configurable workflows: a task can now run as a pipeline of agent stages
  instead of a single session. A workflow is a YAML file in your project's
  `.warpforge/workflows/`, and it decides which agent and model runs each stage,
  what each stage is told to do, what the reviewers see, and how many review
  rounds are allowed. Two built-in templates ship with the app — "Implement +
  review loop" and "Plan + implement + review loop" — and either can be copied
  into a project in one click to customize.

  Pick a workflow in the New Task dialog and the daemon drives the run: it plans
  (if the workflow asks for it), implements, then loops review and repair until
  the reviewers approve or the round limit runs out. Reviewers can be several
  different agents at once and return structured verdicts, and a repeat round
  continues in the same reviewer's session so it verifies its own findings
  instead of reviewing from scratch.

  The pipeline reports to the parent task as a timeline of stages, each with the
  agents that ran it — click one to open that agent's own session. It also stops
  for you when it needs to: a stage can ask a question, and running out of review
  rounds asks whether to grant more, finish as is, or stop. Pipelines can be
  paused between stages and resumed with extra guidance, survive a daemon restart
  by parking at their last safe point, and never commit anything — a finished run
  lands in Needs review for you to inspect.

  Reviewers can pin each finding to a line and a short code excerpt, so the
  repair stage goes straight to the right place instead of searching, and the
  summary a stage hands to the next one is its closing message rather than the
  whole turn's tool narration.

### Patch Changes

- [`fb4ebe3`](https://github.com/ephor/warpforge/commit/fb4ebe3a325ffd3fbf4c1179f6c41b9ac93a752e) Thanks [@ephor](https://github.com/ephor)! - The desktop file editor now previews SVG and common binary image files directly in the editor.

- [#21](https://github.com/ephor/warpforge/pull/21) [`efed85f`](https://github.com/ephor/warpforge/commit/efed85fc0046f164a51e4b24fd04820896d3c988) Thanks [@lapa2112](https://github.com/lapa2112)! - The workspace config has a new preferred home at `.warpforge/workspace.yaml`,
  alongside the new `.warpforge/workflows/` directory. Existing config files in
  the project root keep working exactly as before; only newly generated configs
  land in the `.warpforge/` directory.

- [`7f0fb40`](https://github.com/ephor/warpforge/commit/7f0fb408fe035ba67c9914a61ee34429d1d89e4a) Thanks [@ephor](https://github.com/ephor)! - wrap MessageActions dropdown in Portal to fix clipping

- [`3be74e7`](https://github.com/ephor/warpforge/commit/3be74e77def618833d1dc67e3e90dc2bf7710f06) Thanks [@ephor](https://github.com/ephor)! - Allow Mission Control cards to resize beyond the previous fixed height limit, auto-scroll the board while resizing, and preserve a small bottom gap after resizing.

- [`7ffd77e`](https://github.com/ephor/warpforge/commit/7ffd77edaa32304f41a48df55e174db3a604d06e) Thanks [@ephor](https://github.com/ephor)! - Tasks now support inline title editing and one-click AI title regeneration from the task detail view.

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
