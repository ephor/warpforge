# 0004 — The project page is surfaces, and the backlog is a list

**Status:** accepted (2026-08-21)

Supersedes the presentation half of [0002](0002-issue-tracker-integration.md).
Its decisions about *where backlog data comes from* (one normalized `WorkItem`,
daemon-owned credentials, import-and-sync as one listing) all still hold; what
changes here is how that data is shown.

## Context

The project page had grown into a stack of collapsible cards — backlog, "agent
context", runtime — each fighting for the same vertical space and each pushing
the next below the fold. The task workspace had already solved this exact
problem with surface tabs (`Files | Diff | Runtime | Pipeline`), and the project
page is the same kind of screen: several unrelated views of one subject.

Separately, the backlog table had a paging bug that survived every attempt to
find it. Paging **forward** always worked; paging **back** intermittently left
the pager on the new page while the rows stayed on the old one, until a hover
forced a repaint. Ruled out, in order: the daemon (a stress run drove
`backlog.list` through `0→1→2→3→2→1→0` sixteen times — every response was
byte-for-byte identical per page, in 1–2 ms); SQLite paging (`ORDER BY
updated_at DESC, id ASC`, pinned by a store test); the client's own logic
(twelve jsdom tests, including paging back mid-flight); and the compositing
theory behind invariant 13, whose fix changed nothing the user could see. What
was left was a break somewhere between React Query's observer and TanStack
Table's memoized row model — a hunt with no bottom.

## Decisions

**The project page is a surface shell.** One header (name, path, ports, project
menu, New work item), one `SurfaceTabs` bar, one full-height panel. `SurfaceTabs`
became generic over its tab id (`SurfaceTab<T extends string>`) so the two pages
share the component without sharing a tab vocabulary; `WorkspaceSurface` stays
its default, so the task workspace is untouched. Adding Git or Pull Requests
later is a row in `PROJECT_SURFACE_TABS` plus a panel, not another page.

**The active surface is persisted per project** (`projectSurfaceByProject`),
like `runtimeOpenByProject` already was. Reopening a project you left on Runtime
should not snap back to Backlog. *Rejected:* one global surface — projects are
in different states, and the runtime-heavy one is not the backlog-heavy one.

**The backlog is an infinite list, not a paged table.** `useInfiniteQuery` +
LegendList, scrolling instead of a pager. This is chosen for the *class* of bug
it removes, not for the feel: with no page to be on, "the pager moved and the
rows did not" is not a thing that can be observed. Rows are appended, never
swapped, so no cached page is ever put back on screen — which is what the
paint bug needed. *Rejected:* keeping the table and continuing the hunt (the
budget for it was already spent, and the fix would have been a guess);
*also rejected:* dropping TanStack Table but keeping pagination, which would
have kept the exact interaction that broke.

**Fixed-width columns, one line per row.** The first version stacked each item
onto two lines (title above, metadata below) and pinned assignee and time to
the far right — on a wide window that is a lane of empty space with ragged
scraps on both sides. Every field after the title now has a fixed width, so the
list reads down its columns; narrow windows drop columns (source/number, then
priority, then assignee) rather than wrapping. The row actions occupy a
reserved slot, because an action that appears on hover must not shift the
columns beside it.

**Sorting moved into the toolbar.** With no column headers there is nothing to
click, so a sort-key Select plus a direction toggle sit next to the filters.
Both write into the one `BacklogParams` object (0002, invariant 9).

**Row click opens a drawer, not a route.** Details live in a right-hand sheet
over the list. The list keeps its scroll position and its filters, which also
retires the older complaint that opening an item threw them away.

**Priority is editable everywhere; status only for local items.** `backlog.update`
patches an item's own fields in whichever storage backend is configured. But an
imported issue's status is refreshed from its tracker on every sync, so a status
edited here would silently revert; those rows show the tracker's own label
instead. Priority is never synced back over, so it stays ours (0002:
"the local store stays the source of truth for title/priority").

**`file.contents` takes a project.** The Files surface reads a checkout with no
task attached, so `FileContents` gained `project: Option<String>` and falls back
to `project_path(project)` exactly as `ListFiles` already did. The preview is
read-only: saving belongs to a task, and the tree's create/rename/delete menu
items are hidden without a `taskId` rather than sending an empty one.

## Invariants

1. **No pager, no page state.** The page number belongs to the infinite query's
   cursor and to nothing else. `BacklogParams` deliberately has no `page` field:
   anything that can set a page can disagree with the rows on screen, which is
   the bug this replaced.
2. **Filters, search and sort change the query key**, which restarts the listing
   from the top. They must never be applied to already-fetched pages.
3. **`getNextPageParam` reads the daemon's `hasNextPage`**, not a count
   comparison — a concurrent import changes the total under the cursor.
4. **A row action keeps its space when hidden.** Rendering actions only on hover
   reflows the columns to their left on every mouse move.
5. **jsdom cannot render LegendList.** It measures its scroller and jsdom
   reports every box as zero, so any test that renders the backlog must mock
   `@legendapp/list/react` with `src/test/legendList.tsx`, which renders all
   rows and exposes `onEndReached` as a button.
6. **Radix tabs select on `mousedown`.** `fireEvent.click` does not send one, so
   surface-tab tests must go through `userEvent`.
7. **Do not offer an edit the next sync will undo.** Status for tracker-owned
   items is display-only; this is the same reasoning as 0002 invariant 6, from
   the other direction.

## Consequences

- `BacklogTable.tsx`, `BacklogPagination.tsx` and `columns.tsx` are gone, and
  with them `@tanstack/react-table`. `ui/table.tsx` stays for other views.
- 0002's invariants **11** (`backlogColumns` as a module constant), **12** (the
  pager reports the response's page) and **13** (never animate opacity on
  `<thead>`/`<tbody>`) describe components that no longer exist. 13's underlying
  claim about the Tauri WebView is still worth believing; the other two are
  history.
- The backlog page size went from 10 to 30: a scroll wants a screenful, not a
  pageful.
