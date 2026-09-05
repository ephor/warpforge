# Changelog

## 0.17.0

### Minor Changes

- [`15aa428`](https://github.com/warpforgehq/warpforge/commit/15aa4288fda82d3fbba558c90c01c2000d98e87c) Thanks [@ephor](https://github.com/ephor)! - Attach text files to chat prompts, not just images. Click the paperclip in the composer (or drag and drop, or paste) to add markdown, code, configs, CSV and any other text file — the full content reaches the agent, so it can answer questions about the file instead of guessing. Images keep working as before, and you can mix files and images in one message.

- [`8982d69`](https://github.com/warpforgehq/warpforge/commit/8982d69f5cbba7c3f5729f7c1090cfdd987a54e9) Thanks [@ephor](https://github.com/ephor)! - Settings has been redesigned. Pick a category on the left — Appearance, Agents, Integrations, Tasks, Memory, Advanced — instead of scrolling one long page, and each setting says what it does in a line. Your agent logins now show the quota they have left, right on the account.

  Chat scrolling is fixed. Scroll up while an agent is answering and you stay there instead of being dragged back to the newest message, and pasting a long log no longer freezes the window.

## 0.16.0

### Minor Changes

- [#47](https://github.com/warpforgehq/warpforge/pull/47) [`03b8dae`](https://github.com/warpforgehq/warpforge/commit/03b8daef0d13fea204aff5f858bf44f49798e32b) Thanks [@ephor](https://github.com/ephor)! - Automations: schedule a prompt to run on a project with the agent and model you
  pick — hourly, daily, weekdays, weekly, or any cron expression in your own time
  zone. Each run is a real task you can open from Mission Control, with an
  optional precheck gate (skip the run when a check fails), a reuse-session mode
  that keeps one ongoing conversation per automation, and a per-automation
  missed-run grace window so a laptop that slept for a week does not fire a
  week-old job on wake. Run history per automation shows what happened, when, and
  why anything was skipped. Agents can manage automations through the automation
  MCP tools.

### Patch Changes

- [#48](https://github.com/warpforgehq/warpforge/pull/48) [`74fcdea`](https://github.com/warpforgehq/warpforge/commit/74fcdea040119d354eb0951ab9179fccddd35758) Thanks [@ephor](https://github.com/ephor)! - Scheduled automation runs now tell the agent they are scheduled. Every run
  starts with a short line naming the automation and its run number and saying
  the turn is unattended, so the agent delivers the result instead of asking a
  clarifying question nobody is there to answer. This matters most for
  automations set to reuse the same task every run, where the identical prompt
  used to arrive in one conversation over and over and read as a person repeating
  themselves. Your prompt is passed through unchanged underneath, and it no
  longer has to explain that the run is automated.

- [#46](https://github.com/warpforgehq/warpforge/pull/46) [`6cd1944`](https://github.com/warpforgehq/warpforge/commit/6cd19446a1f57ddb20201677db31fec8e9508178) Thanks [@BatrakM](https://github.com/BatrakM)! - The language server list in Settings now loads in the installed app instead of spinning forever. Version checks are also bounded: a server that stops responding shows up as "not found" or without a version rather than holding up the whole list, and it no longer leaves stray processes running in the background. If a request to the workspace ever does go unanswered, the app now tells you instead of leaving a spinner on screen.

## 0.15.0

### Minor Changes

- [`993728e`](https://github.com/warpforgehq/warpforge/commit/993728e71f3c83508d9e02e51398b5c2dfa4ac55) Thanks [@ephor](https://github.com/ephor)! - Pin the exact ports your team's services run on — and commit them to the repo.

  Declare a port range in a project's config (`ports.range: "4200-4299"`), and every service in that project that declares a port now binds exactly that port. No more "port 3000 actually means 4000-something": if a pinned port is taken, the service fails loudly and tells you why, instead of silently moving. Services that prefer the old behaviour can opt back in with `portFallback: auto`.

  Ranges are assigned per project and stick for good — adding or removing a project no longer shuffles everyone else's ports, and two machines that declare the same range in the config now agree on the same ports. If two projects claim the same range, one of them refuses to start services until the conflict is resolved. A declared port that sits outside the project's range fails loudly too, with both ways out named in the error: move the port inside the range, or set `portFallback: auto`.

  One thing to know going in: a service's declared port used to be ignored — any free port in the project's range was used and passed to the app as `PORT`. In a project that declares a range it is now the exact port the service must bind, so if your app doesn't read `PORT` (hardcoded port instead), tell it the port via the environment or a `--port $PORT` flag in its command, or it will end up listening somewhere Warpforge isn't looking.

- [`993728e`](https://github.com/warpforgehq/warpforge/commit/993728e71f3c83508d9e02e51398b5c2dfa4ac55) Thanks [@ephor](https://github.com/ephor)! - See where a project's port range comes from — and fix conflicts on your machine only.

  Each project now shows whether its port range was declared in the team's shared config, set as a local override on your machine, or assigned automatically. When two projects claim the same range, the affected project says so up front and names the other project, with a one-field fix that applies to your machine only — the team's shared config is never edited from here. An existing local override can be cleared just as easily, and the badge stays visible the whole time so a machine-only range can't silently outrank the config. Pinned service ports are marked in the runtime view, with a reminder that a pinned port fails rather than moves when it's already taken.

## 0.14.0

### Minor Changes

- [`06c639a`](https://github.com/warpforgehq/warpforge/commit/06c639a2cb321ac71d90e571b9e09cefdc8cf429) Thanks [@ephor](https://github.com/ephor)! - See how much of each coding agent's quota is left before you run out mid-task. The task header now shows your session and weekly usage at a glance, and clicking it opens every agent you are signed into — Claude, Codex and OpenCode — with how much is left on each, when the limit resets, and what the work would have cost at API rates. When one login is spent you can see which of your others still has room and switch to it right there, without leaving the task. The same breakdown lives in Settings.

### Patch Changes

- [`873cd9f`](https://github.com/warpforgehq/warpforge/commit/873cd9ff4a1e8a4918ab39c72d33f1fd38db4f5d) Thanks [@ephor](https://github.com/ephor)! - Apps now start fast again on big workspaces. Connecting no longer loads every conversation up front; a chat loads its own full history the moment you open it, with a brief loading state until it appears in one piece. The "Needs you" badge now stays accurate right after startup, even before a conversation has streamed anything.

## 0.13.0

### Minor Changes

- [`5f5464a`](https://github.com/warpforgehq/warpforge/commit/5f5464ad12bec27b286853db98385c5dede7f0db) Thanks [@ephor](https://github.com/ephor)! - Faster cold start and automatic history cleanup. The app now loads only a small recent slice of each task's chat on connect, so starting after a while no longer hangs on a large database. Closed tasks keep their chat for 30 days, waiting tasks with no changes settle themselves after 2 weeks, and untouched closed tasks are removed after 90 days. Each step is visible with a notice, and all three windows are adjustable in Settings → Task history.

## 0.12.1

### Patch Changes

- [`ef18638`](https://github.com/warpforgehq/warpforge/commit/ef186383d8df36c518bcdc9cbd6c6bd1a66d4379) Thanks [@ephor](https://github.com/ephor)! - Pick up a conversation an agent can no longer resume. When an agent forgets its
  session — its own history expired or was cleaned up — the task used to sit
  blocked on a protocol error with nowhere to go. Warpforge keeps its own
  transcript, so now a banner offers to carry on: either hand the new session the
  whole conversation, or have it summarised into a handoff document first, with an
  estimate of what each option costs in context. You choose which harness and
  account writes that summary, which helps when the one you were using is out of
  quota.

  The same choice is available from "Continue with…" on any message, and handing a
  conversation to another agent no longer forces a separate worktree — keep it in
  the checkout you are already working in, and Warpforge remembers the choice.

- [`f1ec44e`](https://github.com/warpforgehq/warpforge/commit/f1ec44e3a18e517d9f0955da9ec6495f53e7819a) Thanks [@ephor](https://github.com/ephor)! - The model you pick for a task is now the model that runs it. Warpforge remembers
  your choice for the whole task, re-applies it whenever a session reconnects, and
  tells you when an agent refuses it instead of quietly falling back to its own
  default — a banner in the session and an entry in the "Needs you" rail name the
  model that was requested and why it did not take.

  The New Task picker no longer says "Default" when it will actually reuse the
  model you last chose; it shows which one you will inherit. And when you ask an
  agent to start a sub-agent on a specific model, it can look up the models that
  agent really offers and pick a valid one, instead of guessing a name that
  silently does nothing.

- [`24239db`](https://github.com/warpforgehq/warpforge/commit/24239db182ac63fcf31d0de33dac211b49d05b0f) Thanks [@ephor](https://github.com/ephor)! - Show nested git repositories properly in the Files tree. Folders containing
  their own git repo (or newly created, still-untracked folders) used to render
  as plain file rows and could not be expanded; their contents are now listed.

- [`0350a31`](https://github.com/warpforgehq/warpforge/commit/0350a3118dfacf2d5fa1002d48e359d496e81d6c) Thanks [@ephor](https://github.com/ephor)! - Reconnect notices no longer clutter the conversation. "Reconnecting to the saved
  agent session" now appears as a passing status with a spinner and disappears
  once the agent replies, rather than staying in the transcript forever, and the
  "Agent is waiting for the next instruction" line is gone — the composer already
  tells you that.

- [`408d20a`](https://github.com/warpforgehq/warpforge/commit/408d20ad78edeb3f55e141b64bd58bee622178a9) Thanks [@ephor](https://github.com/ephor)! - Session cost now reads as money. It is shown to the cent with a decimal point,
  so a few dollars no longer looks like a few thousand on machines where the
  comma is the decimal separator.

## 0.12.0

### Minor Changes

- [`4d7cf06`](https://github.com/warpforgehq/warpforge/commit/4d7cf0676cc8e7acb3be1a580524c183f1beea1b) Thanks [@ephor](https://github.com/ephor)! - Add Elixir syntax highlighting and IntelliSense in the editor, backed by elixir-ls/Lexical

### Patch Changes

- [`0cb5adb`](https://github.com/warpforgehq/warpforge/commit/0cb5adbb68f93d87c302b9fdf7c33ffcdc1c2832) Thanks [@ephor](https://github.com/ephor)! - Move line number next to filename in Go to Definition popup

- [`dbd03fd`](https://github.com/warpforgehq/warpforge/commit/dbd03fd0574eaa3f934e1d5a840d615889a535ce) Thanks [@ephor](https://github.com/ephor)! - Improve Go to Definition accuracy, ranking, and popup behavior

- [`e85401b`](https://github.com/warpforgehq/warpforge/commit/e85401ba13b45db814196f46f762c5a1ed69e9e4) Thanks [@ephor](https://github.com/ephor)! - Enable IntelliSense when browsing project files, not just task workspaces

## 0.11.1

### Patch Changes

- [`b653d60`](https://github.com/warpforgehq/warpforge/commit/b653d60cfe3c74d4244030c6ae937841a80c2458) Thanks [@ephor](https://github.com/ephor)! - Long chats no longer shimmer while an agent streams. The transcript used to
  slide and fidget as messages grew, especially in sessions with hundreds of
  rows: unmeasured rows drifted, and expanding or collapsing a group of tool
  results would yank the viewport off what you were reading.

  The transcript list now keeps its visible position anchored to the conversation
  edge instead of re-measuring everything on every token. Streaming text settles
  in place, and folding a work group keeps the toggle under your cursor instead
  of chasing the latest message. We also ported the upstream LegendList anchoring
  patch (and bumped `@legendapp/list` to 3.3.5) so the scroll engine can actually
  hold the end steady while content streams in.

- [`b399131`](https://github.com/warpforgehq/warpforge/commit/b399131728868edf7f6f7f4e1447cbc9a067cba4) Thanks [@ephor](https://github.com/ephor)! - Long chats no longer pin you to the bottom. Following the live edge used to
  re-engage across a huge window in a long session, so the instant you tried to
  scroll up it snapped you back down — you had to flick hard to break free. It
  now only follows when you are genuinely at the last message (a small pixel
  band), so reading back through a long transcript feels free again.

  Your own messages are also easier to spot. User bubbles are now rounder,
  pillowed, and right-aligned, so they read as you speaking instead of blending
  in with the flat tool-activity cards sitting beside them.

## 0.11.0

### Minor Changes

- [`fc10039`](https://github.com/warpforgehq/warpforge/commit/fc10039df85848b9f2bc4921664a44fbd581e3d0) Thanks [@ephor](https://github.com/ephor)! - GitHub backlog now prefers a PAT (`repo` + `read:project`) stored in keychain (Settings → Trackers), with `gh` CLI as deprecated fallback for backlog only (PR creation still uses `gh`). Sync reconciles remote status, removes deleted issues, surfaces missing-scope warnings via toast, and no longer blocks the daemon (parallel checks, 30s global timeout, immediate spinner).

### Patch Changes

- [`82f63d2`](https://github.com/warpforgehq/warpforge/commit/82f63d2aaae260762bd323ca078cddae412b30d4) Thanks [@ephor](https://github.com/ephor)! - The agent's session pickers (model, effort, and the "More" overflow) now close
  when you click anywhere else — in the composer textarea, the editor, or any
  other part of the app — instead of staying open until you click the trigger
  again. Opening one picker also dismisses the one you had open, so several can't
  stay open at once. The model picker keeps focus in its search box when it opens
  so you can start filtering right away.

- [`e4e744d`](https://github.com/warpforgehq/warpforge/commit/e4e744d3929534dd873ff86bf525558793ba917b) Thanks [@ephor](https://github.com/ephor)! - Project Files is now editable: the sidebar's file tree opens any checkout file
  in a write-enabled editor (⌘S to save), with `file.save` and `git.commit`
  addressed by project name when no task owns the file. Project files picked from
  the tree also open with the same WebStorm-style change gutter as task files —
  thin colored bars for added (green) and modified (blue) lines, a marker for
  deleted lines, and a click-to-revert / per-file commit popup.

- [`c8f12da`](https://github.com/warpforgehq/warpforge/commit/c8f12dae837165dfb08790a2ad488817344b75f3) Thanks [@ephor](https://github.com/ephor)! - Fix ghost backlog rows after deleting a task linked to a tracker item. Deleting a task now clears `backlog_items.task_id` / `tracker_links.task_id` and YAML `task_id` refs, resets status to `todo`, and invalidates the backlog query. The board only shows "Open task" when the task still exists.

- [`c8f12da`](https://github.com/warpforgehq/warpforge/commit/c8f12dae837165dfb08790a2ad488817344b75f3) Thanks [@ephor](https://github.com/ephor)! - Discovered follow-up work can now be saved directly to the local backlog as a
  todo item without starting an agent. The new `create_backlog_task` action
  supports a title, details, priority, and status; the older `create_task` name
  continues to work as a deprecated compatibility alias.

- [`26353aa`](https://github.com/warpforgehq/warpforge/commit/26353aa62d7aaec37766b0ab21dfa81f0ccd49a9) Thanks [@ephor](https://github.com/ephor)! - In the unified diff view, clicking a "changed lines" marker in a chat message
  now scrolls the editor to the matching change instead of leaving you to hunt
  for it. The move to a single CodeMirror editor had dropped that jump; it is
  restored via the editor's own scroll, so the changed rows (which CodeMirror's
  diff already tints) land in the center of the pane.

- [`afb8355`](https://github.com/warpforgehq/warpforge/commit/afb8355a4bd6363cda6d9735be78f8cb49101b2c) Thanks [@ephor](https://github.com/ephor)! - Dropdowns, menus, tooltips, and dialogs no longer make the button you clicked
  flicker. Opening a filter on the backlog board, switching between two
  dropdowns, or moving the mouse off a tooltip used to flash the control for a
  moment; now only the panel itself fades in and out, so clicking through filters
  stays calm.

- [`d6752c9`](https://github.com/warpforgehq/warpforge/commit/d6752c99f795a124863030bf038f6e6bbfc4d0ca) Thanks [@ephor](https://github.com/ephor)! - Dropdowns and context menus now read at the same size as the rest of the app
  instead of standing out — an open list of options or a task's "..." menu was
  noticeably larger than the rows behind it. Options sit tighter, and hovering
  one gives you a pointer cursor so it looks as clickable as it is.

- [`5dc8b5a`](https://github.com/warpforgehq/warpforge/commit/5dc8b5ac43805850f102fb66cba8090030466610) Thanks [@ephor](https://github.com/ephor)! - The desktop app now builds on Tailwind CSS v4, replacing the v3 PostCSS
  pipeline with the dedicated Vite plugin. The theme (colors, radii, fonts, and
  animations) moved into a single CSS `@theme` block, and the shadcn enter/exit
  animations are defined as native CSS keyframes instead of a plugin. The app's
  unified-diff and markdown surfaces now use the shadcn `typeset` typography
  system, giving chat and preview text a consistent, container-aware rhythm that
  follows the selected color theme.

- [`2c90796`](https://github.com/warpforgehq/warpforge/commit/2c907967bd79ecb30484ade34fe4ba4e6f0a6ae8) Thanks [@ephor](https://github.com/ephor)! - Rendered markdown now uses the shadcn `typeset` style system. Chat messages get
  a tight `typeset-chat` rhythm and the editor's markdown preview a roomier
  `typeset-docs` one, so headings, lists, code, and links read consistently and
  follow the active color theme. This replaces the old `prose` classes, which
  depended on a typography plugin the app did not ship.

- [`b38e771`](https://github.com/warpforgehq/warpforge/commit/b38e7719831f91abd6dee95c9c897fe4618d9373) Thanks [@ephor](https://github.com/ephor)! - The demo iframe on the marketing page now loads the desktop app's own
  stylesheet directly. The app's Tailwind v4 entry is self-contained (it scans
  its own source for classes), so the separate `app-theme.css` that used to point
  at the app's old v3 config is gone.

## 0.10.3

### Patch Changes

- [#44](https://github.com/warpforgehq/warpforge/pull/44) [`90e8f7a`](https://github.com/warpforgehq/warpforge/commit/90e8f7a4a8402f698029bb50a430fecc1cbcc983) Thanks [@ephor](https://github.com/ephor)! - The documentation site now wears the same wordmark as the app and the front page, instead of the site title in plain text.

- [#43](https://github.com/warpforgehq/warpforge/pull/43) [`630c234`](https://github.com/warpforgehq/warpforge/commit/630c234eed2fcaa8c42c9e497da119dcbd9fbc80) Thanks [@ephor](https://github.com/ephor)! - Warpforge has a documentation site. It covers the whole product rather than the quick start: installing it, bringing your own agents and running several logins for each, everything agents can do on your behalf, memory they share across harnesses, choosing between a single agent, an orchestrator and a workflow, writing workflows of your own, the day-to-day craft of working inside a task, the git surface, and a page for every setting.

  Its front page opens with Warpforge itself running rather than a screenshot: a real task plays through — a Claude lead handing the test suite to Codex, edits stacking up into a diff you can read line by line, a file tree and a terminal you can click into — and you can view the whole thing in any of the eight themes.

- [#43](https://github.com/warpforgehq/warpforge/pull/43) [`630c234`](https://github.com/warpforgehq/warpforge/commit/630c234eed2fcaa8c42c9e497da119dcbd9fbc80) Thanks [@ephor](https://github.com/ephor)! - The YAML backlog now writes to `.warpforge/backlog` in your project, alongside every other Warpforge file, instead of a misspelled `.workforge` directory. If you already have items under the old name, move that folder across once and they will be picked up.

- [#43](https://github.com/warpforgehq/warpforge/pull/43) [`630c234`](https://github.com/warpforgehq/warpforge/commit/630c234eed2fcaa8c42c9e497da119dcbd9fbc80) Thanks [@ephor](https://github.com/ephor)! - HTML previews in the editor now run their scripts, so an interactive prototype an agent just built behaves like one — click it instead of reading its markup. The preview stays isolated: it keeps its own origin and cannot reach anything else in Warpforge, submit forms, open popups, or navigate the app.

- [#43](https://github.com/warpforgehq/warpforge/pull/43) [`630c234`](https://github.com/warpforgehq/warpforge/commit/630c234eed2fcaa8c42c9e497da119dcbd9fbc80) Thanks [@ephor](https://github.com/ephor)! - Links to the project's source now point at its new home, `warpforgehq/warpforge` — in the app's changelog link, the docs, and the update feed the desktop app checks.

- [`38c2f43`](https://github.com/warpforgehq/warpforge/commit/38c2f43a2a3f512cd1507898dd19d562f731da69) Thanks [@ephor](https://github.com/ephor)! - Unified diff now uses CodeMirror's `unifiedMergeView` instead of the custom `<pre>` renderer, so wrapping tracks the container width, syntax highlighting and collapsed-unchanged handling match the split view, and backgrounds no longer clip on long lines.

## 0.10.2

### Patch Changes

- [#41](https://github.com/ephor/warpforge/pull/41) [`1f6909a`](https://github.com/ephor/warpforge/commit/1f6909a80c28efdb485d6ae25a95d85f89451912) Thanks [@lapa2112](https://github.com/lapa2112)! - Items you own can be deleted from their details panel, with a confirmation first — useful for the note you jotted down and no longer need. Issues that came from a tracker have no delete here: closing one belongs in the tracker it lives in, and a row removed on this side would return on the next sync.

- [#41](https://github.com/ephor/warpforge/pull/41) [`bc1bb6e`](https://github.com/ephor/warpforge/commit/bc1bb6e8e61ef1f916906bc4dfe43baf3547e521) Thanks [@lapa2112](https://github.com/lapa2112)! - Work items can carry a description again. The new-item dialog has a description field under the title — markdown, growing as you type — and on items you own the description is editable from the details panel: hover it and click the pencil, or start one on an item that has none. Escape backs out of an edit without closing the panel. Descriptions on issues that came from a tracker stay read-only, since the tracker is where they are written.

- [#41](https://github.com/ephor/warpforge/pull/41) [`27f16d0`](https://github.com/ephor/warpforge/commit/27f16d076c5dc31bbf650115c4c209a683a3c733) Thanks [@lapa2112](https://github.com/lapa2112)! - Items you own can be renamed from their details panel: click the title, type, and press Enter — Escape backs out. Emptying the field leaves the old title in place rather than saving a nameless row. Titles on issues that came from a tracker stay read-only, as their descriptions already do.

- [#41](https://github.com/ephor/warpforge/pull/41) [`f0dbe8f`](https://github.com/ephor/warpforge/commit/f0dbe8fabd15df60170cda8eaf06f5602c328a71) Thanks [@lapa2112](https://github.com/lapa2112)! - Backlog items now reflect what your tracker actually says. GitHub issues take their status from your project board — Todo, In Progress, In Test, Done — instead of every item reading "To do", and the board's own wording shows on the item's details. Created and Updated are the issue's real dates, so an item no longer looks like it was created the moment Warpforge first saw it, and Linear issues arrive with the person they are assigned to instead of showing as unassigned. Items imported earlier are corrected on the next sync; hit Sync in the backlog toolbar to refresh straight away. Board statuses come from your GitHub CLI sign-in, and items fall back to open/closed if it cannot see your projects.

- [#41](https://github.com/ephor/warpforge/pull/41) [`6e9e9d7`](https://github.com/ephor/warpforge/commit/6e9e9d77a237a165463a3b768c787cb61d80085e) Thanks [@lapa2112](https://github.com/lapa2112)! - Filtering the backlog by yourself now shows your own notes too. Items you create are put on you by default and can be reassigned or unassigned from the item's details, so they sit alongside the tracker issues assigned to you instead of dropping out of the view. The backlog also remembers how you left each project — filters and sort order survive switching projects and restarting — while the search box starts empty each time.

- [#41](https://github.com/ephor/warpforge/pull/41) [`c4d9ea9`](https://github.com/ephor/warpforge/commit/c4d9ea93a88ca413b5de979b4c6b08e286a51e4c) Thanks [@lapa2112](https://github.com/lapa2112)! - Warpforge now actually asks before doing something you cannot take back. Deleting a task, quitting while services are running, closing a half-written work item, and switching memory search to the downloadable model all went ahead silently — the prompt they relied on never appeared. Each one now shows a real dialog naming what is about to happen, with the failure reported instead of passing for success.

## 0.10.1

### Patch Changes

- [`2899b89`](https://github.com/ephor/warpforge/commit/2899b895ef4b8a3193b983a70518244e72c8eee1) Thanks [@ephor](https://github.com/ephor)! - Fix memory for agents: saving no longer fails after deleting a memory, and search now finds notes by tags and partial terms instead of returning empty results. Existing databases migrate automatically.

## 0.10.0

### Minor Changes

- [#40](https://github.com/ephor/warpforge/pull/40) [`f7c27a3`](https://github.com/ephor/warpforge/commit/f7c27a359c92188f4530c3890f4d79a41f90d521) Thanks [@ephor](https://github.com/ephor)! - Cross-harness memory for agents: one durable `~/.warpforge/memory.db` (global + per-project overlay) shared across Claude, Codex, opencode. FTS5 with optional vector hybrid (fastembed MiniLM-L6-v2 + vec0, RRF fusion, cosine). 8 MCP tools (`memory_store/search/list/update/delete`, `memory_edges/addEdge`, `memory_dream`, `memory_list/resolve_compaction`) so any harness can read/write the same store. Dreaming pass finds stale/duplicate/contradiction proposals (heuristic + code-aware LLM prompt), writes to `memory_compaction_log` for human approve/reject — manual Dream button in Settings or idle/cron background. Settings now shows per-scope stats and pending compaction count.

### Patch Changes

- [#39](https://github.com/ephor/warpforge/pull/39) [`d8fa4fe`](https://github.com/ephor/warpforge/commit/d8fa4fe3fcc51be2bc397803ff7c3c359bc26bca) Thanks [@ephor](https://github.com/ephor)! - Cap unbounded agent text merging and gate Live strip work behind its tab to reduce memory pressure and GC churn in Mission Control.

## 0.9.0

### Minor Changes

- [#38](https://github.com/ephor/warpforge/pull/38) [`24c0e62`](https://github.com/ephor/warpforge/commit/24c0e623790228f59005d5c3da1ec495d9022558) Thanks [@ephor](https://github.com/ephor)! - Redesigned Mission Control around four tabs — Live, Needs you, Failed and Pinned — with full-width Live rows, inline queue actions and a remembered active tab for faster triage. Restored the missing create_task MCP tool wiring.

## 0.8.0

### Minor Changes

- [#37](https://github.com/ephor/warpforge/pull/37) [`44d0494`](https://github.com/ephor/warpforge/commit/44d04945da009178fc0dd7db8db75133eb222b7e) Thanks [@ephor](https://github.com/ephor)! - Runtime shows a project's services and port-forwards in one place, with their live logs and the `http://localhost:…` address of anything that is up. A row carries its status and its name, and start, restart and stop appear on it when you point at it; starting or stopping everything at once is a single click in the Services or Port Forwards heading. Whatever you have selected is named in the toolbar itself, so the logs get the height instead. The side panels in Runtime and in the diff view fold away when you want the room.

- [#37](https://github.com/ephor/warpforge/pull/37) [`44d0494`](https://github.com/ephor/warpforge/commit/44d04945da009178fc0dd7db8db75133eb222b7e) Thanks [@ephor](https://github.com/ephor)! - Every project now has a backlog, and it can be fed straight from your issue tracker. Connect GitHub — Warpforge uses the `gh` CLI session you already have — or Linear with a personal API key, which is kept in your OS keychain. A project's open issues are imported when you open it and refresh on Sync. A Linear key is account-wide, so each project picks the Linear team it reads; until you pick one, that project imports nothing from Linear. New work items are created the same way whether they stay local or land in GitHub or Linear — the destination is just a chip on the form.

  The list loads more as you scroll, and each row reads across one line: title, status, priority, tracker, assignee and when it last changed. Search titles and bodies, filter by status, priority, tracker or assignee — your own account is offered first, since most of the time you are looking for your own work — and pick the sort order from the toolbar. Clicking a row opens its details beside the list instead of taking you elsewhere: the full description with any screenshots from the issue shown inline, assignee, timestamps, and a link straight to the issue. Priority is editable there, and so is status for items you wrote yourself; issues that came from a tracker show the tracker's own status, since that is where it is decided. Start task turns an item into an agent task and links the two, so the row offers Open task from then on. Escape or a click outside puts you back exactly where you were in the list.

- [#37](https://github.com/ephor/warpforge/pull/37) [`44d0494`](https://github.com/ephor/warpforge/commit/44d04945da009178fc0dd7db8db75133eb222b7e) Thanks [@ephor](https://github.com/ephor)! - A project opens into tabs, the same way a task does: Backlog, Files, Runtime and Terminal. Files browses the project's own checkout without starting a task — pick anything in the tree and it opens in a syntax-highlighted, read-only preview, with several files open at once across a tab strip. Runtime gets the whole screen for the project's services and port-forwards, and Terminal is a tab of its own beside it. Each project remembers the tab you left it on, and its name, path, port range and New work item stay pinned above them all.

### Patch Changes

- [`cc907fc`](https://github.com/ephor/warpforge/commit/cc907fc5eec374bc29c73223a0c9b9bbde461bb9) Thanks [@ephor](https://github.com/ephor)! - An open task now says which project it belongs to. The breadcrumb above it starts with the project's name instead of the app's, so switching between tasks from different projects no longer leaves you guessing which checkout you are looking at.

- [#37](https://github.com/ephor/warpforge/pull/37) [`44d0494`](https://github.com/ephor/warpforge/commit/44d04945da009178fc0dd7db8db75133eb222b7e) Thanks [@ephor](https://github.com/ephor)! - Surfaces across the app now agree with each other. The terminal and the Runtime panel sit on the same background as every other pane instead of their own shade, list rows highlight across their full width, and screenshots pasted into an issue render as pictures rather than raw markup.

## 0.7.0

### Minor Changes

- [`ce453d4`](https://github.com/ephor/warpforge/commit/ce453d40b2f68d96c6c059254f40e48f32f141ea) Thanks [@ephor](https://github.com/ephor)! - Search a whole project without leaving the task. Press ⌘⇧F (Ctrl ⇧ F) to open Find
  in Files: type anything and see every matching line grouped by file, with a live
  peek at the code around the highlighted hit. Enter opens the file right at that
  line, centered in the editor with the cursor already there, ready to type. The
  quick-open palette (double ⇧ Shift or ⌘P) now finds text too — matching source
  lines appear under the file names and jump straight to the line you picked, with a
  spinner while the search runs. Both palettes close on Escape from anywhere, or on a
  click outside, so an accidental open is never a trap.

### Patch Changes

- [`1b3503d`](https://github.com/ephor/warpforge/commit/1b3503defba03e4924752c223829e26e54d21350) Thanks [@ephor](https://github.com/ephor)! - New versions are now impossible to miss. When an update is available, a bright
  button appears in the top bar naming the version — one click downloads it, and a
  second one restarts Warpforge to finish. Progress and any failure stay on that same
  button, so the update never quietly stalls out of sight. The updates panel is still
  there for release notes and manual checks.

- [`9491bfd`](https://github.com/ephor/warpforge/commit/9491bfda05c80863e18d7f5d71d78ca0fe930f4b) Thanks [@ephor](https://github.com/ephor)! - Warpforge can now be installed with a single Homebrew command:
  `brew install --cask ephor/tap/warpforge`. The cask installs the same signed,
  notarized build as the DMG, and the built-in updater stays in charge of
  updates afterwards — Homebrew only handles the initial install.

- [`abb14af`](https://github.com/ephor/warpforge/commit/abb14af9c14836fac22afadbbd3d08e4df5ba43d) Thanks [@ephor](https://github.com/ephor)! - Project search now keeps up with your typing. Searching a mid-sized repository used
  to take seconds and stall while results trickled in; it now finishes in a fraction
  of that, so Find in Files and the quick-open palette respond as you type. Searches
  also stay on the files that belong to the project — build output, dependencies and
  other ignored files no longer bury the results you want.

## 0.6.8

### Patch Changes

- [`b6c5c64`](https://github.com/ephor/warpforge/commit/b6c5c64552bdec13a988edf899ed8fb53327919d) Thanks [@ephor](https://github.com/ephor)! - Connect Warpforge's service tools to your terminal agent once, and they follow you
  between projects. Previously a hand-configured connection had to name a single
  project up front, so an agent started in any other repository read the wrong
  runtime — or refused to start at all. Now the project is picked from the folder
  the agent runs in, including task worktrees, so one setup covers every project you
  have registered. Agents launched from Warpforge itself are unchanged.

- [`94f0a8a`](https://github.com/ephor/warpforge/commit/94f0a8a61804458512ace9bb20592f8490956df0) Thanks [@ephor](https://github.com/ephor)! - Service log timestamps now say they are UTC. Outside the UTC zone the bare
  timestamp read as a clock that had fallen hours behind, so a healthy service
  looked stalled; the lines now end in `Z`.

## 0.6.7

### Patch Changes

- [#35](https://github.com/ephor/warpforge/pull/35) [`65df616`](https://github.com/ephor/warpforge/commit/65df616be0d21d6dc907d513768fa75d841290bf) Thanks [@ephor](https://github.com/ephor)! - MCP tool names no longer show as raw `mcp__server__tool` strings in the
  transcript, permission prompts, or notifications. `mcp__warpforge__list_runtime`
  now renders as "Warpforge · List runtime".

  The orchestrator's `spawn_agent` title now surfaces who is being spawned and on
  what ("Spawn agent codex: Refactor the auth module") immediately, so a
  sub-agent dispatch is visible without expanding the tool.

- [#35](https://github.com/ephor/warpforge/pull/35) [`6a2e3e7`](https://github.com/ephor/warpforge/commit/6a2e3e7a17e415e55e10a7b1423d8bc825c0d5b5) Thanks [@ephor](https://github.com/ephor)! - Log reading tools now behave like `kubectl --timestamps | grep | tail`: every line
  carries a UTC timestamp, `filter` runs over the whole retained buffer before the
  newest `limit` are kept, and a new `context` option adds surrounding lines around
  each match (`grep -C`).

  Log cursors are now stable sequence numbers instead of buffer indexes. Each line
  gets a monotonic `seq`; `after` is inclusive of that seq and the response returns
  `nextSeq`, so polling for new lines is nearly free even as the ring buffer drops
  old ones. `logSeq` in `list_runtime` is the live cursor.

  Service lifecycle is now visible in the log stream: `[service running]`,
  `[service stopped]`, and `[service failed: exit code=N]` markers are injected on
  state transitions, so a restarting process no longer looks like empty logs.

- [#36](https://github.com/ephor/warpforge/pull/36) [`6ea2bcb`](https://github.com/ephor/warpforge/commit/6ea2bcb2516f563f296c082c588c83e117b69371) Thanks [@ephor](https://github.com/ephor)! - Very long conversations stay where you left them. Sending a message or watching
  an agent reply keeps the chat pinned to the newest message instead of drifting
  up into older history, and the chat now only stops following a reply when you
  actually scroll up — clicking a file link or expanding work updates leaves it
  pinned. Scroll back down to the newest message and it starts following again on
  its own.

- [#35](https://github.com/ephor/warpforge/pull/35) [`e19ef2b`](https://github.com/ephor/warpforge/commit/e19ef2b75cf145f55df277fecc8038c552993723) Thanks [@ephor](https://github.com/ephor)! - Agents working on a task can now inspect and control the project's running services on their own. They can read live service and port-forward logs, search them for errors, and start, stop, or restart a service without you copying logs into the chat by hand — the agent checks the runtime itself whenever it needs to.

## 0.6.6

### Patch Changes

- [`768c175`](https://github.com/ephor/warpforge/commit/768c1754f3629d015e3b50beaded2a35f857201e) Thanks [@ephor](https://github.com/ephor)! - Add html files preview in editor.

- [`7c997a4`](https://github.com/ephor/warpforge/commit/7c997a4697722f7a331672c097bb6cc7987be401) Thanks [@ephor](https://github.com/ephor)! - Native notifications now work. When an agent needs your approval, or a task
  wants attention while Warpforge is in the background, macOS shows a notification
  with Approve, Reject and Review buttons — and those buttons now do what they
  say, so you can answer a permission request without switching back to the app.
  Notifications stay quiet while Warpforge is the window you are looking at, so
  the in-app toast remains the only interruption when you are already there.

## 0.6.5

### Patch Changes

- [`0c75c45`](https://github.com/ephor/warpforge/commit/0c75c45d212b3490bc99cbff39510b5ff90af76a) Thanks [@ephor](https://github.com/ephor)! - Fixes the whole UI freezing after closing a dialog. Creating a project, opening settings, or any other modal could leave the page unclickable and text unselectable until restart.

  The freeze came from Radix shipping several copies of `@radix-ui/react-dismissable-layer` with different versions, each keeping its own lock on the page body. When a dialog and a dropdown or selector overlapped, the copies fought over the body's pointer-events and one of them never let go. Bumping the Radix packages and pinning `@radix-ui/react-dismissable-layer` to a single version so only one copy ships, removing the conflict at the root.

## 0.6.4

### Patch Changes

- [#34](https://github.com/ephor/warpforge/pull/34) [`c18d59d`](https://github.com/ephor/warpforge/commit/c18d59d577b4fe9bbf7012455530181de199e575) Thanks [@ephor](https://github.com/ephor)! - Amending a commit now starts from the message you already wrote. Tick amend in the Changes rail and the box fills with the commit you're rewriting, ready to edit or leave as it is — handy when you just forgot a file. Anything you had already typed is kept, and amending without touching the message no longer refuses to commit.

- [#34](https://github.com/ephor/warpforge/pull/34) [`c18d59d`](https://github.com/ephor/warpforge/commit/c18d59d577b4fe9bbf7012455530181de199e575) Thanks [@ephor](https://github.com/ephor)! - Model lists now keep up with your agents. Add a provider or model in the agent itself and Warpforge picks it up next time it starts — or right away with the refresh button next to the agent in Settings, which also shows how many models it currently knows about. Switching model or reasoning effort mid-conversation now shows your pick immediately and tells you if the agent turned it down, instead of leaving you guessing whether the click landed.

- [#34](https://github.com/ephor/warpforge/pull/34) [`c18d59d`](https://github.com/ephor/warpforge/commit/c18d59d577b4fe9bbf7012455530181de199e575) Thanks [@ephor](https://github.com/ephor)! - Long model lists are now searchable. Open the model picker in the composer and a search box sits pinned at the top of the list — type to narrow hundreds of models down to the one you want, clear it with the × button, and press Esc to close. Selectors with only a handful of choices stay as simple lists, so nothing extra gets in the way when you just need to switch reasoning effort.

- [#34](https://github.com/ephor/warpforge/pull/34) [`c18d59d`](https://github.com/ephor/warpforge/commit/c18d59d577b4fe9bbf7012455530181de199e575) Thanks [@ephor](https://github.com/ephor)! - Failures in the Changes rail now arrive as a notification with the reason instead of a block of text wedged under the commit box, and long output — a rejected pre-commit hook, say — comes with a Copy button for the full log. When an agent turns down a request, such as drafting a commit message, the message now includes the reason the agent gave, which is usually enough to tell a wrong model or a missing login from a real failure.

- [`024451f`](https://github.com/ephor/warpforge/commit/024451fae1d1dec2e1758e1379da832c6a818b58) Thanks [@ephor](https://github.com/ephor)! - The model picker no longer closes itself a moment after you open it. Searching a long model list now works the same everywhere Warpforge runs, instead of the menu disappearing before you finish typing.

## 0.6.3

### Patch Changes

- [`11b28da`](https://github.com/ephor/warpforge/commit/11b28dae4871b6af325c400cfbaf8a729b59eb70) Thanks [@ephor](https://github.com/ephor)! - The desktop agent setup now detects and can install more coding agents: Cursor, Pi, and Junie. Pick any of them in the setup wizard just like the existing agents — the daemon finds, installs, and keeps each one updated for you.

## 0.6.2

### Patch Changes

- [#33](https://github.com/ephor/warpforge/pull/33) [`c50688f`](https://github.com/ephor/warpforge/commit/c50688f34eb33269d6e9129fde94552be9996776) Thanks [@ephor](https://github.com/ephor)! - A workflow no longer ends for good when one of its agents is lost. If an agent
  process dies part-way through a stage — killed by something outside the run,
  not by anything wrong with the work — the pipeline now pauses at that stage
  instead of finishing as failed. Press Resume and it runs the stage again,
  warned that the working copy may already hold partial changes. Previously the
  run was over: resume was refused and the only way forward was a new task, even
  when the work was already done.

- [#33](https://github.com/ephor/warpforge/pull/33) [`98f58ea`](https://github.com/ephor/warpforge/commit/98f58eabbc9404d3d1ef77e14ca2014c50688802) Thanks [@ephor](https://github.com/ephor)! - Starting a task no longer pauses while its name is written. Naming a task runs
  a short agent in the background, and the app used to wait on it before handling
  anything else — so the first message, tool approvals, and other tasks all sat
  still until the name came back. Naming now happens alongside your work, as do
  installing an agent or a language server, which had the same problem and could
  hold things up for much longer.

- [#33](https://github.com/ephor/warpforge/pull/33) [`9689d81`](https://github.com/ephor/warpforge/commit/9689d813956d2a40bb28d29afc24d310765f31c3) Thanks [@ephor](https://github.com/ephor)! - The app now handles several requests at once instead of one at a time. A single
  slow action — listing a large project, loading a diff, scanning for agents —
  used to hold up everything else you did, so a tool approval could sit waiting
  until the slow one finished. Requests that only read now run alongside each
  other, and replies are sent without waiting on the network's send delay, which
  takes tens of milliseconds off routine actions.

- [#33](https://github.com/ephor/warpforge/pull/33) [`364e5b8`](https://github.com/ephor/warpforge/commit/364e5b8df3d7e16f95e716db6dc7bf195c7c8b67) Thanks [@ephor](https://github.com/ephor)! - Starting a task in its own workspace copy no longer holds up everything else.
  Setting that copy up takes a moment, and until now the whole app waited on it —
  your other tasks' replies and approvals paused until the new task's workspace
  was ready. The task now shows up on the board immediately and begins work as
  soon as its workspace lands, while the rest of the app keeps moving.

- [#33](https://github.com/ephor/warpforge/pull/33) [`c387c6f`](https://github.com/ephor/warpforge/commit/c387c6f27c79f7632d72001543e4b9f6583a2769) Thanks [@ephor](https://github.com/ephor)! - Branching a conversation now carries your uncommitted work across, including
  when the original task runs in the project folder itself rather than its own
  workspace copy. The branch used to start from the last commit in that case, so
  edits you had not committed were missing from the conversation meant to
  continue them.

- [#33](https://github.com/ephor/warpforge/pull/33) [`b05f44d`](https://github.com/ephor/warpforge/commit/b05f44d799811cd0a5db1936e99a1445743d446a) Thanks [@ephor](https://github.com/ephor)! - Searching for files no longer freezes the rest of the app. On a large project
  the search reads through every file, and until now everything else — agent
  replies, approvals, service controls — stopped until it finished. Search now
  runs out of the way, so the app keeps responding while it works.

- [#33](https://github.com/ephor/warpforge/pull/33) [`c41e691`](https://github.com/ephor/warpforge/commit/c41e6916efcdba8112c475500f1528974ed74a91) Thanks [@ephor](https://github.com/ephor)! - Merging a task's workspace copy back into your project no longer pauses the
  rest of the app while git works.

- [#33](https://github.com/ephor/warpforge/pull/33) [`22ba126`](https://github.com/ephor/warpforge/commit/22ba1269967fd05faab9005f0ef02236c08cdbc7) Thanks [@ephor](https://github.com/ephor)! - Approving a tool call, sending a message, or starting a task no longer waits on
  whatever else is happening. Previously, while an agent was streaming its answer,
  the app saved every fragment as it arrived and everything else queued up behind
  that — so an approval prompt could sit unresponsive for as long as the agent
  kept typing, even in a different task. Saving now happens out of the way, and
  the interface stays responsive while agents work.

- [#33](https://github.com/ephor/warpforge/pull/33) [`f73592d`](https://github.com/ephor/warpforge/commit/f73592dc7f3ba4c0f3145e4e2931708ae6a4b224) Thanks [@ephor](https://github.com/ephor)! - Long conversations no longer grow memory without limit. The app used to keep
  every line of everything your agents had said in memory and reload it all on
  start, so the more work agents did, the more memory the app held onto even when
  it was only showing the latest exchange. It now keeps just what the current
  view needs — the latest message and the most recent exchange — and loads the
  rest only when you resume a session or open a project. Resuming a session
  still shows each reply once, and nothing in the chat history is lost.

- [#33](https://github.com/ephor/warpforge/pull/33) [`1e5b63e`](https://github.com/ephor/warpforge/commit/1e5b63e92a5898e453dcef6455a2aeb18cce5ffd) Thanks [@ephor](https://github.com/ephor)! - Warpforge no longer stops processes it did not start. When shutting down it used
  to clear everything listening on the project's port range, which could take down
  a server you were running yourself — or, when running warpforge's own tests, the
  agents of the warpforge you were running them from. It now only stops the
  services it started.

- [#33](https://github.com/ephor/warpforge/pull/33) [`4227053`](https://github.com/ephor/warpforge/commit/4227053779c1b9bd082fd56eca0451edbae199b4) Thanks [@ephor](https://github.com/ephor)! - Viewing changes no longer slows the rest of the app down. The changes panel
  refreshes on a timer, and each refresh used to hold everything else up while it
  inspected the repository — with a task open, that was a steady drip of pauses
  affecting agent replies and approvals. Reading diffs, file contents, file lists
  and branches now happens alongside the rest of the app instead of in front of
  it.

- [#33](https://github.com/ephor/warpforge/pull/33) [`ec03690`](https://github.com/ephor/warpforge/commit/ec03690aa18f3636c4931dad97a75d8607f57576) Thanks [@ephor](https://github.com/ephor)! - Committing, pushing, merging, switching branches, saving a file and opening a
  pull request no longer pause the rest of the app while they run. Each of these
  waits on git, and until now everything else — agent replies, approvals, your
  other tasks — waited with it. They now run alongside your work, so a slow push
  costs you the push and nothing else.

## 0.6.1

### Patch Changes

- [`05dbe4c`](https://github.com/ephor/warpforge/commit/05dbe4cf7ad60d60cc1a532c8cae0b0080b1afb7) Thanks [@ephor](https://github.com/ephor)! - IntelliSense is now one install away. When a language server is missing—say you open a `.ts`, `.py`, or `.rs` file and the server isn't on your machine—the editor shows a one-click **Install** banner instead of silently falling back to plain syntax highlighting. Install (or update) any supported language server from **Settings → Language servers**, where each language shows its status: installed, update available, or not found, with a single button to fix it. Warpforge picks the right package manager for your setup (npm, bun, pnpm, or Homebrew) and refreshes the editor automatically once the server is ready, so completion, diagnostics, hover, and go-to-definition just start working.

## 0.6.0

### Minor Changes

- [`feb128b`](https://github.com/ephor/warpforge/commit/feb128b59848f13a033c6a60497f03ff30cf0d3b) Thanks [@ephor](https://github.com/ephor)! - Code editor selections now offer a floating "Send to chat" action (and a
  Cmd/Ctrl+L shortcut) that drops the selected lines into the task chat as a file
  reference. The popover sits below a single-line selection so it no longer covers
  the selected text. Also fixes the editor's focused-selection flash on dark
  themes, where CodeMirror's built-in light rule painted near-white over text — the
  selection tint now always follows the app theme.

## 0.5.0

### Minor Changes

- [#32](https://github.com/ephor/warpforge/pull/32) [`956a6af`](https://github.com/ephor/warpforge/commit/956a6afde0e86396851e12ae1aacf09863226507) Thanks [@ephor](https://github.com/ephor)! - Code editing in Warpforge just got a major upgrade. The editor now brings intelligent language support into your workspace: jump from any symbol to its definition with Cmd/Ctrl-click or Cmd+B, see errors and warnings directly in your code, inspect documentation on hover, get completions as you type, find references, rename symbols, and format code. Double-Shift or Cmd/Ctrl+P opens any project file instantly, making large codebases much faster to navigate. Your work stays under your control too: edits are saved only when you explicitly press Save or Cmd/Ctrl+S.

### Patch Changes

- [#31](https://github.com/ephor/warpforge/pull/31) [`eceb85d`](https://github.com/ephor/warpforge/commit/eceb85dccbf11d8f34b9e698365aee39a72adb8e) Thanks [@ephor](https://github.com/ephor)! - Branch Delete now force-deletes (`git branch -D`, equivalent), so deleting an
  unmerged local branch from the branch-switcher context menu no longer fails
  with "not fully merged". The dialog already confirms the action is
  irreversible, matching the force semantics.

- [#31](https://github.com/ephor/warpforge/pull/31) [`65ed890`](https://github.com/ephor/warpforge/commit/65ed8906e6c3017fc1f2383e055158b3eaa04566) Thanks [@ephor](https://github.com/ephor)! - Branch actions now open as a detached dark submenu beside the branch row,
  rather than expanding the branch list vertically. Branch names are action
  triggers instead of implicit checkouts, and the submenu keeps its position
  clear while preserving the IDE-style branch actions.

- [#27](https://github.com/ephor/warpforge/pull/27) [`8498f21`](https://github.com/ephor/warpforge/commit/8498f21a614fb2ff8cdb030fca5db344fcea957b) Thanks [@ephor](https://github.com/ephor)! - Add a "View changelog" link to the desktop update dialog that opens the repository changelog in the browser.

- [#31](https://github.com/ephor/warpforge/pull/31) [`0cd394c`](https://github.com/ephor/warpforge/commit/0cd394c48281f2b31115e4674110075f48a6b3e1) Thanks [@ephor](https://github.com/ephor)! - File listing, reading, saving, and filesystem actions now resolve task
  worktrees before falling back to the project checkout. This keeps Project
  Files, diff state, editor writes, Finder actions, and delete/rename/create
  operations pointed at the same working copy.

- [#31](https://github.com/ephor/warpforge/pull/31) [`5c027d6`](https://github.com/ephor/warpforge/commit/5c027d61fceb75eb932bc1bfc74b2795910109a0) Thanks [@ephor](https://github.com/ephor)! - Expand native file context menus:

  - Project Files: Open, Copy Path, Reveal in Finder, Open in Default App, and
    Refresh.
  - Changes rail: Show Diff, Jump to Source, Stage/Unstage, Rollback File, Copy
    Path, and Refresh.

- [#31](https://github.com/ephor/warpforge/pull/31) [`13524d5`](https://github.com/ephor/warpforge/commit/13524d5e4cad999bed9f9149fb5a751c08c1e896) Thanks [@ephor](https://github.com/ephor)! - Project Files now removes physically deleted tracked files from its listing.
  The file list explicitly refetches after filesystem mutations instead of only
  marking the query stale.

- [#31](https://github.com/ephor/warpforge/pull/31) [`08c6acb`](https://github.com/ephor/warpforge/commit/08c6acb92a905ce13d25fddda4651e90c6ffec49) Thanks [@ephor](https://github.com/ephor)! - Project Files now supports real filesystem actions from its native context
  menu: New File, New Folder, Rename, and Delete. Operations are daemon-backed,
  validate relative paths, refresh the tree after success, and require an
  explicit dialog confirmation for deletes.

- [#31](https://github.com/ephor/warpforge/pull/31) [`a0bff5f`](https://github.com/ephor/warpforge/commit/a0bff5fcf914f9b7941f0b6a402c70eec4ddf801) Thanks [@ephor](https://github.com/ephor)! - Add a global `New Branch…` action to the branch dropdown. It creates a branch
  from the current branch and checks it out after creation, while branch-specific
  `New Branch from…` actions remain available in each branch submenu.

- [#31](https://github.com/ephor/warpforge/pull/31) [`5fed599`](https://github.com/ephor/warpforge/commit/5fed599222e80c2c6ec4d4b0c8fb762377d2e998) Thanks [@ephor](https://github.com/ephor)! - More native right-click menus, extending the context-menu foundation to the rest of the desktop surfaces:

  - **Project files panel** — right-click a file for Open or Copy Path; right-click a folder to Expand/Collapse or Copy Path.
  - **Chat transcript** — right-click any user or assistant message to Copy it as plain text.

  Infra unchanged: all three surfaces reuse the existing Tauri `show_context_menu` command and `useNativeContextMenu` hook.

- [#31](https://github.com/ephor/warpforge/pull/31) [`400efbe`](https://github.com/ephor/warpforge/commit/400efbe99ae34a3a3a8848d7d1dce3e090d86b66) Thanks [@ephor](https://github.com/ephor)! - Native OS context menus now back the two main git surfaces, so the desktop app finally feels like an IDE:

  - **Changes rail** — right-click a changed file/folder for Stage/Unstage, Open in Diff, and Copy Path.
  - **Branch switcher** — right-click any branch for Rename Branch…, Delete Branch… (non-checked-out only), Rebase Onto…, and Merge Branch Into…, each via a small dialog. New daemon ops: `git.branchRename`, `git.branchDelete`, `git.rebase`, `git.merge`, all rollback-safe (stash/abort/restore on conflict) like the existing `git.switchBranch`.

  Reusable infra underneath: a Tauri `show_context_menu` command + `useNativeContextMenu` hook for wiring future right-click menus.

- [#31](https://github.com/ephor/warpforge/pull/31) [`97ae62c`](https://github.com/ephor/warpforge/commit/97ae62c6d328afcbd9e563cb8fa7ac0c3fd7e141) Thanks [@ephor](https://github.com/ephor)! - New Branch now includes Checkout branch and Override existing branch options.
  Branch names that already exist on a remote are highlighted and require the
  override option before creation. The daemon honors both options.

- [#29](https://github.com/ephor/warpforge/pull/29) [`bd4b384`](https://github.com/ephor/warpforge/commit/bd4b384ffca4782c7628796876ff55ae775dd09a) Thanks [@ephor](https://github.com/ephor)! - Task rows in the sidebar now expose Archive and Delete from their overflow menu, matching the action menu inside a task's detail view — so a task can be archived or removed without opening it first.

- [#31](https://github.com/ephor/warpforge/pull/31) [`26aec23`](https://github.com/ephor/warpforge/commit/26aec233696f7ff0411ba6aad92075c1092b89f6) Thanks [@ephor](https://github.com/ephor)! - Rebase actions now update the selected branch without checking it out first,
  matching WebStorm's `Rebase '<branch>' onto '<target>'` behavior. The daemon
  uses `git rebase --onto ... ... <branch>` and restores the current working tree.

- [#31](https://github.com/ephor/warpforge/pull/31) [`b0190d9`](https://github.com/ephor/warpforge/commit/b0190d99d765001e09f86250b11e106bf7c7fddc) Thanks [@ephor](https://github.com/ephor)! - Remote branch submenus now expose supported integration actions: rebase the
  current branch onto a remote ref, merge a remote ref into the current branch,
  and pull using either rebase or merge. Remote branches remain non-checkout
  rows; checkout-as-local is still available separately.

- [#31](https://github.com/ephor/warpforge/pull/31) [`c85f7a6`](https://github.com/ephor/warpforge/commit/c85f7a685f95e5fb4c912953bbb6dbfb186243ba) Thanks [@ephor](https://github.com/ephor)! - Remove the non-functional branch "Compare or Show Diff with" action and its
  unused daemon RPC. Branch menus now only expose supported operations.

- [#31](https://github.com/ephor/warpforge/pull/31) [`647796d`](https://github.com/ephor/warpforge/commit/647796dc1b98491b2f7797313158bf6192c0d8f9) Thanks [@ephor](https://github.com/ephor)! - Rollback and git operations (commit, update, switch, branch, rebase, merge)
  now run against the task's worktree instead of the project root, so changes
  are applied where the diff is shown.

- [#31](https://github.com/ephor/warpforge/pull/31) [`a77ace9`](https://github.com/ephor/warpforge/commit/a77ace91eb01fdcd7a1f3d8808d05d281f968aa7) Thanks [@ephor](https://github.com/ephor)! - Show remote-tracking branches correctly in the branch tree. Git can emit the
  remote name itself (for example `origin`) alongside `origin/main`; the branch
  list now filters that namespace marker so remote branches are not hidden.

- [#30](https://github.com/ephor/warpforge/pull/30) [`fa829f0`](https://github.com/ephor/warpforge/commit/fa829f079a849470394b27d282c9deab6de6d22e) Thanks [@ephor](https://github.com/ephor)! - TheoMod, a Settings easter egg (Socket → Settings → Fun): blurs email addresses everywhere they render — agent account chips, the account switches on the Claude/Codex bar, and the Accounts panel. Hover (or focus) un-blurs; copy still returns the real address.

- [#31](https://github.com/ephor/warpforge/pull/31) [`38cddb8`](https://github.com/ephor/warpforge/commit/38cddb8c076334615836ffbe58e89f863a38d833) Thanks [@ephor](https://github.com/ephor)! - Rework the branch switcher into an IDE-style tree: local and remote branches
  are separated, slash-prefixed names form expandable folders, and each branch
  has a visible actions button. Branch actions now include checkout, creating a
  branch from a ref, checkout-and-rebase/update, compare stats, update, push,
  rename, delete, rebase, and merge.

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
