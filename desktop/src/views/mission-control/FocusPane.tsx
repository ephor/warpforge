import { useQuery } from "@tanstack/react-query";
import { Activity, ExternalLink, FileText, MoreHorizontal, PinOff, Wrench } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { sessionActivity } from "@/lib/sessionActivity";
import { latestPendingPermission } from "@/lib/sessionPermissions";
import { latestCommands, summarizeFiles, summarizeTools } from "@/lib/sessionUpdatesSummary";
import { elapsed } from "@/lib/status";
import {
  flattenTaskTree,
  resolveGroupTaskId,
  taskGroupStatus,
  type TaskGroupStatus,
  type TaskTree,
} from "@/lib/taskGroups";
import { taskLabel } from "@/lib/taskLabel";
import { cn } from "@/lib/utils";

import { AgentAvatarGroup } from "../../components/AgentAvatar";
import { SessionChat } from "../../components/SessionChat";
import { StatusBadge, type TaskBadgeStatus } from "../../components/StatusBadge";
import { TaskAgentSwitcher } from "../../components/TaskAgentSwitcher";
import type { DaemonState } from "../../daemon";
import type { AgentConfig, EditHunk, ProjectFile, SessionUpdate, TaskInfo } from "../../protocol";
import { daemonQuery } from "../../query";
import { useUi } from "../../store/ui";
import { coalesceTailUpdates } from "../missionControlStream";

const FOCUS_PANE_RAW_TAIL = 300;

interface FocusGroupPaneProps {
  tree: TaskTree;
  updatesByTaskId: DaemonState["sessionUpdates"];
  attentionTargetId: string | null;
  attentionTargetNonce: number;
  onUnpin: (tree: TaskTree) => void;
  onOpen: (id: string) => void;
  agents: AgentConfig[];
}

export const FocusGroupPane = memo(function FocusGroupPane({
  tree,
  updatesByTaskId,
  attentionTargetId,
  attentionTargetNonce,
  onUnpin,
  onOpen,
  agents,
}: FocusGroupPaneProps) {
  const members = useMemo(() => flattenTaskTree(tree), [tree]);
  const childAgents = useMemo(
    () => [...new Set(tree.children.map((c) => c.task.agent))],
    [tree.children],
  );
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

  return (
    <FocusPane
      task={selectedTask}
      updates={updatesByTaskId[selectedTask.id] ?? []}
      tree={tree}
      selectedId={selectedTask.id}
      groupStatus={status}
      childAgents={childAgents}
      agents={agents}
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

/**
 * Collapse a group status onto the StatusBadge vocabulary. "review" is a
 * rollup, not a task status — the underlying tasks are `waiting` with a diff.
 */
function groupStatusKind(status: TaskGroupStatus): TaskBadgeStatus {
  return status === "review" ? "waiting" : status;
}

function FocusPane({
  task,
  updates,
  tree,
  selectedId,
  groupStatus,
  childAgents,
  agents,
  onSelect,
  onUnpin,
  onOpen,
}: {
  task: TaskInfo;
  updates: SessionUpdate[];
  tree: TaskTree;
  selectedId: string;
  groupStatus: TaskGroupStatus;
  childAgents?: string[];
  agents: AgentConfig[];
  onSelect: (id: string) => void;
  onUnpin: () => void;
  onOpen: () => void;
}) {
  const stream = useMemo(() => coalesceTailUpdates(updates, FOCUS_PANE_RAW_TAIL), [updates]);
  const tools = useMemo(() => summarizeTools(updates), [updates]);
  const files = useMemo(() => summarizeFiles(updates), [updates]);
  const commands = useMemo(() => latestCommands(updates), [updates]);
  const fileListQuery = useQuery({
    queryFn: daemonQuery<ProjectFile[]>("file.list", { task_id: task.id }),
    queryKey: ["fileList", task.id, "tracked"],
  });
  const projectFiles = useMemo(
    () => (Array.isArray(fileListQuery.data) ? fileListQuery.data : []),
    [fileListQuery.data],
  );
  const capability = [...updates].reverse().find((update) => update.kind === "prompt_capabilities");
  const imageSupported = capability?.kind === "prompt_capabilities" ? capability.image : false;
  const activity = sessionActivity(task, stream);
  const openTask = useUi((s) => s.openTask);
  const openTaskWithNav = useUi((s) => s.openTaskWithNav);
  const composerRef = useRef<import("../../components/Composer").ComposerHandle>(null);
  const knownFilePaths = useMemo(
    () => new Set(projectFiles.map((file) => file.path)),
    [projectFiles],
  );
  const resolvePinnedFilePath = useCallback(
    (value: string): string | null => {
      let path = value.trim().replace(/^['"`]+|['"`]+$/g, "");
      path = path.replace(/:\d+(?::\d+)?$/, "");
      path = path.replace(/[),;]+$/, "");
      path = path.replace(/^\.\/+/, "");
      return knownFilePaths.has(path) ? path : null;
    },
    [knownFilePaths],
  );
  const openFile = useCallback(
    (path: string) => openTaskWithNav(task.id, { surface: "files", path }),
    [openTaskWithNav, task.id],
  );
  const openFileDiff = useCallback(
    (path: string, hunks?: EditHunk[]) =>
      openTaskWithNav(task.id, { surface: "diff", path, hunks }),
    [openTaskWithNav, task.id],
  );

  return (
    <Card
      className={cn(
        "group flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-border/80 bg-card shadow-none",
      )}
    >
      <div className="border-b border-border/80 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={onOpen}
            className="min-w-0 flex-1 truncate text-left text-[15px] font-semibold leading-5 text-foreground hover:text-primary"
            title={task.prompt}
          >
            {taskLabel(task)}
          </button>
          <div className="flex shrink-0 items-center">
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
              aria-label="Unpin from Mission Control"
              className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
              onClick={onUnpin}
              title="Unpin from Mission Control"
            >
              <PinOff className="size-3.5" />
            </button>
          </div>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
          <StatusBadge status={groupStatusKind(groupStatus)} activity={activity} size="xs" />
          <span className="min-w-0 truncate font-semibold text-foreground/90">{task.project}</span>
          <span className="ml-auto flex shrink-0 items-center gap-2">
            <AgentAvatarGroup agentId={task.agent} childAgents={childAgents} />
            <span aria-hidden className="h-1 w-1 rounded-full bg-muted-foreground/40" />
            <span className="tnum">{elapsed(task.updatedAt)}</span>
          </span>
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

      <SessionChat
        activity={activity}
        active
        commands={commands}
        composerRef={composerRef}
        files={projectFiles}
        filesLoading={fileListQuery.isLoading}
        imageSupported={imageSupported}
        onOpenFile={openFile}
        onOpenFileDiff={openFileDiff}
        resolveFilePath={resolvePinnedFilePath}
        task={task}
        updates={updates}
        agents={agents}
        onOpenTask={openTask}
      />
    </Card>
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
