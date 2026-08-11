import { describe, expect, it } from "vitest";

import type { AttentionItem } from "@/lib/attentionRail";
import { statusLabel } from "@/lib/statusMeta";
import { buildTaskForest } from "@/lib/taskGroups";
import type { TaskInfo } from "@/protocol";

import {
  SIDEBAR_STATE_META,
  ancestorIds,
  buildSidebarRows,
  isSettledTask,
  isSettledTree,
  isSnoozed,
  needsHuman,
  projectNames,
  resolveTaskState,
  rowHeight,
  snoozeWakeLabel,
  sortProjectsByActivity,
  type SidebarRow,
  type SidebarTaskState,
} from "./Sidebar.logic";

const NOW = 1_700_000_000;

function task(id: string, overrides: Partial<TaskInfo> = {}): TaskInfo {
  return {
    agent: "codex",
    blockedReason: null,
    createdAt: 1,
    filesChanged: 0,
    id,
    parentTaskId: null,
    project: "warpforge",
    prompt: id,
    status: "waiting",
    tags: [],
    title: "",
    updatedAt: 1,
    ...overrides,
  };
}

function attention(item: TaskInfo): AttentionItem {
  return { priority: 1, reason: "needs you", task: item };
}

function build(tasks: TaskInfo[], overrides: Partial<Parameters<typeof buildSidebarRows>[0]> = {}) {
  return buildSidebarRows({
    collapsedProjects: new Set(),
    expandedShelves: new Set(),
    expandedTaskIds: new Set(),
    forceVisibleTaskIds: new Set(),
    forest: buildTaskForest(tasks),
    nowSec: NOW,
    openProject: null,
    projectOrder: ["warpforge"],
    queue: [],
    tasks,
    ...overrides,
  });
}

function taskRows(rows: SidebarRow[]) {
  return rows.filter((row) => row.kind === "task");
}

describe("resolveTaskState", () => {
  it("lets lifecycle overrides outrank the reported status", () => {
    const snoozed = task("a", { snoozedAt: NOW - 10, snoozedUntil: NOW + 60, status: "running" });
    expect(resolveTaskState(snoozed, { attention: false, nowSec: NOW })).toBe("snoozed");

    const settled = task("b", { settledOverride: true, status: "waiting", filesChanged: 1 });
    expect(resolveTaskState(settled, { attention: true, nowSec: NOW })).toBe("settled");
  });

  it("says 'needs you' rather than contradicting the row's own warn glyph", () => {
    const running = task("a", { status: "running" });
    expect(resolveTaskState(running, { attention: true, nowSec: NOW })).toBe("needs_answer");
    expect(resolveTaskState(running, { attention: false, nowSec: NOW })).toBe("working");
  });

  it("keeps an explicit status when the task is already in the queue for it", () => {
    expect(
      resolveTaskState(task("a", { status: "waiting", filesChanged: 1 }), {
        attention: true,
        nowSec: NOW,
      }),
    ).toBe("review");
    expect(
      resolveTaskState(task("b", { status: "blocked" }), { attention: true, nowSec: NOW }),
    ).toBe("blocked");
    expect(
      resolveTaskState(task("c", { status: "interrupted" }), { attention: true, nowSec: NOW }),
    ).toBe("failed");
  });

  it("maps the remaining statuses one to one", () => {
    expect(
      resolveTaskState(task("a", { status: "queued" }), { attention: false, nowSec: NOW }),
    ).toBe("queued");
    expect(resolveTaskState(task("b", { status: "done" }), { attention: false, nowSec: NOW })).toBe(
      "done",
    );
  });

  it("splits the one waiting status into its two rows on the diff, not the status", () => {
    const withDiff = task("a", { status: "waiting", filesChanged: 4 });
    const withoutDiff = task("b", { status: "waiting", filesChanged: 0 });
    expect(resolveTaskState(withDiff, { attention: false, nowSec: NOW })).toBe("review");
    expect(resolveTaskState(withoutDiff, { attention: false, nowSec: NOW })).toBe("idle");
    // Both are resting: neither may put a glyph on the row.
    expect(SIDEBAR_STATE_META.review.rowGlyph).toBe(false);
    expect(SIDEBAR_STATE_META.idle.rowGlyph).toBe(false);
  });
});

describe("state encoding", () => {
  it("labels every state, reusing statusMeta wherever a status maps 1:1", () => {
    // `review` is derived from filesChanged, not reported, so it owns its word.
    expect(SIDEBAR_STATE_META.review.label).toBe("needs review");
    expect(SIDEBAR_STATE_META.blocked.label).toBe(statusLabel("blocked"));
    expect(SIDEBAR_STATE_META.failed.label).toBe(statusLabel("interrupted"));
    expect(SIDEBAR_STATE_META.working.label).toBe(statusLabel("running"));
    expect(SIDEBAR_STATE_META.queued.label).toBe(statusLabel("queued"));
    expect(SIDEBAR_STATE_META.idle.label).toBe(statusLabel("waiting"));
    expect(SIDEBAR_STATE_META.done.label).toBe(statusLabel("done"));
  });

  it("gives every state a distinct tooltip icon and only semantic colour tokens", () => {
    const entries = Object.values(SIDEBAR_STATE_META);
    expect(new Set(entries.map((meta) => meta.icon)).size).toBe(entries.length);
    for (const meta of entries) {
      expect(meta.toneClass).toMatch(/^text-(warn|ok|info|destructive|muted-foreground)/);
    }
  });

  it("spends a row glyph only on work in flight and on rows that want a human", () => {
    const glyphs = Object.entries(SIDEBAR_STATE_META)
      .filter(([, meta]) => meta.rowGlyph)
      .map(([state]) => state)
      .sort();
    expect(glyphs).toEqual(["blocked", "failed", "needs_answer", "working"]);
  });

  it("leaves every resting state silent — review above all", () => {
    // `waiting` is where a finished task *comes to rest*, so a glyph there
    // fires on nearly every row and the vocabulary stops meaning anything.
    for (const state of ["review", "idle", "queued", "done", "settled", "snoozed"] as const) {
      expect(SIDEBAR_STATE_META[state].rowGlyph).toBe(false);
    }
    expect(SIDEBAR_STATE_META.review.toneClass).not.toContain("warn");
    expect(SIDEBAR_STATE_META.review.titleClass).not.toContain("font-medium");
  });

  it("keeps the working row's green spinner", () => {
    expect(SIDEBAR_STATE_META.working).toMatchObject({
      live: true,
      rowGlyph: true,
      toneClass: "text-ok",
    });
  });

  it("counts only genuinely blocking states as wanting a human", () => {
    const wanted: SidebarTaskState[] = ["needs_answer", "blocked", "failed"];
    for (const state of Object.keys(SIDEBAR_STATE_META) as SidebarTaskState[]) {
      expect(needsHuman(state)).toBe(wanted.includes(state));
    }
    // Every row that wants a human carries the glyph that says so.
    for (const state of wanted) expect(SIDEBAR_STATE_META[state].rowGlyph).toBe(true);
  });

  it("reserves the loudest title treatment for rows that want a human", () => {
    for (const state of ["needs_answer", "blocked", "failed"] as const) {
      expect(SIDEBAR_STATE_META[state].titleClass).toContain("font-medium");
    }
    for (const state of ["done", "snoozed", "settled"] as const) {
      expect(SIDEBAR_STATE_META[state].titleClass).toContain("muted-foreground");
    }
    expect(SIDEBAR_STATE_META.working.live).toBe(true);
    expect(SIDEBAR_STATE_META.idle.live).toBe(false);
  });
});

describe("settled classification", () => {
  it("treats a completed task and a hand-settled one alike", () => {
    expect(isSettledTask(task("a", { status: "done" }))).toBe(true);
    expect(
      isSettledTask(task("b", { settledOverride: true, status: "waiting", filesChanged: 1 })),
    ).toBe(true);
    expect(isSettledTask(task("c", { status: "waiting", filesChanged: 1 }))).toBe(false);
    expect(isSettledTask(task("d", { settledOverride: false, status: "done" }))).toBe(true);
  });

  it("holds a whole group in the tree while one descendant is still live", () => {
    const settled = buildTaskForest([
      task("lead", { status: "done" }),
      task("child", { parentTaskId: "lead", status: "done" }),
    ]);
    expect(isSettledTree(settled[0]!)).toBe(true);

    const mixed = buildTaskForest([
      task("lead", { status: "done" }),
      task("child", { parentTaskId: "lead", status: "running" }),
    ]);
    expect(isSettledTree(mixed[0]!)).toBe(false);
  });
});

describe("snooze helpers", () => {
  it("ignores a half-written snooze", () => {
    expect(isSnoozed(task("a", { snoozedUntil: NOW + 60 }), NOW)).toBe(false);
    expect(isSnoozed(task("b", { snoozedAt: NOW - 1, snoozedUntil: NOW + 60 }), NOW)).toBe(true);
    expect(isSnoozed(task("c", { snoozedAt: NOW - 1, snoozedUntil: NOW - 1 }), NOW)).toBe(false);
  });

  it("counts down to the wake, not up from the snooze", () => {
    expect(snoozeWakeLabel(NOW + 30, NOW)).toBe("now");
    expect(snoozeWakeLabel(NOW + 600, NOW)).toBe("10m");
    expect(snoozeWakeLabel(NOW + 7200, NOW)).toBe("2h");
    expect(snoozeWakeLabel(NOW + 86_400 * 3, NOW)).toBe("3d");
    expect(snoozeWakeLabel(NOW - 500, NOW)).toBe("now");
  });
});

describe("projectNames", () => {
  // A task can outlive its project: removing a project stops its live
  // resources but never touches its tasks (see `remove_project` in the
  // daemon). This must not resurrect a removed project as a phantom sidebar
  // group — it's registered projects only, full stop. Such a task stays
  // reachable elsewhere (Mission Control), just not here.
  it("returns registered projects only, in snapshot order", () => {
    expect(projectNames({ projects: [{ name: "warpforge" }, { name: "website" }] })).toEqual([
      "warpforge",
      "website",
    ]);
  });

  it("is empty when nothing is registered", () => {
    expect(projectNames({ projects: [] })).toEqual([]);
  });
});

describe("sortProjectsByActivity", () => {
  const names = ["alpha", "beta", "gamma"];

  it("floats the project being worked in to the top", () => {
    const tasks = [
      task("a", { project: "alpha", updatedAt: 100 }),
      task("b", { project: "beta", updatedAt: 300 }),
      task("c", { project: "gamma", updatedAt: 200 }),
    ];
    expect(sortProjectsByActivity(names, tasks)).toEqual(["beta", "gamma", "alpha"]);
  });

  it("ranks a project on its newest live task, not its busiest history", () => {
    const tasks = [
      task("a", { project: "alpha", updatedAt: 100 }),
      task("b1", { project: "beta", status: "done", updatedAt: 9_000 }),
      task("b2", { project: "beta", updatedAt: 50 }),
    ];
    // Archived work must not outrank live work, or a finished project
    // permanently squats at the top.
    expect(sortProjectsByActivity(names, tasks)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("still places an all-archive project by its archive, above the empty ones", () => {
    const tasks = [
      task("b", { project: "beta", settledOverride: true, updatedAt: 500 }),
      task("c", { project: "gamma", status: "done", updatedAt: 400 }),
    ];
    expect(sortProjectsByActivity(names, tasks)).toEqual(["beta", "gamma", "alpha"]);
  });

  it("sorts a project with no tasks last, since Warpforge projects carry no timestamp", () => {
    const tasks = [task("a", { project: "alpha", updatedAt: 10 })];
    expect(sortProjectsByActivity(names, tasks)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("breaks ties by name so the order never twitches between renders", () => {
    const tasks = [
      task("g", { project: "gamma", updatedAt: 100 }),
      task("b", { project: "beta", updatedAt: 100 }),
      task("a", { project: "alpha", updatedAt: 100 }),
    ];
    const once = sortProjectsByActivity(names, tasks);
    expect(once).toEqual(["alpha", "beta", "gamma"]);
    // Same input, different array identity — the comparator is total, so the
    // result cannot depend on the incoming order.
    expect(sortProjectsByActivity(["gamma", "beta", "alpha"], tasks)).toEqual(once);
  });

  it("survives malformed timestamps instead of poisoning the whole comparator", () => {
    const tasks = [
      task("a", { project: "alpha", updatedAt: Number.NaN }),
      task("b", { project: "beta", updatedAt: 100 }),
      task("c", { project: "gamma", updatedAt: undefined as unknown as number }),
    ];
    // beta is the only project with a usable stamp; the other two stay ordered
    // rather than landing wherever NaN comparisons happen to fall.
    expect(sortProjectsByActivity(names, tasks)).toEqual(["beta", "alpha", "gamma"]);
  });
});

describe("ancestorIds", () => {
  it("walks parents nearest-first and survives a cycle", () => {
    const byId = new Map(
      [
        task("root"),
        task("mid", { parentTaskId: "root" }),
        task("leaf", { parentTaskId: "mid" }),
      ].map((item) => [item.id, item]),
    );
    expect(ancestorIds(byId, "leaf")).toEqual(["mid", "root"]);
    expect(ancestorIds(byId, null)).toEqual([]);

    const cyclic = new Map(
      [task("a", { parentTaskId: "b" }), task("b", { parentTaskId: "a" })].map((item) => [
        item.id,
        item,
      ]),
    );
    expect(ancestorIds(cyclic, "a")).toEqual(["b"]);
  });
});

describe("buildSidebarRows", () => {
  it("opens straight on the project tree, with no Needs you block", () => {
    const review = task("review", { status: "waiting", filesChanged: 1 });
    const rows = build([review], { queue: [attention(review)] });
    expect(rows[0]).toMatchObject({ kind: "project", name: "warpforge" });
    // A queued task appears exactly once — in its project — rather than twice.
    expect(taskRows(rows).map((row) => row.task.id)).toEqual(["review"]);
  });

  it("falls back to an empty state per level", () => {
    const noProjects = build([], { projectOrder: [] }).filter((row) => row.kind === "empty");
    expect(noProjects[noProjects.length - 1]).toMatchObject({ label: "No projects yet" });
    const emptyProject = build([]).filter((row) => row.kind === "empty");
    expect(emptyProject[emptyProject.length - 1]).toMatchObject({ label: "No tasks yet" });
  });

  it("counts live tasks only, so archive cannot inflate a project", () => {
    const rows = build([
      task("live"),
      task("finished", { status: "done" }),
      task("handled", { settledOverride: true, status: "waiting", filesChanged: 1 }),
    ]);
    expect(rows.find((row) => row.kind === "project")).toMatchObject({
      count: 1,
      expanded: true,
      name: "warpforge",
    });
  });

  it("flags a project only for tasks that genuinely want a human", () => {
    const blocked = task("blocked", { status: "blocked" });
    const review = task("review", { status: "waiting", filesChanged: 1 });
    const rows = build([blocked, review, task("quiet")], {
      queue: [attention(blocked), attention(review)],
    });
    // Both are in the attention queue; only the blocked one lights the project.
    expect(rows.find((row) => row.kind === "project")).toMatchObject({
      attentionCount: 1,
      count: 3,
    });
  });

  it("drops a collapsed project's tasks from the list entirely", () => {
    const rows = build([task("a")], { collapsedProjects: new Set(["warpforge"]) });
    expect(rows.find((row) => row.kind === "project")).toMatchObject({ expanded: false });
    expect(taskRows(rows)).toHaveLength(0);
  });

  it("hides subtasks until their parent is expanded, then indents them", () => {
    const tasks = [task("lead"), task("child", { parentTaskId: "lead" })];
    expect(taskRows(build(tasks)).map((row) => row.task.id)).toEqual(["lead"]);
    expect(taskRows(build(tasks))[0]).toMatchObject({ childCount: 1, expanded: false });

    const expanded = taskRows(build(tasks, { expandedTaskIds: new Set(["lead"]) }));
    expect(expanded.map((row) => [row.task.id, row.depth])).toEqual([
      ["lead", 0],
      ["child", 1],
    ]);
  });

  it("floats tasks that want a human above their quiet siblings", () => {
    const quiet = task("quiet", { updatedAt: 99 });
    const loud = task("loud", { status: "blocked", updatedAt: 1 });
    const review = task("review", { status: "waiting", filesChanged: 1, updatedAt: 50 });
    const rows = build([quiet, loud, review], { queue: [attention(loud), attention(review)] });
    // Review is in the attention queue but rests, so it sorts purely by recency.
    expect(taskRows(rows).map((row) => row.task.id)).toEqual(["loud", "quiet", "review"]);
  });

  it("gives each row kind a fixed height so the list needs no measurement", () => {
    const rows = build([task("a"), task("old", { status: "done" })]);
    for (const row of rows) expect(rowHeight(row)).toBeGreaterThan(0);
    const shelf = rows.find((row) => row.kind === "shelf")!;
    const taskRow = rows.find((row) => row.kind === "task")!;
    expect(rowHeight(shelf)).toBeLessThan(rowHeight(taskRow));
  });
});

describe("the done shelf", () => {
  const live = task("live", { status: "running" });
  const finished = task("finished", { status: "done", updatedAt: 10 });
  const handled = task("handled", { settledOverride: true, updatedAt: 20 });

  it("keeps settled groups out of the tree behind a counted disclosure", () => {
    const rows = build([live, finished, handled]);
    expect(taskRows(rows).map((row) => row.task.id)).toEqual(["live"]);
    expect(rows.find((row) => row.kind === "shelf")).toMatchObject({
      count: 2,
      expanded: false,
      project: "warpforge",
    });
  });

  it("reveals them newest-first when the shelf is opened", () => {
    const rows = build([live, finished, handled], {
      expandedShelves: new Set(["warpforge"]),
    });
    expect(rows.find((row) => row.kind === "shelf")).toMatchObject({ expanded: true });
    expect(taskRows(rows).map((row) => row.task.id)).toEqual(["live", "handled", "finished"]);
  });

  it("omits the shelf entirely when a project has no history", () => {
    expect(build([live]).some((row) => row.kind === "shelf")).toBe(false);
  });

  it("says 'No tasks yet' only for a truly empty project, never over a shelf", () => {
    const rows = build([finished]);
    expect(rows.some((row) => row.kind === "empty")).toBe(false);
    expect(rows.find((row) => row.kind === "shelf")).toMatchObject({ count: 1 });
  });

  it("opens itself for the task the user was sent to, wherever it is buried", () => {
    const rows = build([live, finished], { forceVisibleTaskIds: new Set(["finished"]) });
    expect(rows.find((row) => row.kind === "shelf")).toMatchObject({ expanded: true });
    expect(taskRows(rows).map((row) => row.task.id)).toContain("finished");
  });

  it("holds a settled parent in the tree while a child is still running", () => {
    const rows = build([
      task("lead", { status: "done" }),
      task("child", { parentTaskId: "lead", status: "running" }),
    ]);
    expect(rows.some((row) => row.kind === "shelf")).toBe(false);
    expect(taskRows(rows).map((row) => row.task.id)).toEqual(["lead"]);
  });

  it("leaves a settled subtask inline under its parent rather than shelving it", () => {
    const rows = build(
      [
        task("lead", { status: "running" }),
        task("child", { parentTaskId: "lead", status: "done" }),
      ],
      { expandedTaskIds: new Set(["lead"]) },
    );
    expect(rows.some((row) => row.kind === "shelf")).toBe(false);
    expect(taskRows(rows).map((row) => row.task.id)).toEqual(["lead", "child"]);
  });
});
