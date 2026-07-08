# Desktop redesign — handoff

Status: **incomplete / needs rework**. The owner judged the visual result a fail vs the
JetBrains Air / Junie reference. This documents exactly what was changed, what works
mechanically, where it diverges from the reference, and what's left — so a fresh session
can continue (or redo) without re-deriving everything.

## Goal (reference = JetBrains Air / Junie)

Screenshots the owner shared (image cache
`~/.claude/image-cache/bb2fde90-adc5-47aa-9a0f-ee3037d825a3/`):

- **#21** — full app, "Changes" mode. **Island layout**: rounded panels floating on a
  near-black canvas with consistent gaps (NOT flush borders). Thin top bar:
  `[sidebar-toggle][chat][+]  project ⑂branch  ……  [WS][right-panel-toggle]`.
  Columns: **left** = task compose/chat ("New Task in Local Workspace" + composer with
  model/agent/send); **center** = editor with real tabs (`layout.tsx · page.tsx ·
  All Changes · content-patterns.md`) showing code/diff; **right** = "Changes" rail
  (staging tree `project › folder › files` with `M` glyph, `+adds -dels`, per-row
  checkbox → bottom commit message + blue `Commit ⌘↩`). Far right = vertical tool-window
  icon strip.
- **#22** — "Editor" mode. Left gains a **task list** (`Search tasks / + New Task /
  Previous 7 days`). Right panel switches from "Changes" to "**Files**" = full project
  file tree navigator. Center = editor tabs.
- **#20** — cropped center header: `[Changes | Editor]  9 files  ⑂ main  … [tree][Unified|Split]`.

Key model I only understood late: **the right panel has two modes tied to the center tab** —
`Changes` (staging tree + commit) vs `Files` (full project tree) in Editor mode. And the
whole thing is **island design**, not flush columns.

## Decisions locked with owner

- Phased delivery, approve each phase.
- Terminal: **services/PF status only** for now (no interactive vt100). Done.
- Commit: **build the git RPC now**. Done (backend solid).
- Sidebars: attention rail app-level on every screen + Changes rail on detail.
- Changes rail must match #21 (tree + inline checkboxes + counts + bottom commit).
- Editor tab: **full editor later**; stub for now.

## Commits this session (branch `claude/warpforge-daemon-desktop-xd555d`)

1. `feat(desktop): centralize UI state in zustand store` — Phase 0.
2. `feat(desktop): app-level attention sidebar, toggleable on every screen` — Phase 1.
3. `feat(desktop): 3-zone TaskDetail — collapsible chat/changes + Changes/Editor switch` — Phase 2.
4. `feat: git.commit RPC + inline commit box (staging, message, amend)` — Phase 3.
5. `feat(desktop): runtime services/port-forward status panel in TaskDetail` — Phase 4.
6. `feat(desktop): JetBrains-style Changes rail (staging tree + inline commit) as its own island` — rework.
7. `feat(desktop): MissionControl — bigger tiles w/ live preview, pinned leave grid` — Phase 5.

Phase 5 done: `SessionTile` enlarged with a live coalesced conversation preview (same
`StreamLine compact` stream as `FocusPane`, last 5, faded), pinned tasks excluded from the
grid (`gridTasks = live.filter(!pinned)`), tiles have Pin + Expand buttons, `FocusPane`
keeps Expand + Unpin, pin cap 4. Removed the old one-line `activityLine`.

## What was built (mechanically works; `npx tsc --noEmit` clean, `cargo check`/`cargo test -p warpforge-protocol` pass)

**Backend (Rust) — this part is fine and reusable:**
- `git.commit` RPC end-to-end: `Method::GitCommit {task_id, message, files: Option<Vec<String>>, amend}`
  in `crates/warpforge-protocol/src/lib.rs`; `diff::commit()` in `src/daemon/diff.rs`
  (`git add -- <files|.>` then `git commit -m [--amend]`, returns stderr on failure);
  `Command::GitCommit` + `DaemonHandle::git_commit()` (await-and-return, mirrors
  `file_contents`) in `src/daemon/actor.rs`; dispatch in `src/daemon/server.rs`. On success
  emits `TaskUpdated` with `files_changed = 0` so clients refetch.

**Frontend:**
- `src/store/ui.ts` — zustand + `persist` (key `wf-ui`). Slices: `view`, `openTaskId`
  (transient, partialized out), `attentionOpen`, `showChat`/`showDiff`/`showTree`,
  `centerTab`, `diffView`, `runtimeOpen`. `App.tsx` and `TaskDetail` read from it; replaced
  scattered `useState`+`localStorage`. **This is a good foundation, keep it.**
- `src/components/AttentionRail.tsx` — extracted "Needs you" rail; rendered at App shell
  left of `<main>` on every screen; header `PanelLeft` toggle (`attentionOpen`).
  `MissionControl` no longer embeds it.
- `TaskDetail.tsx` — 3 island panels via `ResizablePanelGroup`: chat (`id=chat` order 1),
  center (`id=center` order 2), changes (`id=changes` order 3). Top-header toggles:
  chat / center / runtime. Center header: `Changes | Editor` segmented (Editor disabled
  stub), tree-toggle, `Unified | Split`.
- `src/components/ChangesRail.tsx` — staging tree grouped `project › folder › files`
  (single-child folders compacted), per-file `M/A/D/R` glyph + `+adds/-dels` (counted from
  hunk lines) + checkbox; folder tri-state checkbox toggles descendants; `N/M files` bar
  with select-all; bottom commit message + `amend` + `Commit` → `git.commit`.
- `src/components/RuntimePanel.tsx` — read-only services + port-forwards for the task's
  project (reuses `serviceBadge`/`pfBadge`). Collapsible strip at bottom of center.
- Removed `src/components/CommitBox.tsx` (folded into ChangesRail).

## Where it diverges from the reference (the "fail" — fix these)

These are the likely reasons the result looks wrong. Verify each against #21/#22:

1. **Center is not a tabbed editor.** Reference center has file tabs (`layout.tsx`,
   `page.tsx`, `All Changes`, a file) and shows code. Ours only has a diff view + a dead
   `Editor` stub. No tabs, no "All Changes" tab, no open-file editing in center.
2. **No "Files" mode for the right panel** (#22). Right panel should switch to a full
   project file tree when in Editor mode. Not built (owner said editor later, but the
   Changes/Editor switch as shown implies this).
3. **Island styling probably still rough.** Intended islands = rounded panels + consistent
   gap + dark canvas. Check: gap sizes, panel radius/border, canvas bg (`bg-background`
   vs a darker canvas behind cards), header weights/paddings. JetBrains uses very tight,
   even spacing; ours may look uneven ("налеплено").
4. **Left column model differs.** Reference left = task compose + (in #22) a task list with
   search. Ours left = the agent conversation stream + composer. The attention rail we made
   app-level is a separate "Needs you" concept, not the JetBrains task-list rail. Reconcile
   the intended IA: is the app-left a task list (#22) or the "Needs you" rail?
5. **Top bar differs.** Ours: `warpforge` + nav tabs (Mission Control/Board/Projects) +
   PanelLeft toggle. Reference: minimal `[sidebar][chat][+] project ⑂branch … [WS][right]`.
   No vertical tool-window icon strip on the far right.
6. **ChangesRail visual details** vs #21: colors of `M` glyph, count alignment, the
   `0/5 files` bar icons (revert-all, settings), commit split-button `⌘↩ ▾` + generate icon,
   spacing. Ours is functional but not pixel-close.
7. **Editor/Changes toggle placement.** Reference shows it in the center pane header with
   `9 files ⑂ main` beside it and `Unified|Split` on the right — ours is close but the
   branch chip + file count moved around; re-check against #20.

## Not done

- Real Editor (tabs + editable file + Files tree, #22).
- Interactive terminal (daemon already streams vt100 grid; desktop drops
  `terminal.screen`/`terminal.exited` in `daemon.ts`).
- Top-bar restyle + vertical tool-window strip.

## Build / run / verify

- Typecheck: `cd desktop && npx tsc --noEmit`.
- Rust: `cargo check --bin warpforge`; `cargo test -p warpforge-protocol`.
- Daemon has **no hot reload** — rebuild + restart the binary after Rust changes.
- Desktop: run the tauri/vite dev script; UI prefs persist in localStorage `wf-ui`
  (clear it if a stale toggle state confuses testing).
- `git.commit` smoke test: open a task with changes → Changes rail → uncheck some files →
  message → Commit → committed files leave the diff; `amend` re-commits into HEAD; git
  errors surface in the rail.

## Suggested approach for the redo

Before coding, pin the IA with the owner using #21/#22 as the spec: (a) confirm the
app-left is a **task list** and the per-task chat is a column inside detail; (b) build the
center as a **real tabbed editor** (CodeMirror) with an "All Changes" diff tab; (c) make the
right panel mode-switch Changes↔Files; (d) nail island tokens (gap/radius/canvas) first as a
layout skeleton, then fill panels. The zustand store, `git.commit` backend, `ChangesRail`
tree/commit logic, `AttentionRail`, and `RuntimePanel` are reusable — the gap is layout
fidelity and the editor, not the plumbing.
