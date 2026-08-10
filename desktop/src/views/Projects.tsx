import {
  ChevronDown,
  ChevronRight,
  EllipsisVertical,
  FolderGit2,
  GitBranch,
  Pencil,
  Play,
  Share2,
  Square,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AgentAvatarGroup } from "@/components/AgentAvatar";
import { RuntimePanel } from "@/components/RuntimePanel";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { elapsed, pfBadge, serviceBadge } from "@/lib/status";
import { awaitsReview, buildTaskForest, flattenTaskTree, type TaskTree } from "@/lib/taskGroups";
import { taskLabel } from "@/lib/taskLabel";
import { disposeTerminalWorkspace } from "@/lib/terminalWorkspace";
import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";

import { daemon } from "../daemon";
import type { PortForwardInfo, ServiceInfo, Snapshot } from "../protocol";
import { type ProjectLiveCounts, RemoveProjectDialog } from "./projects/RemoveProjectDialog";

interface Props {
  snapshot: Snapshot;
  onOpenTask: (id: string) => void;
  onNewTask: (project?: string, prompt?: string) => void;
  onAddProject?: () => void;
}

function taskTreeHasActiveWork(tree: TaskTree): boolean {
  return flattenTaskTree(tree).some((task) => task.status !== "done");
}

function taskTreeIsRecent(tree: TaskTree): boolean {
  return flattenTaskTree(tree).every((task) => task.status === "done");
}

function taskTreeUpdatedAt(tree: TaskTree): number {
  return Math.max(...flattenTaskTree(tree).map((task) => task.updatedAt));
}

function taskCountLabel(count: number): string {
  return `${count} task${count === 1 ? "" : "s"}`;
}

function countTreeTasks(
  trees: TaskTree[],
  predicate: (status: TaskTree["task"]["status"]) => boolean,
) {
  return trees.reduce(
    (count, tree) => count + flattenTaskTree(tree).filter((task) => predicate(task.status)).length,
    0,
  );
}

export default function Projects({ snapshot, onOpenTask, onNewTask, onAddProject }: Props) {
  const selectedProjectId = useUi((state) => state.selectedProjectId);
  const openProject = useUi((state) => state.openProject);
  const [removeProject, setRemoveProject] = useState<string | null>(null);
  const [showRecent, setShowRecent] = useState(false);
  const [runtimeActionError, setRuntimeActionError] = useState<string | null>(null);

  const project =
    snapshot.projects.find((p) => p.name === selectedProjectId) ?? snapshot.projects[0] ?? null;
  const projectName = project?.name ?? "";

  useEffect(() => {
    setRuntimeActionError(null);
  }, [projectName]);

  /* Hooks below run before the `if (!project)` guard, so nothing here may
     dereference `project`: with an empty registry it is undefined at runtime,
     which TS misses because indexing `projects[0]` is not typed as optional. */
  const declaredServices = useMemo(() => project?.declaredServices ?? [], [project]);
  const runtimeOpen = useUi((state) => state.runtimeOpenByProject[projectName] ?? false);
  const setRuntimeOpen = useUi((state) => state.setRuntimeOpen);
  const clearRuntimeOpen = useUi((state) => state.clearRuntimeOpen);
  const services = useMemo(
    () => snapshot.services.filter((s) => s.project === projectName),
    [snapshot.services, projectName],
  );
  const runtimeServices = useMemo(() => {
    const knownNames = new Set(services.map((service) => service.name));
    const missingDeclaredServices = declaredServices
      .filter((name) => !knownNames.has(name))
      .map(
        (name): ServiceInfo => ({
          allocatedPort: 0,
          command: "",
          logSeq: 0,
          name,
          originalPort: 0,
          project: projectName,
          status: "stopped",
        }),
      );
    return [...services, ...missingDeclaredServices];
  }, [declaredServices, projectName, services]);
  const pfs = useMemo(
    () => snapshot.portforwards.filter((pf) => pf.project === projectName),
    [snapshot.portforwards, projectName],
  );
  const projectTasks = useMemo(
    () => snapshot.tasks.filter((t) => t.project === projectName),
    [snapshot.tasks, projectName],
  );
  const projectTaskForest = useMemo(() => buildTaskForest(projectTasks), [projectTasks]);
  const activeTaskForest = useMemo(
    () =>
      projectTaskForest
        .filter(taskTreeHasActiveWork)
        .sort((a, b) => taskTreeUpdatedAt(b) - taskTreeUpdatedAt(a)),
    [projectTaskForest],
  );
  const recentTaskForest = useMemo(
    () =>
      projectTaskForest
        .filter(taskTreeIsRecent)
        .sort((a, b) => taskTreeUpdatedAt(b) - taskTreeUpdatedAt(a)),
    [projectTaskForest],
  );
  const projectTerminals = useMemo(
    () => snapshot.terminals.filter((terminal) => terminal.project === projectName),
    [snapshot.terminals, projectName],
  );
  const running = useMemo(
    () => services.filter((s) => s.status === "running" && s.allocatedPort > 0),
    [services],
  );
  const activeTaskCount = useMemo(
    () => countTreeTasks(activeTaskForest, (status) => status !== "done"),
    [activeTaskForest],
  );
  const recentTaskCount = useMemo(
    () => countTreeTasks(recentTaskForest, (status) => status === "done"),
    [recentTaskForest],
  );
  const allDeclaredServicesRunning =
    declaredServices.length > 0 &&
    declaredServices.every(
      (name) => runtimeServices.find((service) => service.name === name)?.status === "running",
    );
  const removeLiveCounts = useMemo<ProjectLiveCounts>(() => {
    if (!removeProject) return { services: 0, portforwards: 0, terminals: 0 };
    return {
      services: snapshot.services.filter(
        (service) =>
          service.project === removeProject &&
          (service.status === "running" || service.status === "starting"),
      ).length,
      portforwards: snapshot.portforwards.filter(
        (forward) =>
          forward.project === removeProject &&
          (forward.status === "active" ||
            forward.status === "starting" ||
            forward.status === "restarting"),
      ).length,
      terminals: snapshot.terminals.filter((terminal) => terminal.project === removeProject).length,
    };
  }, [removeProject, snapshot.portforwards, snapshot.services, snapshot.terminals]);

  const runRuntimeAction = useCallback(async (method: string, params: Record<string, string>) => {
    setRuntimeActionError(null);
    try {
      await daemon.request(method, params);
    } catch (reason) {
      setRuntimeActionError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  const confirmProjectRemoval = useCallback(async () => {
    if (!removeProject) return;
    const remainingProjects = snapshot.projects.filter((item) => item.name !== removeProject);
    await daemon.removeProject(removeProject, true);
    disposeTerminalWorkspace(removeProject);
    clearRuntimeOpen(removeProject);
    setRemoveProject(null);
    if (selectedProjectId === removeProject) {
      openProject(remainingProjects[0]?.name ?? "");
    }
  }, [clearRuntimeOpen, openProject, removeProject, selectedProjectId, snapshot.projects]);

  if (!project) {
    return (
      <div className="mt-16 flex flex-col items-center gap-4 text-center text-muted-foreground">
        <p>
          No projects registered. Run <code className="text-foreground">wf add &lt;path&gt;</code>{" "}
          or add one below.
        </p>
        <Button variant="outline" onClick={onAddProject}>
          <FolderGit2 className="mr-1 size-4" />
          Add Project
        </Button>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex min-w-0 flex-col gap-2 pb-4">
        <header className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 px-1">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-xl font-semibold leading-none tracking-tight">
                {project.name}
              </h1>
              <Badge variant="outline" className="shrink-0 text-[11px]">
                {taskCountLabel(projectTasks.length)}
              </Badge>
            </div>
            <p className="truncate text-xs text-muted-foreground" title={project.path}>
              {project.path} · ports{" "}
              <span className="tnum">
                {project.portRange[0]}–{project.portRange[1]}
              </span>
              {activeTaskCount > 0 && <span> · {activeTaskCount} active</span>}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="Project menu"
                  title={`Actions for ${project.name}`}
                  className="h-8 w-8 gap-0 px-0 text-muted-foreground"
                >
                  <EllipsisVertical className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled>
                  <Pencil className="size-4" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => setRemoveProject(project.name)}
                >
                  <Trash2 className="size-4" />
                  Remove project
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Toggle ${project.name} Runtime`}
              aria-controls={`project-runtime-${project.name}`}
              aria-pressed={runtimeOpen}
              onClick={() => setRuntimeOpen(project.name, !runtimeOpen)}
              className={cn(
                "h-8 gap-1.5 px-2.5 text-xs",
                runtimeOpen && "border-primary/30 bg-primary/10 text-foreground",
              )}
            >
              <SquareTerminal className="size-3.5" />
              Runtime
              {projectTerminals.length > 0 && (
                <span
                  className="tnum rounded bg-primary/15 px-1 text-[10px] text-primary"
                  aria-label={`${projectTerminals.length} active terminal${projectTerminals.length === 1 ? "" : "s"}`}
                >
                  {projectTerminals.length}
                </span>
              )}
            </Button>
            <Button
              type="button"
              size="sm"
              aria-label={`New task in ${project.name}`}
              onClick={() => onNewTask(project.name)}
              className="h-8 gap-1.5 px-2.5"
            >
              + New task
            </Button>
          </div>
        </header>

        <TaskSection
          title="Active work"
          description="Live, queued, or waiting tasks"
          count={activeTaskCount}
          trees={activeTaskForest}
          emptyLabel={projectTasks.length === 0 ? "No tasks yet." : "No active tasks."}
          onOpenTask={onOpenTask}
        />

        {recentTaskForest.length > 0 && (
          <RecentShelf
            count={recentTaskCount}
            open={showRecent}
            onToggle={() => setShowRecent((value) => !value)}
          >
            <TaskSection
              title="Recent"
              description="Completed tasks from this project"
              count={recentTaskCount}
              trees={recentTaskForest}
              muted
              onOpenTask={onOpenTask}
            />
          </RecentShelf>
        )}

        <Card className="overflow-hidden rounded-md border-border/80 bg-card shadow-none">
          <div className="flex min-h-9 items-center gap-2 border-b border-border/80 px-3 text-[13px] font-medium text-muted-foreground">
            <Share2 className="size-3.5 text-primary" />
            <span>Agent context</span>
            {running.length > 0 && (
              <span className="ml-auto text-[11px] text-ok">{running.length} live</span>
            )}
          </div>
          <div className="p-3">
            {running.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Nothing running yet. Start services and new tasks will know the app is up, on
                which ports, and can run tests against it.
              </p>
            ) : (
              <div className="flex flex-col gap-1 font-mono text-xs">
                {running.map((s) => (
                  <div key={s.name} className="flex gap-2">
                    <span className="text-muted-foreground">{s.name}</span>
                    <span className="tnum text-primary">http://localhost:{s.allocatedPort}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>

        <Card
          id={`project-runtime-${project.name}`}
          className="overflow-hidden rounded-md border-border/80 bg-card shadow-none"
        >
          <div className="flex min-h-9 items-center gap-2 border-b border-border/80 px-3 text-[13px] font-medium text-muted-foreground">
            <SquareTerminal className="size-3.5 text-primary" />
            <span>Runtime</span>
            <span className="text-[11px] text-muted-foreground/70">
              {runtimeResourceSummary(runtimeServices, pfs, projectTerminals)}
            </span>
            {runtimeActionError && (
              <span
                role="alert"
                className="max-w-48 truncate text-[11px] text-destructive"
                title={runtimeActionError}
              >
                {runtimeActionError}
              </span>
            )}
            <div className="ml-auto flex items-center gap-1">
              {project.declaredServices.length > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={cn(
                    "h-7 gap-1.5 px-2 text-xs",
                    allDeclaredServicesRunning &&
                      "border-destructive/20 bg-destructive/5 text-destructive/75 hover:border-destructive/35 hover:bg-destructive/10 hover:text-destructive",
                  )}
                  aria-label={
                    allDeclaredServicesRunning ? "Stop all services" : "Start all services"
                  }
                  onClick={() =>
                    void runRuntimeAction(
                      allDeclaredServicesRunning ? "service.stopAll" : "service.startAll",
                      { project: project.name },
                    )
                  }
                >
                  {allDeclaredServicesRunning ? (
                    <Square className="size-3" />
                  ) : (
                    <Play className="size-3" />
                  )}
                  {allDeclaredServicesRunning ? "Stop services" : "Start services"}
                </Button>
              )}
              {pfs.length > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={cn(
                    "h-7 gap-1.5 px-2 text-xs",
                    pfs.every((portforward) => portforward.status === "active") &&
                      "border-destructive/20 bg-destructive/5 text-destructive/75 hover:border-destructive/35 hover:bg-destructive/10 hover:text-destructive",
                  )}
                  aria-label={
                    pfs.every((portforward) => portforward.status === "active")
                      ? "Stop all port-forwards"
                      : "Start all port-forwards"
                  }
                  onClick={() =>
                    void runRuntimeAction(
                      pfs.every((portforward) => portforward.status === "active")
                        ? "portforward.stopAll"
                        : "portforward.startAll",
                      { project: project.name },
                    )
                  }
                >
                  {pfs.every((portforward) => portforward.status === "active") ? (
                    <Square className="size-3" />
                  ) : (
                    <Play className="size-3" />
                  )}
                  {pfs.every((portforward) => portforward.status === "active")
                    ? "Stop forwards"
                    : "Start forwards"}
                </Button>
              )}
              <button
                type="button"
                className="ml-auto flex min-h-8 items-center gap-1 rounded px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-controls={`runtime-panel-${project.name}`}
                aria-expanded={runtimeOpen}
                onClick={() => setRuntimeOpen(project.name, !runtimeOpen)}
              >
                {runtimeOpen ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
                {runtimeOpen ? "Hide controls" : "Show controls"}
              </button>
            </div>
          </div>
          <RuntimeSummary
            declaredServices={project.declaredServices}
            services={runtimeServices}
            portforwards={pfs}
            terminals={projectTerminals}
          />
          {runtimeOpen && (
            <div
              id={`runtime-panel-${project.name}`}
              className="h-[360px] min-h-[320px] max-h-[380px]"
            >
              <RuntimePanel
                key={project.name}
                project={project.name}
                services={runtimeServices}
                portforwards={pfs}
                initialTab={projectTerminals.length > 0 ? "terminal" : "services"}
                onAppendToChat={(formattedLogs) => onNewTask(project.name, formattedLogs)}
              />
            </div>
          )}
        </Card>
      </div>

      <RemoveProjectDialog
        project={removeProject}
        liveCounts={removeLiveCounts}
        onCancel={() => setRemoveProject(null)}
        onConfirm={confirmProjectRemoval}
      />
    </ScrollArea>
  );
}

function RecentShelf({
  count,
  open,
  onToggle,
  children,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "Hide" : "Show"} ${count} done task${count === 1 ? "" : "s"}`}
        onClick={onToggle}
        className="flex h-7 w-full items-center gap-1.5 rounded-md px-1 text-left text-[11px] text-muted-foreground/45 transition-colors hover:bg-accent/50 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <ChevronRight
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
        />
        <span className="tnum">{count}</span>
        <span className="min-w-0 truncate">done</span>
      </button>
      {open && <div className="mt-1">{children}</div>}
    </div>
  );
}

function runtimeResourceSummary(
  services: ServiceInfo[],
  portforwards: PortForwardInfo[],
  terminals: Snapshot["terminals"],
): string {
  const resources = services.length + portforwards.length;
  const parts: string[] = [];
  if (resources > 0)
    parts.push(
      `${resources} service${resources === 1 ? "" : "s"}/forward${resources === 1 ? "" : "s"}`,
    );
  if (terminals.length > 0) {
    parts.push(`${terminals.length} terminal${terminals.length === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "No live resources";
}

function RuntimeSummary({
  declaredServices,
  services,
  portforwards,
  terminals,
}: {
  declaredServices: string[];
  services: ServiceInfo[];
  portforwards: PortForwardInfo[];
  terminals: Snapshot["terminals"];
}) {
  if (declaredServices.length === 0 && services.length === 0 && portforwards.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground">
        No services declared in .warpforge.yaml.
      </div>
    );
  }

  if (services.length === 0 && portforwards.length === 0 && terminals.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground">
        No live runtime resources reported.
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-3 py-2 text-xs">
      {services.map((service) => {
        const badge = serviceBadge(service.status);
        return (
          <span
            key={`service:${service.name}`}
            title={service.name}
            className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded border border-border/70 bg-background/30 px-2 py-1"
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                service.status === "running"
                  ? "bg-ok"
                  : service.status === "failed"
                    ? "bg-destructive"
                    : service.status === "starting"
                      ? "bg-warn"
                      : "bg-muted-foreground/60",
              )}
            />
            <span className="max-w-48 truncate">{service.name}</span>
            <span className="text-[10px] text-muted-foreground">{badge.label}</span>
          </span>
        );
      })}
      {portforwards.map((portforward) => {
        const badge = pfBadge(portforward.status);
        return (
          <span
            key={`portforward:${portforward.name}`}
            title={portforward.name}
            className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded border border-border/70 bg-background/30 px-2 py-1"
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                portforward.status === "active"
                  ? "bg-ok"
                  : portforward.status === "failed"
                    ? "bg-destructive"
                    : portforward.status === "starting" || portforward.status === "restarting"
                      ? "bg-warn"
                      : "bg-muted-foreground/60",
              )}
            />
            <span className="max-w-48 truncate">{portforward.name}</span>
            <span className="text-[10px] text-muted-foreground">{badge.label}</span>
          </span>
        );
      })}
      {terminals.length > 0 && (
        <span className="inline-flex items-center gap-1.5 rounded border border-border/70 bg-background/30 px-2 py-1 text-muted-foreground">
          <SquareTerminal className="size-3" />
          {terminals.length} terminal{terminals.length === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}

function TaskSection({
  title,
  description,
  count,
  trees,
  emptyLabel,
  muted = false,
  onOpenTask,
}: {
  title: string;
  description: string;
  count: number;
  trees: TaskTree[];
  emptyLabel?: string;
  muted?: boolean;
  onOpenTask: (id: string) => void;
}) {
  return (
    <Card
      className={cn(
        "overflow-hidden rounded-md border-border/80 bg-card shadow-none",
        muted && "opacity-80",
      )}
    >
      <div className="flex min-h-9 items-center gap-2 border-b border-border/80 px-3 text-[13px] font-medium">
        <span className="text-foreground">{title}</span>
        <span className="text-muted-foreground">{description}</span>
        <span className="tnum ml-auto text-[11px] text-muted-foreground">{count}</span>
      </div>
      <div className="divide-y">
        {trees.length === 0 ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">{emptyLabel}</div>
        ) : (
          trees.map((tree) => <TaskRow key={tree.task.id} tree={tree} onOpenTask={onOpenTask} />)
        )}
      </div>
    </Card>
  );
}

function TaskRow({
  tree,
  onOpenTask,
  depth = 0,
}: {
  tree: TaskTree;
  onOpenTask: (id: string) => void;
  depth?: number;
}) {
  const [open, setOpen] = useState(false);
  const task = tree.task;
  const label = taskLabel(task);
  const hasChildren = tree.children.length > 0;
  const descendants = flattenTaskTree(tree).slice(1);
  const descendantAgents = [...new Set(descendants.map((child) => child.agent))];
  const statusCounts = {
    blocked: descendants.filter(
      (child) => child.status === "blocked" || child.status === "interrupted",
    ).length,
    running: descendants.filter((child) => child.status === "running" || child.status === "queued")
      .length,
    review: descendants.filter(awaitsReview).length,
    done: descendants.filter((child) => child.status === "done").length,
  };

  return (
    <div className={cn(depth > 0 && "ml-4 border-l-2 border-primary/20")}>
      <div className="flex h-11 w-full items-center gap-2 px-3 transition-colors hover:bg-secondary/40">
        {/* No spacer for childless rows: reserving the twisty lane for every
            row left a hole on the left of the majority. */}
        {hasChildren && (
          <button
            type="button"
            className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(event) => {
              event.stopPropagation();
              setOpen((value) => !value);
            }}
            aria-label={open ? "Collapse agents" : "Expand agents"}
            aria-expanded={open}
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        )}
        <button
          type="button"
          onClick={() => onOpenTask(task.id)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          title={label}
        >
          <StatusBadge status={task.status} size="xs" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
            {label}
          </span>
          {/* Worktree rides the title line by basename only. The absolute path
              is the longest string in the row and pushed it onto a second line,
              which is what made row heights ragged. */}
          {task.worktree && (
            <span
              className="flex min-w-0 shrink items-center gap-1 text-[11px] text-muted-foreground"
              title={task.worktree}
            >
              <GitBranch className="size-3 shrink-0 text-primary" />
              <span className="truncate">
                {task.worktree.split("/").filter(Boolean).pop() ?? task.worktree}
              </span>
            </span>
          )}
        </button>
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {hasChildren && (
            <button
              type="button"
              className="flex min-h-7 items-center gap-1 rounded px-1.5 text-[10px] text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(event) => {
                event.stopPropagation();
                setOpen((value) => !value);
              }}
              aria-label={open ? "Collapse agents" : "Expand agents"}
              aria-expanded={open}
            >
              {descendants.length}
              <span className="flex items-center gap-1">
                {statusCounts.blocked > 0 && (
                  <span className="text-destructive">{statusCounts.blocked}b</span>
                )}
                {statusCounts.running > 0 && (
                  <span className="text-ok">{statusCounts.running}r</span>
                )}
                {statusCounts.review > 0 && (
                  <span className="text-warn">{statusCounts.review}w</span>
                )}
                {statusCounts.done > 0 && <span>{statusCounts.done}d</span>}
              </span>
            </button>
          )}
          {task.filesChanged > 0 && (
            <span
              className="tnum shrink-0 text-[11px]"
              title={`${task.filesChanged} changed file${task.filesChanged === 1 ? "" : "s"}`}
            >
              {task.filesChanged}f
            </span>
          )}
          <AgentAvatarGroup
            agentId={task.agent}
            childAgents={hasChildren ? descendantAgents : undefined}
          />
          <span aria-hidden className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground/40" />
          <span className="tnum shrink-0" title={`Updated ${elapsed(task.updatedAt)} ago`}>
            {task.status === "done" ? `${elapsed(task.updatedAt)} ago` : elapsed(task.createdAt)}
          </span>
        </span>
      </div>
      {open && hasChildren && (
        <div>
          {tree.children.map((child) => (
            <TaskRow key={child.task.id} tree={child} onOpenTask={onOpenTask} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
