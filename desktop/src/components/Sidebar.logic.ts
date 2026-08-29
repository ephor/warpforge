import type { AttentionItem } from "@/lib/attentionRail";
import { statusLabel } from "@/lib/statusMeta";
import {
  awaitsReview,
  flattenTaskTree,
  isSettledTask,
  settleableTasks,
  type TaskTree,
} from "@/lib/taskGroups";
import type { TaskInfo } from "@/protocol";

/**
 * Presentation model for `Sidebar.tsx`. Everything here is pure so the row
 * anatomy, the state encoding and the flattening of the workspace tree can be
 * asserted without rendering: the component is left with layout only.
 *
 * The governing rule is *silence by default*. `waiting` is the resting state of
 * every task an agent has finished, so decorating it — and `queued` — made
 * "this row wants something" mean nothing: the tree became a wall of warn
 * glyphs and the "Needs you" section a settling tank. A glyph now has to earn
 * its place, so a row only carries one when it genuinely deviates from "nothing
 * is happening and nothing is needed from you".
 */

/** Indent applied per nesting level of a subtask row, in px. */
export const SIDEBAR_INDENT_PX = 14;

/**
 * What a row *is*. This is *not* `TaskStatus`: a task can be running while a
 * permission prompt blocks it, and snooze/settle are lifecycle overrides that
 * outrank whatever the task itself reports.
 *
 * The full vocabulary survives so tooltips, sorting and the row actions still
 * know the real state; what it no longer implies is a glyph (see `rowGlyph`).
 */
export type SidebarTaskState =
  | "needs_answer"
  | "review"
  | "blocked"
  | "failed"
  | "working"
  | "queued"
  | "idle"
  | "done"
  | "snoozed"
  | "settled";

/** Icon key; `SidebarTaskRow` maps it to a lucide component. */
export type SidebarStateIcon = SidebarTaskState;

export interface SidebarStateMeta {
  /** Word shown in the tooltip and to screen readers. */
  label: string;
  /**
   * Icon for the tooltip's state line. Every state keeps one — the tooltip is
   * an explicit, one-at-a-time request for detail, so it can afford to be
   * expressive where the list cannot.
   */
  icon: SidebarStateIcon;
  /**
   * Whether the *row* draws that icon. False for every resting state, which is
   * most of them: a finished task waiting on a human, an idle session and a
   * queued one are all "nothing to see", and decorating them is what made the
   * tree unreadable.
   */
  rowGlyph: boolean;
  /** Semantic token for the glyph. Colour is meaning, never decoration. */
  toneClass: string;
  /**
   * Title prominence. Three steps only: rows that want a human, rows that are
   * merely alive, and rows that are history.
   */
  titleClass: string;
  /** The agent is mid-turn, so the glyph animates. */
  live: boolean;
}

const ATTENTION_TITLE = "font-medium text-foreground";
const NORMAL_TITLE = "text-foreground/85";
const MUTED_TITLE = "text-muted-foreground/60";

/** Tooltip-only tone: a resting state must not tint the row it explains. */
const QUIET_TONE = "text-muted-foreground/70";

/**
 * Labels reuse `statusMeta` wherever a state maps 1:1 onto a `TaskStatus`, so
 * the sidebar can never disagree with the board or the task header. `review` is
 * the exception: it is derived from `filesChanged`, not reported, so it owns its
 * own word.
 *
 * Exactly four states set `rowGlyph`: an agent mid-turn (the green spinner),
 * and the three ways a task can actually want a human.
 */
export const SIDEBAR_STATE_META: Record<SidebarTaskState, SidebarStateMeta> = {
  blocked: {
    icon: "blocked",
    label: statusLabel("blocked"),
    live: false,
    rowGlyph: true,
    titleClass: ATTENTION_TITLE,
    toneClass: "text-warn",
  },
  done: {
    icon: "done",
    label: statusLabel("done"),
    live: false,
    rowGlyph: false,
    titleClass: MUTED_TITLE,
    toneClass: QUIET_TONE,
  },
  failed: {
    icon: "failed",
    label: statusLabel("interrupted"),
    live: false,
    rowGlyph: true,
    titleClass: ATTENTION_TITLE,
    toneClass: "text-destructive",
  },
  idle: {
    icon: "idle",
    label: statusLabel("waiting"),
    live: false,
    rowGlyph: false,
    titleClass: NORMAL_TITLE,
    toneClass: QUIET_TONE,
  },
  needs_answer: {
    icon: "needs_answer",
    label: "needs you",
    live: false,
    rowGlyph: true,
    titleClass: ATTENTION_TITLE,
    toneClass: "text-warn",
  },
  queued: {
    icon: "queued",
    label: statusLabel("queued"),
    live: false,
    rowGlyph: false,
    titleClass: NORMAL_TITLE,
    toneClass: QUIET_TONE,
  },
  // Resting, not pending: the agent finished and the diff is waiting whenever
  // the user gets to it. A glyph here fires on almost every row in the tree.
  review: {
    icon: "review",
    label: "needs review",
    live: false,
    rowGlyph: false,
    titleClass: NORMAL_TITLE,
    toneClass: QUIET_TONE,
  },
  settled: {
    icon: "settled",
    label: "handled",
    live: false,
    rowGlyph: false,
    titleClass: MUTED_TITLE,
    toneClass: QUIET_TONE,
  },
  // The wake countdown in the row's right lane is the whole story, so the row
  // needs no second marker for it.
  snoozed: {
    icon: "snoozed",
    label: "snoozed",
    live: false,
    rowGlyph: false,
    titleClass: MUTED_TITLE,
    toneClass: "text-info",
  },
  working: {
    icon: "working",
    label: statusLabel("running"),
    live: true,
    rowGlyph: true,
    titleClass: NORMAL_TITLE,
    toneClass: "text-ok",
  },
};

/**
 * The three states that actually want a human *now*: a prompt waiting on an
 * answer, a task that cannot proceed, and a session that died. Drives the sort,
 * the dot on a collapsed project and the Mission Control badge. Matches what
 * `buildAttentionQueue` now collects — a finished turn with a diff is not an
 * interruption, and counting it as one made "needs you" mean everything.
 */
export function needsHuman(state: SidebarTaskState): boolean {
  return state === "needs_answer" || state === "blocked" || state === "failed";
}

export { isSettledTask };

/**
 * A root only leaves the tree when its *whole* group has settled. A workflow
 * parent reported done while a child is still running must keep the child
 * reachable, so one live descendant holds the entire group in place.
 */
export function isSettledTree(tree: TaskTree): boolean {
  return flattenTaskTree(tree).every(isSettledTask);
}

function isValidStamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** A snooze only counts while both of its stamps survived the round trip. */
export function isSnoozed(task: TaskInfo, nowSec: number): boolean {
  return (
    isValidStamp(task.snoozedAt) && isValidStamp(task.snoozedUntil) && task.snoozedUntil > nowSec
  );
}

/** Compact "comes back in" label for a snoozed row: the row's whole story. */
export function snoozeWakeLabel(untilSec: number, nowSec: number): string {
  const seconds = Math.max(0, untilSec - nowSec);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Lifecycle overrides win over the reported status, and an attention flag wins
 * over a status that would contradict it — a task blocked on a permission
 * prompt still reports `running`, and a row that says "running" next to a warn
 * glyph reads as a bug.
 */
export function resolveTaskState(
  task: TaskInfo,
  options: { attention: boolean; nowSec: number },
): SidebarTaskState {
  if (isSnoozed(task, options.nowSec)) return "snoozed";
  if (task.settledOverride === true) return "settled";
  // Only promote when the status does not already explain the attention: a
  // waiting task *with* a diff is in the queue precisely because of that diff,
  // and calling it "needs you" would double-count the review as a question.
  if (
    options.attention &&
    (task.status === "running" || (task.status === "waiting" && !awaitsReview(task)))
  ) {
    return "needs_answer";
  }
  switch (task.status) {
    case "blocked":
      return "blocked";
    case "interrupted":
      return "failed";
    case "running":
      return "working";
    case "queued":
      return "queued";
    case "done":
      return "done";
    default:
      // One status, two rows: `waiting` is where the agent parks either way, so
      // the diff — not a second status — is what says whether there is anything
      // to look at. Both render silently; only the tooltip differs.
      return awaitsReview(task) ? "review" : "idle";
  }
}

export type SidebarRow =
  | { key: string; kind: "empty"; label: string; hint: string | null }
  | {
      key: string;
      kind: "project";
      name: string;
      /** Live tasks only. The total is dominated by archive and says nothing. */
      count: number;
      attentionCount: number;
      selected: boolean;
      expanded: boolean;
      /** Diff-less finished turns in this project, for the per-project bulk
       *  settle. Empty hides the button. */
      settleIds: string[];
      /** First few settle candidates' titles, for the button's tooltip. */
      settlePreview: string[];
    }
  | {
      /** Quiet disclosure closing a project group: "12 done". */
      key: string;
      kind: "shelf";
      project: string;
      count: number;
      expanded: boolean;
    }
  | {
      key: string;
      kind: "task";
      task: TaskInfo;
      depth: number;
      childCount: number;
      expanded: boolean;
      attention: boolean;
      state: SidebarTaskState;
    };

const EMPTY_HEIGHT = 34;
const EMPTY_WITH_HINT_HEIGHT = 50;
const PROJECT_HEIGHT = 32;
const SHELF_HEIGHT = 28;
const TASK_HEIGHT = 34;

/**
 * Rows are fixed-height by construction (every one truncates), so the
 * virtualizer can trust these numbers and skip DOM measurement entirely.
 */
export function rowHeight(row: SidebarRow): number {
  switch (row.kind) {
    case "empty":
      return row.hint === null ? EMPTY_HEIGHT : EMPTY_WITH_HINT_HEIGHT;
    case "project":
      return PROJECT_HEIGHT;
    case "shelf":
      return SHELF_HEIGHT;
    default:
      return TASK_HEIGHT;
  }
}

/**
 * Registered projects only. A task can outlive its project — removing a
 * project stops its live resources but does not touch its tasks (see
 * `remove_project` in the daemon) — and such a task must not resurrect its
 * project as a phantom group here. Its tasks simply don't render in the
 * sidebar tree; the daemon still holds them.
 */
export function projectNames(input: { projects: readonly { name: string }[] }): string[] {
  return input.projects.map((project) => project.name);
}

/**
 * NaN-safe read of a Warpforge timestamp (unix **seconds**, not an ISO string).
 * A single bad value must not reach the comparator: one `NaN` in a `Math.max`
 * chain makes every later comparison false, which silently randomises the whole
 * order rather than failing loudly.
 */
function sortableSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * How recently a project saw activity, for ordering the sidebar.
 *
 * Only **live** tasks count. A project full of finished work would otherwise
 * outrank one being worked in right now, which defeats the point — but a
 * project whose tasks have all settled still needs a defined key, so it falls
 * back to its archive rather than sinking to `-Infinity` next to the genuinely
 * empty ones.
 *
 * Returns `null` when the project has no usable timestamp at all. Warpforge's
 * `ProjectInfo` carries no `createdAt`/`updatedAt`, so an empty project has
 * nothing to fall back to and simply sorts last, alphabetically.
 */
export function projectActivityAt(name: string, tasks: readonly TaskInfo[]): number | null {
  let live: number | null = null;
  let settled: number | null = null;
  for (const task of tasks) {
    if (task.project !== name) continue;
    const at = sortableSeconds(task.updatedAt);
    if (at === null) continue;
    if (isSettledTask(task)) {
      if (settled === null || at > settled) settled = at;
    } else if (live === null || at > live) {
      live = at;
    }
  }
  return live ?? settled;
}

/**
 * Most recently active project first, so whatever the user is working in floats
 * to the top.
 *
 * Ties break by name, which is total and stable: with no second key, two
 * projects sharing a timestamp could swap places on an unrelated re-render and
 * the list would visibly twitch. Callers should recompute this only when the
 * task set changes — never on a clock tick — or a row can slide out from under
 * the pointer mid-click.
 */
export function sortProjectsByActivity(
  names: readonly string[],
  tasks: readonly TaskInfo[],
): string[] {
  const activity = new Map(names.map((name) => [name, projectActivityAt(name, tasks)]));
  return [...names].sort((a, b) => {
    const left = activity.get(a) ?? Number.NEGATIVE_INFINITY;
    const right = activity.get(b) ?? Number.NEGATIVE_INFINITY;
    if (left !== right) return right - left;
    return a.localeCompare(b);
  });
}

/** Chain of parents above `taskId`, nearest first. Cycle-safe. */
export function ancestorIds(byId: ReadonlyMap<string, TaskInfo>, taskId: string | null): string[] {
  if (!taskId) return [];
  const ids: string[] = [];
  let current = byId.get(taskId)?.parentTaskId ?? null;
  const guard = new Set<string>([taskId]);
  while (current && !guard.has(current)) {
    guard.add(current);
    ids.push(current);
    current = byId.get(current)?.parentTaskId ?? null;
  }
  return ids;
}

export interface SidebarRowsInput {
  tasks: readonly TaskInfo[];
  queue: readonly AttentionItem[];
  projectOrder: readonly string[];
  forest: readonly TaskTree[];
  expandedTaskIds: ReadonlySet<string>;
  collapsedProjects: ReadonlySet<string>;
  /** Projects whose "N done" shelf the user has opened. */
  expandedShelves: ReadonlySet<string>;
  /**
   * Tasks that must be rendered wherever they are — the open task and any
   * attention target. A settled task pulls its shelf open rather than leaving
   * the caller scrolling to a row that was never built.
   */
  forceVisibleTaskIds: ReadonlySet<string>;
  openProject: string | null;
  nowSec: number;
}

/**
 * Flatten project → root task → subtask into one list. Nesting is carried per
 * row (`depth`) instead of by nested containers so a workspace with hundreds of
 * tasks stays one virtualized list.
 *
 * There is no "Needs you" block: with `needs_review` resting there, it grew to
 * dozens of rows and stopped meaning anything. Attention is now expressed
 * inline, by the rare row that carries a glyph.
 */
export function buildSidebarRows(input: SidebarRowsInput): SidebarRow[] {
  const {
    collapsedProjects,
    expandedShelves,
    expandedTaskIds,
    forceVisibleTaskIds,
    forest,
    nowSec,
    openProject,
    queue,
    tasks,
  } = input;
  const attentionIds = new Set(queue.map((item) => item.task.id));
  const rows: SidebarRow[] = [];
  const stateOf = (task: TaskInfo) =>
    resolveTaskState(task, { attention: attentionIds.has(task.id), nowSec });

  if (input.projectOrder.length === 0) {
    rows.push({
      hint: "Add one from the Projects view",
      key: "empty:workspace",
      kind: "empty",
      label: "No projects yet",
    });
    return rows;
  }

  const rank = (task: TaskInfo) => (needsHuman(stateOf(task)) ? 0 : 1);
  const byPriority = (a: TaskTree, b: TaskTree) =>
    rank(a.task) - rank(b.task) ||
    b.task.updatedAt - a.task.updatedAt ||
    a.task.id.localeCompare(b.task.id);
  /** History reads newest-first: "what did I just finish", not "what is next". */
  const byRecency = (a: TaskTree, b: TaskTree) =>
    b.task.updatedAt - a.task.updatedAt || a.task.id.localeCompare(b.task.id);

  const pushTree = (tree: TaskTree, depth: number) => {
    const expanded = expandedTaskIds.has(tree.task.id);
    const attention = attentionIds.has(tree.task.id);
    rows.push({
      attention,
      childCount: tree.children.length,
      depth,
      expanded,
      key: `workspace:${tree.task.id}`,
      kind: "task",
      state: resolveTaskState(tree.task, { attention, nowSec }),
      task: tree.task,
    });
    if (!expanded) return;
    // Subtasks are the parent's story, so a settled one stays inline: the shelf
    // only ever holds whole groups.
    for (const child of [...tree.children].sort(byPriority)) pushTree(child, depth + 1);
  };

  for (const name of input.projectOrder) {
    const projectTasks = tasks.filter((task) => task.project === name);
    const live = projectTasks.filter((task) => !isSettledTask(task));
    const expanded = !collapsedProjects.has(name);
    const settleCandidates = settleableTasks(projectTasks, nowSec);
    rows.push({
      attentionCount: live.filter((task) => needsHuman(stateOf(task))).length,
      count: live.length,
      expanded,
      key: `project:${name}`,
      kind: "project",
      name,
      selected: openProject === name,
      settleIds: settleCandidates.map((task) => task.id),
      settlePreview: settleCandidates.slice(0, 3).map((task) => task.title),
    });
    if (!expanded) continue;

    const roots = forest.filter((tree) => tree.task.project === name);
    if (roots.length === 0) {
      rows.push({ hint: null, key: `empty:project:${name}`, kind: "empty", label: "No tasks yet" });
      continue;
    }

    const shelved: TaskTree[] = [];
    const active: TaskTree[] = [];
    for (const tree of roots) (isSettledTree(tree) ? shelved : active).push(tree);
    for (const tree of active.sort(byPriority)) pushTree(tree, 0);
    if (shelved.length === 0) continue;

    const forced = shelved.some((tree) =>
      flattenTaskTree(tree).some((task) => forceVisibleTaskIds.has(task.id)),
    );
    const shelfExpanded = expandedShelves.has(name) || forced;
    rows.push({
      count: shelved.length,
      expanded: shelfExpanded,
      key: `shelf:${name}`,
      kind: "shelf",
      project: name,
    });
    if (!shelfExpanded) continue;
    for (const tree of shelved.sort(byRecency)) pushTree(tree, 0);
  }

  return rows;
}
