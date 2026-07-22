import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ChevronRight,
  Clock3,
  ExternalLink,
  FilePen,
  FileText,
  ListTodo,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PinOff,
  Plus,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { withOccurrenceKeys } from "@/lib/renderKeys";
import { sessionActivity } from "@/lib/sessionActivity";
import {
  latestPendingPermission,
  pendingPermission,
  resolvedPermissions,
} from "@/lib/sessionPermissions";
import { latestContextUsage } from "@/lib/sessionUsage";
import { activityBadge, elapsed, taskBadge } from "@/lib/status";
import { taskLabel } from "@/lib/taskLabel";
import {
  buildTaskGroupIndex,
  flattenTaskTree,
  resolvePinnedTaskGroups,
  resolveGroupTaskId,
  setTaskGroupPinned,
  taskGroupStatus,
  type TaskGroupStatus,
  type TaskTree,
} from "@/lib/taskGroups";
import { toolDisplayTitle } from "@/lib/toolDisplay";
import { cn } from "@/lib/utils";

import { AgentActivityIndicator } from "../components/AgentActivityIndicator";
import { AgentBadge } from "../components/AgentBadge";
import { AgentConfigBar } from "../components/AgentConfigBar";
import { Composer } from "../components/Composer";
import type { FileLinkResolver } from "../components/Markdown";
import { BufferedMarkdown, Markdown } from "../components/Markdown";
import { TaskAgentSwitcher } from "../components/TaskAgentSwitcher";
import { ThinkingBlock } from "../components/ThinkingBlock";
import type { DaemonState } from "../daemon";
import { daemon } from "../daemon";
import type { CommandInfo, ProjectFile, SessionUpdate, TaskInfo } from "../protocol";
import { daemonQuery } from "../query";
import { useUi } from "../store/ui";
import { coalesceUpdates, streamKey } from "./missionControlStream";

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
const FOCUSED_PREVIEW_LIMIT = 24;

export default function MissionControl({ state, onOpenTask, onNewTask }: Props) {
  const pinned = useUi((s) => s.pinnedTaskIds);
  const setPinnedTaskIds = useUi((s) => s.setPinnedTaskIds);
  const attentionTargetId = useUi((s) => s.attentionTargetId);
  const attentionTargetNonce = useUi((s) => s.attentionTargetNonce);
  const [focusedGroupId, setFocusedGroupId] = useState<string | null>(null);
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
      setPinnedTaskIds(setTaskGroupPinned(groupIndex, pinned, tree.task.id, false));
      setFocusedGroupId((current) => (current === tree.task.id ? null : current));
    },
    [groupIndex, pinned, setPinnedTaskIds],
  );
  const handleFocus = useCallback((id: string | null) => setFocusedGroupId(id), []);
  const resolvedFocusedGroupId = pinnedGroups.some((tree) => tree.task.id === focusedGroupId)
    ? focusedGroupId
    : null;
  const visibleGroups = resolvedFocusedGroupId
    ? pinnedGroups.filter((tree) => tree.task.id === resolvedFocusedGroupId)
    : pinnedGroups;

  return (
    <ScrollArea className="h-full min-h-0">
      <div className="flex flex-col gap-2 pr-2">
        {pinnedGroups.length > 0 ? (
          <div
            className={cn("grid grid-cols-1 gap-2", !resolvedFocusedGroupId && "xl:grid-cols-2")}
          >
            {visibleGroups.map((tree) => (
              <FocusGroupPane
                key={tree.task.id}
                tree={tree}
                updatesByTaskId={state.sessionUpdates}
                attentionTargetId={attentionTargetId}
                attentionTargetNonce={attentionTargetNonce}
                onUnpin={handleUnpin}
                onOpen={onOpenTask}
                focused={resolvedFocusedGroupId === tree.task.id}
                onFocus={handleFocus}
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
  focused: boolean;
  onFocus: (id: string | null) => void;
}

const FocusGroupPane = memo(function FocusGroupPane({
  tree,
  updatesByTaskId,
  attentionTargetId,
  attentionTargetNonce,
  onUnpin,
  onOpen,
  focused,
  onFocus,
}: FocusGroupPaneProps) {
  const members = useMemo(() => flattenTaskTree(tree), [tree]);
  const [selectedId, setSelectedId] = useState(() =>
    resolveGroupTaskId(tree, null, attentionTargetId),
  );

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
  const handleFocus = useCallback(
    () => onFocus(focused ? null : tree.task.id),
    [focused, onFocus, tree.task.id],
  );

  return (
    <FocusPane
      task={selectedTask}
      updates={updatesByTaskId[selectedTask.id] ?? []}
      tree={tree}
      selectedId={selectedTask.id}
      groupStatus={status}
      onSelect={handleSelect}
      onUnpin={handleUnpin}
      onOpen={handleOpen}
      focused={focused}
      onFocus={handleFocus}
    />
  );
}, focusGroupPaneEqual);

function focusGroupPaneEqual(previous: FocusGroupPaneProps, next: FocusGroupPaneProps) {
  if (
    previous.tree !== next.tree ||
    previous.attentionTargetId !== next.attentionTargetId ||
    previous.attentionTargetNonce !== next.attentionTargetNonce ||
    previous.onOpen !== next.onOpen ||
    previous.onUnpin !== next.onUnpin ||
    previous.focused !== next.focused ||
    previous.onFocus !== next.onFocus
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

function FocusPane({
  task,
  updates,
  tree,
  selectedId,
  groupStatus,
  onSelect,
  onUnpin,
  onOpen,
  focused,
  onFocus,
}: {
  task: TaskInfo;
  updates: SessionUpdate[];
  tree: TaskTree;
  selectedId: string;
  groupStatus: TaskGroupStatus;
  onSelect: (id: string) => void;
  onUnpin: () => void;
  onOpen: () => void;
  focused: boolean;
  onFocus: () => void;
}) {
  const stream = useMemo(() => coalesceUpdates(updates), [updates]);
  const resolved = useMemo(() => resolvedPermissions(stream), [stream]);
  const pending = useMemo(() => pendingPermission(stream, resolved), [stream, resolved]);
  const preview = useMemo(
    () => pinnedPreview(stream, focused ? FOCUSED_PREVIEW_LIMIT : PINNED_PREVIEW_LIMIT),
    [focused, stream],
  );
  const tools = useMemo(() => summarizeTools(stream), [stream]);
  const files = useMemo(() => summarizeFiles(stream), [stream]);
  const commands = useMemo(() => latestCommands(updates), [updates]);
  const contextUsage = useMemo(() => latestContextUsage(updates), [updates]);
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
        "group flex h-[520px] min-h-[420px] flex-col overflow-hidden rounded-md border border-border/80 bg-card shadow-none",
        focused && "h-[calc(100vh-3rem)]",
      )}
    >
      <div className="border-b border-border/80 px-3 py-1.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex min-w-0 items-center gap-2 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              <span className="truncate font-semibold text-foreground/90">{task.project}</span>
              <span className="h-1 w-1 rounded-full bg-muted-foreground/40" />
              <AgentBadge agentId={task.agent} size="xs" />
              <span className="h-1 w-1 rounded-full bg-muted-foreground/40" />
              <span className="tnum shrink-0">{elapsed(task.updatedAt)}</span>
            </div>
            <button
              type="button"
              onClick={onOpen}
              className="block max-w-full truncate text-left text-[15px] font-semibold leading-5 text-foreground hover:text-primary"
              title={task.prompt}
            >
              {taskLabel(task)}
            </button>
          </div>
          <StatusPill variant={badge.variant} label={badge.label} />
          <button
            type="button"
            aria-label="Open task details"
            className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
            onClick={onOpen}
            title="Open task details"
          >
            <ExternalLink className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label={focused ? "Exit focus mode" : "Focus this conversation"}
            className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
            onClick={onFocus}
            title={focused ? "Exit focus mode" : "Focus"}
          >
            {focused ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
          <button
            type="button"
            aria-label="Unpin from Mission Control"
            className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
            onClick={onUnpin}
            title="Unpin from Mission Control"
          >
            <PinOff className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="flex h-9 shrink-0 items-center border-b border-border/80 px-3">
        <span className="text-xs font-semibold text-foreground">Conversation</span>
        <div className="ml-auto flex items-center gap-1">
          <TaskAgentSwitcher currentTaskId={selectedId} tree={tree} onOpenTask={onSelect} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Conversation activity"
                className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
                title="Activity"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64 p-2">
              <div className="flex flex-wrap gap-1">
                <ActivityChip icon={<Activity />} label={`${stream.length} events`} />
                {tools.total > 0 && (
                  <ActivityChip
                    icon={<Wrench />}
                    label={`${tools.total} tools`}
                    tone={tools.active > 0 ? "warn" : "muted"}
                    detail={tools.failed > 0 ? `${tools.failed} failed` : undefined}
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
            </DropdownMenuContent>
          </DropdownMenu>
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
        <div className="flex flex-col gap-2 p-2.5 text-[13px] leading-6">
          {preview.hidden > 0 && (
            <button
              type="button"
              onClick={onOpen}
              className="flex items-center justify-between rounded border border-border/60 bg-background/20 px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
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

      <div className="border-t border-border/80">
        <Composer
          compact
          commands={commands}
          contextUsage={contextUsage}
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
    if (
      update.kind === "available_commands" ||
      update.kind === "permission_resolved" ||
      update.kind === "usage"
    ) {
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
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs font-medium",
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
        "flex min-w-0 max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-xs [&_svg]:size-3 [&_svg]:shrink-0",
        tone === "muted" && "bg-background/25 text-muted-foreground",
        tone === "warn" && "bg-warn/10 text-warn",
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
    return <StreamLine update={update} compact={compact} taskId={taskId} resolved={resolved} />;
  }
  return <StreamLine update={update} compact={compact} taskId={taskId} resolved={resolved} />;
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
  const title = toolDisplayTitle(update);
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
        <span className="min-w-0 flex-1 truncate font-medium" title={title}>
          {title}
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
  project,
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
  /** Project root label retained after stripping the machine-specific prefix. */
  project?: string;
  /** True only for the thought block currently receiving streamed deltas. */
  thinkingActive?: boolean;
}) {
  switch (update.kind) {
    case "user_message":
      return (
        <div
          className={cn(
            "rounded-md border border-primary/15 bg-primary/[0.07] px-2.5 py-1.5 text-foreground",
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
              {withOccurrenceKeys(update.attachments, (attachment) =>
                attachment.type === "file" ? `file:${attachment.path}` : `image:${attachment.name}`,
              ).map(({ item: attachment, key }) => (
                <span
                  key={key}
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
      const title = toolDisplayTitle(update);
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
            <span className="min-w-0 truncate text-foreground" title={title}>
              {title}
            </span>
          </p>
        );
      }
      return <ToolCallLine update={update} dot={dot} />;
    }
    case "file_edit":
      const filePath = resolveFilePath?.(update.path) ?? null;
      const displayPath = filePath
        ? project && filePath !== project && !filePath.startsWith(`${project}/`)
          ? `${project}/${filePath}`
          : filePath
        : update.path;
      const hasLineCounts = update.additions !== undefined || update.deletions !== undefined;
      return (
        <p className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
          <FilePen className="size-3.5 shrink-0 text-primary" />
          {filePath && onOpenFile ? (
            <button
              type="button"
              onClick={() => onOpenFile(filePath)}
              className="min-w-0 flex-1 truncate text-left text-primary hover:underline"
              title={`Open ${filePath}`}
            >
              {displayPath}
            </button>
          ) : (
            <span className="min-w-0 flex-1 truncate" title={displayPath}>
              {displayPath}
            </span>
          )}
          {hasLineCounts && (
            <span
              className="ml-auto inline-flex shrink-0 items-center gap-1 tabular-nums"
              aria-label={`${update.additions ?? 0} lines added, ${update.deletions ?? 0} lines deleted`}
            >
              <span className="text-ok">+{update.additions ?? 0}</span>
              <span className="text-destructive">−{update.deletions ?? 0}</span>
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
    case "usage":
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
