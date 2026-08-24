# Changelog

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
