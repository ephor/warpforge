import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ChevronRight,
  Clock3,
  ChevronDown,
  FilePen,
  FileText,
  ListTodo,
  Maximize2,
  Plus,
  TriangleAlert,
  Users,
  Wrench,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { sessionActivity } from "@/lib/sessionActivity";
import {
  latestPendingPermission,
  pendingPermission,
  resolvedPermissions,
} from "@/lib/sessionPermissions";
import { activityBadge, elapsed, taskBadge } from "@/lib/status";
import {
  buildTaskGroupIndex,
  flattenTaskTree,
  resolvePinnedTaskGroups,
  resolveGroupTaskId,
  taskGroupCounts,
  taskGroupStatus,
  type TaskGroupStatus,
  type TaskTree,
} from "@/lib/taskGroups";
import { cn } from "@/lib/utils";

import { AgentActivityIndicator } from "../components/AgentActivityIndicator";
import { AgentConfigBar } from "../components/AgentConfigBar";
import { Composer } from "../components/Composer";
import type { FileLinkResolver } from "../components/Markdown";
import { BufferedMarkdown, Markdown } from "../components/Markdown";
import { ThinkingBlock } from "../components/ThinkingBlock";
import type { DaemonState } from "../daemon";
import { daemon } from "../daemon";
import type { CommandInfo, ProjectFile, SessionUpdate, TaskInfo } from "../protocol";
import { daemonQuery } from "../query";
import { useUi } from "../store/ui";

/**
 * Mission Control — the default, attention-driven operating view.
 * Attention rail (blocked-on-a-human, triaged) + live session wall + a
 * pinnable focus row where sessions can be steered inline. See UI_CONCEPT.md.
 */

interface Props {
  state: DaemonState;
  onOpenTask: (id: string) => void;
  onNewTask: (project?: string) => void;
}

const PINNED_PREVIEW_LIMIT = 18;

export default function MissionControl({ state, onOpenTask, onNewTask }: Props) {
  const pinned = useUi((s) => s.pinnedTaskIds);
  const setPinnedTaskIds = useUi((s) => s.setPinnedTaskIds);
  const attentionTargetId = useUi((s) => s.attentionTargetId);
  const attentionTargetNonce = useUi((s) => s.attentionTargetNonce);
  const live = useMemo(
    () => state.snapshot.tasks.filter((t) => t.status !== "done"),
    [state.snapshot.tasks],
  );
  const groupIndex = useMemo(
    () => buildTaskGroupIndex(state.snapshot.tasks),
    [state.snapshot.tasks],
  );
  const pinnedGroups = useMemo(
    () => resolvePinnedTaskGroups(groupIndex, pinned),
    [groupIndex, pinned],
  );

  const handleUnpin = useCallback(
    (tree: TaskTree) => {
      const memberIds = new Set(flattenTaskTree(tree).map((task) => task.id));
      setPinnedTaskIds(pinned.filter((id) => !memberIds.has(id)));
    },
    [pinned, setPinnedTaskIds],
  );

  return (
    <ScrollArea className="h-full min-h-0">
      <div className="flex flex-col gap-4 pr-3">
        {pinnedGroups.length > 0 ? (
          <div className="grid grid-cols-2 gap-3">
            {pinnedGroups.map((tree) => (
              <FocusGroupPane
                key={tree.task.id}
                tree={tree}
                updatesByTaskId={state.sessionUpdates}
                attentionTargetId={attentionTargetId}
                attentionTargetNonce={attentionTargetNonce}
                onUnpin={handleUnpin}
                onOpen={onOpenTask}
              />
            ))}
          </div>
        ) : live.length > 0 ? (
          <div className="mt-16 flex flex-col items-center gap-2 text-center text-muted-foreground">
            <p className="text-foreground">No pinned sessions.</p>
            <p className="max-w-md text-sm">
              Pin sessions from the sidebar when you want them on the Mission Control board.
            </p>
          </div>
        ) : null}

        {live.length === 0 ? (
          <div className="mt-16 flex flex-col items-center gap-3 text-muted-foreground">
            <p>No live sessions.</p>
            <Button variant="outline" onClick={() => onNewTask()}>
              <Plus className="size-4" />
              Start a task
            </Button>
          </div>
        ) : null}
      </div>
    </ScrollArea>
  );
}

interface FocusGroupPaneProps {
  tree: TaskTree;
  updatesByTaskId: DaemonState["sessionUpdates"];
  attentionTargetId: string | null;
  attentionTargetNonce: number;
  onUnpin: (tree: TaskTree) => void;
  onOpen: (id: string) => void;
}

const FocusGroupPane = memo(function FocusGroupPane({
  tree,
  updatesByTaskId,
  attentionTargetId,
  attentionTargetNonce,
  onUnpin,
  onOpen,
}: FocusGroupPaneProps) {
  const members = useMemo(() => flattenTaskTree(tree), [tree]);
  const [selectedId, setSelectedId] = useState(() =>
    resolveGroupTaskId(tree, null, attentionTargetId),
  );
  const [showAllAgents, setShowAllAgents] = useState(false);

  useEffect(() => {
    setSelectedId((current) => resolveGroupTaskId(tree, current, attentionTargetId));
  }, [attentionTargetId, attentionTargetNonce, tree]);

  const selectedTask = members.find((task) => task.id === selectedId) ?? tree.task;
  const permissionTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const task of members) {
      if (latestPendingPermission(task.id, updatesByTaskId[task.id])) ids.add(task.id);
    }
    return ids;
  }, [members, updatesByTaskId]);
  const status = taskGroupStatus(tree, permissionTaskIds);

  const handleUnpin = useCallback(() => onUnpin(tree), [onUnpin, tree]);
  const handleOpen = useCallback(() => onOpen(selectedTask.id), [onOpen, selectedTask.id]);
  const handleSelect = useCallback((id: string) => setSelectedId(id), []);

  return (
    <FocusPane
      task={selectedTask}
      updates={updatesByTaskId[selectedTask.id] ?? []}
      tree={tree}
      selectedId={selectedTask.id}
      showAllAgents={showAllAgents}
      groupStatus={status}
      permissionTaskIds={permissionTaskIds}
      onShowAllAgents={setShowAllAgents}
      onSelect={handleSelect}
      onUnpin={handleUnpin}
      onOpen={handleOpen}
    />
  );
}, focusGroupPaneEqual);

function focusGroupPaneEqual(previous: FocusGroupPaneProps, next: FocusGroupPaneProps) {
  if (
    previous.tree !== next.tree ||
    previous.attentionTargetId !== next.attentionTargetId ||
    previous.attentionTargetNonce !== next.attentionTargetNonce ||
    previous.onOpen !== next.onOpen ||
    previous.onUnpin !== next.onUnpin
  ) {
    return false;
  }
  return flattenTaskTree(next.tree).every(
    (task) => previous.updatesByTaskId[task.id] === next.updatesByTaskId[task.id],
  );
}

function groupStatusBadge(
  status: TaskGroupStatus,
  activity: ReturnType<typeof sessionActivity>,
): { label: string; variant: ReturnType<typeof taskBadge>["variant"] | "warn" } {
  if (status === "blocked") return { label: "blocked", variant: "destructive" };
  if (status === "permission") return { label: "permission", variant: "warn" };
  if (status === "review") return { label: "needs review", variant: "warn" };
  if (status === "running" && activity) return activityBadge(activity.tone, activity.label);
  return taskBadge(status);
}

const AgentTabs = memo(function AgentTabs({
  tree,
  selectedId,
  permissionTaskIds,
  showAll,
  onShowAll,
  onSelect,
}: {
  tree: TaskTree;
  selectedId: string;
  permissionTaskIds: ReadonlySet<string>;
  showAll: boolean;
  onShowAll: (show: boolean) => void;
  onSelect: (id: string) => void;
}) {
  const descendants = useMemo(() => flattenTaskTree(tree).slice(1), [tree]);
  const counts = useMemo(() => taskGroupCounts(tree), [tree]);
  const prominent = descendants.filter(
    (task) =>
      !["done", "idle"].includes(task.status) ||
      task.id === selectedId ||
      permissionTaskIds.has(task.id),
  );
  const visible = showAll ? descendants : prominent.slice(0, 4);
  const hidden = descendants.filter((task) => !visible.some((shown) => shown.id === task.id));
  const summary = [
    counts.blocked > 0 ? `${counts.blocked} blocked` : null,
    counts.review > 0 ? `${counts.review} review` : null,
    counts.running > 0 ? `${counts.running} running` : null,
    counts.done > 0 ? `${counts.done} done` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="border-b border-border/70 bg-background/30 px-2.5 py-2">
      <div className="mb-1.5 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
        <Users className="size-3 text-primary" />
        <span className="font-medium text-foreground">Agents {descendants.length}</span>
        {summary && <span className="ml-auto truncate">{summary}</span>}
      </div>
      <div
        className={cn("flex min-w-0 items-center gap-1", showAll ? "flex-wrap" : "overflow-hidden")}
        role="tablist"
        aria-label="Agents in this task"
      >
        <AgentTab
          task={tree.task}
          lead
          permission={permissionTaskIds.has(tree.task.id)}
          selected={selectedId === tree.task.id}
          onSelect={onSelect}
        />
        {visible.map((task) => (
          <AgentTab
            key={task.id}
            task={task}
            permission={permissionTaskIds.has(task.id)}
            selected={selectedId === task.id}
            onSelect={onSelect}
          />
        ))}
        {hidden.length > 0 && (
          <button
            type="button"
            className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded border border-border/70 bg-secondary/40 px-1.5 py-1 text-[10px] text-muted-foreground hover:text-foreground"
            aria-expanded={showAll}
            aria-label={`Show ${hidden.length} more agents`}
            onClick={() => onShowAll(true)}
          >
            +{hidden.length}
            <ChevronDown className="size-3" />
          </button>
        )}
        {showAll && descendants.length > prominent.slice(0, 4).length && (
          <button
            type="button"
            className="ml-auto shrink-0 rounded px-1.5 py-1 text-[10px] text-muted-foreground hover:text-foreground"
            onClick={() => onShowAll(false)}
          >
            Less
          </button>
        )}
      </div>
    </div>
  );
});

const AgentTab = memo(function AgentTab({
  task,
  selected,
  permission = false,
  lead = false,
  onSelect,
}: {
  task: TaskInfo;
  selected: boolean;
  permission?: boolean;
  lead?: boolean;
  onSelect: (id: string) => void;
}) {
  const badge = permission
    ? { label: "permission", variant: "warn" as const }
    : taskBadge(task.status);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      aria-label={`${lead ? "Lead" : task.agent}: ${badge.label}`}
      title={`${lead ? "Lead" : task.agent} — ${task.prompt}`}
      className={cn(
        "flex h-8 min-w-0 max-w-36 shrink items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        selected
          ? "border-primary/60 bg-primary/15 text-foreground shadow-sm"
          : "border-border/60 bg-secondary/30 text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
      )}
      onClick={() => onSelect(task.id)}
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          badge.variant === "destructive" && "bg-destructive",
          badge.variant === "warn" && "bg-warn",
          badge.variant === "ok" && "bg-ok",
          (badge.variant === "default" || badge.variant === "outline") && "bg-muted-foreground",
        )}
      />
      <span className="truncate">{lead ? "Lead" : task.agent}</span>
    </button>
  );
});

function FocusPane({
  task,
  updates,
  tree,
  selectedId,
  showAllAgents,
  groupStatus,
  permissionTaskIds,
  onShowAllAgents,
  onSelect,
  onUnpin,
  onOpen,
}: {
  task: TaskInfo;
  updates: SessionUpdate[];
  tree: TaskTree;
  selectedId: string;
  showAllAgents: boolean;
  groupStatus: TaskGroupStatus;
  permissionTaskIds: ReadonlySet<string>;
  onShowAllAgents: (show: boolean) => void;
  onSelect: (id: string) => void;
  onUnpin: () => void;
  onOpen: () => void;
}) {
  const stream = useMemo(() => coalesceUpdates(updates), [updates]);
  const resolved = useMemo(() => resolvedPermissions(stream), [stream]);
  const pending = useMemo(() => pendingPermission(stream, resolved), [stream, resolved]);
  const preview = useMemo(() => pinnedPreview(stream, PINNED_PREVIEW_LIMIT), [stream]);
  const tools = useMemo(() => summarizeTools(stream), [stream]);
  const files = useMemo(() => summarizeFiles(stream), [stream]);
  const commands = useMemo(() => latestCommands(updates), [updates]);
  const fileListQuery = useQuery({
    queryFn: daemonQuery<ProjectFile[]>("file.list", { task_id: task.id }),
    queryKey: ["fileList", task.id, task.updatedAt],
  });
  const projectFiles = Array.isArray(fileListQuery.data) ? fileListQuery.data : [];
  const capability = [...updates].reverse().find((update) => update.kind === "prompt_capabilities");
  const imageSupported = capability?.kind === "prompt_capabilities" ? capability.image : false;
  const activity = sessionActivity(task, stream);
  const badge = groupStatusBadge(groupStatus, activity);

  return (
    <Card
      className={cn(
        "group flex max-h-[400px] min-h-[300px] flex-col overflow-hidden border border-border/70 bg-card/95 shadow-[0_12px_28px_rgb(0_0_0/0.18)]",
        tree.children.length > 0 && "max-h-[580px] min-h-[480px]",
        "transition-colors hover:border-border",
      )}
    >
      {tree.children.length > 0 && (
        <AgentTabs
          tree={tree}
          selectedId={selectedId}
          permissionTaskIds={permissionTaskIds}
          showAll={showAllAgents}
          onShowAll={onShowAllAgents}
          onSelect={onSelect}
        />
      )}
      <div className="border-b border-border/70 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex min-w-0 items-center gap-2 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              <span className="truncate font-semibold text-foreground/90">{task.project}</span>
              <span className="h-1 w-1 rounded-full bg-muted-foreground/40" />
              <span className="truncate">{task.agent}</span>
              <span className="h-1 w-1 rounded-full bg-muted-foreground/40" />
              <span className="tnum shrink-0">{elapsed(task.updatedAt)}</span>
            </div>
            <button
              type="button"
              onClick={onOpen}
              className="block max-w-full truncate text-left text-[15px] font-semibold leading-5 text-foreground hover:text-primary"
              title={task.prompt}
            >
              {task.prompt}
            </button>
          </div>
          <StatusPill variant={badge.variant} label={badge.label} />
          <button
            type="button"
            aria-label="Open task details"
            className="rounded p-1 text-muted-foreground opacity-80 hover:bg-secondary hover:text-foreground"
            onClick={onOpen}
            title="Full detail"
          >
            <Maximize2 className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Unpin task"
            className="rounded p-1 text-muted-foreground opacity-80 hover:bg-secondary hover:text-foreground"
            onClick={onUnpin}
            title="Unpin"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
          <ActivityChip icon={<Activity />} label={`${stream.length} events`} />
          {tools.total > 0 && (
            <ActivityChip
              icon={<Wrench />}
              label={`${tools.total} tools`}
              tone={tools.active > 0 ? "warn" : "muted"}
              detail={[
                tools.active > 0 ? `${tools.active} active` : null,
                tools.failed > 0 ? `${tools.failed} failed` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            />
          )}
          {files.length > 0 && (
            <ActivityChip
              icon={<FileText />}
              label={`${files.length} files`}
              detail={files.slice(0, 2).join(", ")}
            />
          )}
        </div>
      </div>

      {pending && (
        <div className="border-b border-warn/20 bg-warn/[0.06] px-3 py-2">
          <PermissionLine
            update={pending}
            taskId={task.id}
            resolvedOutcome={resolved[pending.request_id]}
          />
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2.5 p-3 text-[13px] leading-6">
          {preview.hidden > 0 && (
            <button
              type="button"
              onClick={onOpen}
              className="flex items-center justify-between rounded-md border border-border/70 bg-background/35 px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
            >
              <span>{preview.hidden} earlier updates hidden here</span>
              <span className="text-primary">more in details</span>
            </button>
          )}
          {preview.items.length === 0 && !activity && (
            <div className="flex items-center gap-2 rounded-md border border-dashed border-border/80 px-3 py-4 text-muted-foreground">
              <Clock3 className="size-4" />
              waiting for agent activity...
            </div>
          )}
          {preview.items.map((u, i) => (
            <PinnedStreamLine
              key={streamKey(u, i + preview.hidden)}
              update={u}
              taskId={task.id}
              resolved={resolved}
              compact
            />
          ))}
          {activity && <AgentActivityIndicator activity={activity} compact />}
        </div>
      </ScrollArea>

      <div className="border-t border-border/70 bg-background/35">
        <Composer
          commands={commands}
          files={projectFiles}
          filesLoading={fileListQuery.isLoading}
          imageSupported={imageSupported}
          disabled={task.status === "done"}
          placeholder="Steer this session..."
          onSend={async (submission) => {
            await daemon.request("session.prompt", { task_id: task.id, ...submission });
          }}
          toolbar={
            task.configOptions && task.configOptions.length > 0 ? (
              <AgentConfigBar taskId={task.id} options={task.configOptions} />
            ) : undefined
          }
        />
      </div>
    </Card>
  );
}

function latestCommands(updates: SessionUpdate[]): CommandInfo[] {
  for (let i = updates.length - 1; i >= 0; i -= 1) {
    const update = updates[i];
    if (update.kind === "available_commands") {
      return update.commands;
    }
  }
  return [];
}

function pinnedPreview(
  updates: SessionUpdate[],
  limit: number,
): {
  items: SessionUpdate[];
  hidden: number;
} {
  const items = updates.filter((update) => {
    if (update.kind === "available_commands" || update.kind === "permission_resolved") {
      return false;
    }
    if (update.kind === "permission_request") {
      return false;
    }
    if (update.kind === "tool_call") {
      return update.status === "in_progress" || update.status === "failed";
    }
    if (update.kind === "turn_ended") {
      return false;
    }
    return true;
  });
  return {
    hidden: Math.max(0, items.length - limit),
    items: items.slice(-limit),
  };
}

function summarizeTools(updates: SessionUpdate[]): {
  total: number;
  active: number;
  failed: number;
} {
  const tools = updates.filter(
    (u): u is Extract<SessionUpdate, { kind: "tool_call" }> => u.kind === "tool_call",
  );
  return {
    active: tools.filter((t) => t.status === "pending" || t.status === "in_progress").length,
    failed: tools.filter((t) => t.status === "failed").length,
    total: tools.length,
  };
}

function summarizeFiles(updates: SessionUpdate[]): string[] {
  const seen = new Set<string>();
  for (const update of updates) {
    if (update.kind === "file_edit") {
      seen.add(update.path.split("/").pop() || update.path);
    }
  }
  return Array.from(seen);
}

function StatusPill({
  variant,
  label,
}: {
  variant: ReturnType<typeof taskBadge>["variant"] | "warn";
  label: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-medium",
        variant === "ok" && "border-ok/35 bg-ok/10 text-ok",
        variant === "warn" && "border-warn/40 bg-warn/10 text-warn",
        variant === "destructive" && "border-destructive/40 bg-destructive/10 text-destructive",
        (variant === "default" || variant === "outline") &&
          "border-border bg-secondary/40 text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          variant === "ok" && "bg-ok",
          variant === "warn" && "bg-warn",
          variant === "destructive" && "bg-destructive",
          (variant === "default" || variant === "outline") && "bg-muted-foreground",
        )}
      />
      {label}
    </span>
  );
}

function ActivityChip({
  icon,
  label,
  detail,
  tone = "muted",
}: {
  icon: React.ReactElement;
  label: string;
  detail?: string;
  tone?: "muted" | "warn";
}) {
  return (
    <span
      className={cn(
        "flex min-w-0 max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs [&_svg]:size-3.5 [&_svg]:shrink-0",
        tone === "muted" && "border-border/70 bg-background/35 text-muted-foreground",
        tone === "warn" && "border-warn/30 bg-warn/10 text-warn",
      )}
      title={detail || label}
    >
      {icon}
      <span className="shrink-0">{label}</span>
      {detail && <span className="min-w-0 truncate opacity-70">{detail}</span>}
    </span>
  );
}

function PinnedStreamLine({
  update,
  compact,
  taskId,
  resolved,
}: {
  update: SessionUpdate;
  compact?: boolean;
  taskId?: string;
  resolved?: Record<string, string>;
}) {
  if (update.kind === "agent_text" || update.kind === "agent_thought") {
    return (
      <div
        className={cn(
          "rounded-md border border-transparent px-0.5",
          update.kind === "agent_thought" && "text-muted-foreground",
        )}
      >
        <StreamLine update={update} compact={compact} taskId={taskId} resolved={resolved} />
      </div>
    );
  }
  if (update.kind === "user_message") {
    return (
      <div className="rounded-md border border-primary/20 bg-primary/[0.07]">
        <StreamLine update={update} compact={compact} taskId={taskId} resolved={resolved} />
      </div>
    );
  }
  return <StreamLine update={update} compact={compact} taskId={taskId} resolved={resolved} />;
}

/**
 * Fold a raw session stream into what should actually be shown:
 *  - consecutive `agent_text` / `agent_thought` chunks merge into one block
 *    (codex-acp streams sub-word deltas; otherwise each renders on its own line);
 *  - repeated `tool_call` frames for the same `tool_call_id` collapse to a
 *    single row updated in place (agents re-send a call many times as its status
 *    moves in_progress → completed).
 */
/**
 * A React key that stays stable across streaming/coalescing for updates that
 * hold local UI state (permission buttons, expandable tool cards). Coalescing
 * changes element counts, so an index key would remount these and reset their
 * state; keying by the update's own id avoids that. Stateless blocks fall back
 * to the index.
 */
export function streamKey(u: SessionUpdate, i: number): string {
  if (u.kind === "tool_call") {
    return `tool:${u.tool_call_id}`;
  }
  if (u.kind === "permission_request") {
    return `perm:${u.request_id}`;
  }
  if (u.kind === "permission_resolved") {
    return `res:${u.request_id}`;
  }
  return `i:${i}`;
}

/**
 * Fold one raw update into an in-progress coalesced list. `toolAt` maps a
 * tool_call_id to its index in `out` so repeated frames update in place. Only
 * the block being mutated (the trailing text/thought run, or a tool card
 * receiving a new frame) gets a fresh object; every other block keeps its
 * identity, which lets an append-only stream be coalesced incrementally and
 * memoized row-by-row instead of rebuilt from scratch on every delta.
 */
export function appendCoalesced(
  out: SessionUpdate[],
  toolAt: Map<string, number>,
  u: SessionUpdate,
): void {
  const prev = out[out.length - 1];
  if ((u.kind === "agent_text" || u.kind === "agent_thought") && prev?.kind === u.kind) {
    out[out.length - 1] = { ...prev, text: prev.text + u.text };
  } else if (u.kind === "tool_call") {
    const at = toolAt.get(u.tool_call_id);
    const existing = at !== undefined ? out[at] : undefined;
    if (existing?.kind === "tool_call") {
      out[at!] = {
        ...existing,
        content: u.content ?? existing.content,
        status: u.status,
        started_at: existing.started_at ?? u.started_at,
        title: u.title || existing.title,
        tool_kind: u.tool_kind || existing.tool_kind,
      };
    } else {
      toolAt.set(u.tool_call_id, out.length);
      out.push(u);
    }
  } else {
    out.push(u);
  }
}

export function coalesceUpdates(updates: SessionUpdate[]): SessionUpdate[] {
  const out: SessionUpdate[] = [];
  const toolAt = new Map<string, number>();
  for (const u of updates) {
    appendCoalesced(out, toolAt, u);
  }
  return out;
}

/** Shared renderer for one session-stream update. `compact` = focus pane
 * (plain text, dense); otherwise the full Task Detail (markdown, tool cards). */
/** A tool-call card whose output can be expanded/collapsed. Collapsed by default. */
function ToolCallLine({
  update,
  dot,
}: {
  update: Extract<SessionUpdate, { kind: "tool_call" }>;
  dot: string;
}) {
  const [open, setOpen] = useState(false);
  const hasContent = Boolean(update.content);
  return (
    <div className="min-w-0 overflow-hidden rounded-md border bg-secondary/30">
      <button
        type="button"
        disabled={!hasContent}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm",
          hasContent && "hover:bg-secondary/50",
        )}
      >
        {hasContent ? (
          <ChevronRight
            className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
          />
        ) : (
          <Wrench className={cn("size-3.5 shrink-0", dot)} />
        )}
        <span className="min-w-0 flex-1 truncate font-medium" title={update.title}>
          {update.title}
        </span>
        {update.tool_kind && update.tool_kind !== "other" && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {update.tool_kind}
          </span>
        )}
        <span className={cn("shrink-0 text-xs", dot)}>{update.status.replace("_", " ")}</span>
      </button>
      {open && hasContent && (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words border-t px-2.5 py-2 font-mono text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          {update.content}
        </pre>
      )}
    </div>
  );
}

/**
 * A permission prompt with allow/deny buttons. Once answered it collapses to a
 * muted "responded" row — the update itself lingers in the stream, so we track
 * the answer locally to stop showing live buttons.
 */
function PermissionLine({
  update,
  taskId,
  resolvedOutcome,
}: {
  update: Extract<SessionUpdate, { kind: "permission_request" }>;
  taskId?: string;
  /** Outcome recorded in the stream — persists across reopen/restart. */
  resolvedOutcome?: string;
}) {
  const [clicked, setClicked] = useState<string | null>(null);
  const answered = clicked ?? resolvedOutcome ?? null;
  return (
    <div
      className={cn(
        "min-w-0 overflow-hidden rounded-md border px-2.5 py-2",
        answered ? "border-border bg-secondary/20" : "border-warn/40 bg-warn/5",
      )}
    >
      <p
        className={cn(
          "flex min-w-0 items-start gap-1.5",
          answered ? "text-muted-foreground" : "mb-2 text-warn",
        )}
      >
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{update.title}</span>
        {answered && (
          <span className="shrink-0 whitespace-nowrap text-xs">✓ {answered.replace("_", " ")}</span>
        )}
      </p>
      {!answered &&
        (taskId ? (
          <div className="flex flex-wrap gap-1.5">
            {update.options.map((opt) => (
              <Button
                key={opt}
                size="sm"
                variant={opt === "deny" ? "destructive" : "default"}
                onClick={() => {
                  setClicked(opt);
                  void daemon.request("session.permission", {
                    outcome: opt,
                    request_id: update.request_id,
                    task_id: taskId,
                  });
                }}
              >
                {opt.replace("_", " ")}
              </Button>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Open the task to respond.</p>
        ))}
    </div>
  );
}

export function StreamLine({
  update,
  compact,
  taskId,
  resolved,
  resolveFilePath,
  onOpenFile,
  thinkingActive,
}: {
  update: SessionUpdate;
  compact?: boolean;
  /** When set, permission requests render inline allow/deny buttons. */
  taskId?: string;
  /** Request_id → recorded outcome, from persisted permission_resolved updates. */
  resolved?: Record<string, string>;
  resolveFilePath?: FileLinkResolver;
  onOpenFile?: (path: string) => void;
  /** True only for the thought block currently receiving streamed deltas. */
  thinkingActive?: boolean;
}) {
  switch (update.kind) {
    case "user_message":
      return (
        <div
          className={cn(
            "rounded-md bg-primary/10 px-2.5 py-1.5 text-primary",
            compact && "text-xs",
          )}
        >
          <Markdown
            className={compact ? "text-current" : undefined}
            resolveFilePath={resolveFilePath}
            onOpenFile={onOpenFile}
          >
            {compact ? `› ${update.text}` : update.text}
          </Markdown>
          {!!update.attachments?.length && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {update.attachments.map((attachment, index) => (
                <span
                  key={`${attachment.type}-${index}`}
                  className="rounded border border-primary/20 bg-background/40 px-1.5 py-0.5 font-mono text-[10px]"
                >
                  {attachment.type === "file" ? `@${attachment.path}` : `image: ${attachment.name}`}
                </span>
              ))}
            </div>
          )}
        </div>
      );
    case "agent_text":
      return compact ? (
        <Markdown
          className="text-current"
          resolveFilePath={resolveFilePath}
          onOpenFile={onOpenFile}
        >
          {update.text}
        </Markdown>
      ) : (
        <BufferedMarkdown resolveFilePath={resolveFilePath} onOpenFile={onOpenFile}>
          {update.text}
        </BufferedMarkdown>
      );
    case "agent_thought":
      return compact ? (
        <Markdown
          className="italic text-muted-foreground"
          resolveFilePath={resolveFilePath}
          onOpenFile={onOpenFile}
        >
          {update.text}
        </Markdown>
      ) : (
        <ThinkingBlock
          text={update.text}
          streaming={Boolean(thinkingActive)}
          resolveFilePath={resolveFilePath}
          onOpenFile={onOpenFile}
        />
      );
    case "tool_call": {
      const dot =
        update.status === "completed"
          ? "text-ok"
          : update.status === "failed"
            ? "text-destructive"
            : "text-warn";
      if (compact) {
        return (
          <p className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <Wrench className={cn("size-3.5 shrink-0", dot)} />
            <span className="min-w-0 truncate text-foreground" title={update.title}>
              {update.title}
            </span>
          </p>
        );
      }
      return <ToolCallLine update={update} dot={dot} />;
    }
    case "file_edit":
      const filePath = resolveFilePath?.(update.path) ?? null;
      return (
        <p className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
          <FilePen className="size-3.5 shrink-0 text-primary" />
          {filePath && onOpenFile ? (
            <button
              type="button"
              onClick={() => onOpenFile(filePath)}
              className="min-w-0 truncate text-left text-primary hover:underline"
              title={`Open ${filePath}`}
            >
              {update.path}
            </button>
          ) : (
            <span className="min-w-0 truncate" title={update.path}>
              {update.path}
            </span>
          )}
        </p>
      );
    case "permission_request":
      return (
        <PermissionLine
          update={update}
          taskId={taskId}
          resolvedOutcome={resolved?.[update.request_id]}
        />
      );
    case "permission_resolved":
      // Metadata only — folded into the permission_request row above.
      return null;
    case "plan":
      if (compact) {
        const done = update.entries.filter((e) => e.status === "completed").length;
        return (
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <ListTodo className="size-3.5 shrink-0" />
            plan · {done}/{update.entries.length}
          </p>
        );
      }
      return (
        <div className="rounded-md border bg-secondary/30 p-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <ListTodo className="size-3.5" /> Plan
          </div>
          <ul className="space-y-1 text-sm">
            {update.entries.map((e) => (
              <li
                key={`${e.status}:${e.priority ?? ""}:${e.content}`}
                className="flex items-start gap-2"
              >
                <span
                  className={cn(
                    "mt-0.5",
                    e.status === "completed"
                      ? "text-ok"
                      : e.status === "in_progress"
                        ? "text-warn"
                        : "text-muted-foreground",
                  )}
                >
                  {e.status === "completed" ? "✓" : e.status === "in_progress" ? "◐" : "○"}
                </span>
                <span
                  className={cn(e.status === "completed" && "text-muted-foreground line-through")}
                >
                  {e.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      );
    case "available_commands":
    case "prompt_capabilities":
      // Metadata for the composer's slash menu — not shown inline.
      return null;
    case "turn_ended":
      if (compact) {
        return null;
      }
      return (
        <p className="text-center text-xs text-muted-foreground">
          Agent is waiting for the next instruction.
        </p>
      );
  }
}
