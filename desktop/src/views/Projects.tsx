import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  EllipsisVertical,
  FolderGit2,
  Pencil,
  Play,
  Share2,
  Square,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { RuntimePanel } from "@/components/RuntimePanel";
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
import { pfBadge, serviceBadge } from "@/lib/status";
import { disposeTerminalWorkspace } from "@/lib/terminalWorkspace";
import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";

import { BacklogView } from "../components/backlog/BacklogView";
import { NewWorkItemDrawer } from "../components/backlog/NewWorkItemDrawer";
import { daemon } from "../daemon";
import type { PortForwardInfo, ServiceInfo, Snapshot } from "../protocol";
import { type ProjectLiveCounts, RemoveProjectDialog } from "./projects/RemoveProjectDialog";

interface Props {
  snapshot: Snapshot;
  onOpenTask: (id: string) => void;
  onNewTask: (project?: string, prompt?: string, backlogItemId?: string) => void;
  onAddProject?: () => void;
}

export default function Projects({ snapshot, onOpenTask, onNewTask, onAddProject }: Props) {
  const selectedProjectId = useUi((state) => state.selectedProjectId);
  const openProject = useUi((state) => state.openProject);
  const [removeProject, setRemoveProject] = useState<string | null>(null);
  const [runtimeActionError, setRuntimeActionError] = useState<{
    project: string;
    message: string;
  } | null>(null);
  const [backlogOpen, setBacklogOpen] = useState(false);

  const project =
    snapshot.projects.find((p) => p.name === selectedProjectId) ?? snapshot.projects[0] ?? null;
  const projectName = project?.name ?? "";
  const backlogCount = useQuery({
    enabled: projectName.length > 0,
    queryKey: ["backlog", projectName, "count"],
    queryFn: () =>
      daemon.listBacklog({
        project: projectName,
        page: 0,
        pageSize: 1,
        sortBy: "updatedAt",
        sortDesc: true,
      }),
  });

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
    const missingDeclaredServices = declaredServices.flatMap((name): ServiceInfo[] =>
      knownNames.has(name)
        ? []
        : [
            {
              allocatedPort: 0,
              command: "",
              logSeq: 0,
              name,
              originalPort: 0,
              project: projectName,
              status: "stopped",
            },
          ],
    );
    return [...services, ...missingDeclaredServices];
  }, [declaredServices, projectName, services]);
  const pfs = useMemo(
    () => snapshot.portforwards.filter((pf) => pf.project === projectName),
    [snapshot.portforwards, projectName],
  );
  const projectTerminals = useMemo(
    () => snapshot.terminals.filter((terminal) => terminal.project === projectName),
    [snapshot.terminals, projectName],
  );
  const running = useMemo(
    () => services.filter((s) => s.status === "running" && s.allocatedPort > 0),
    [services],
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

  const runRuntimeAction = useCallback(
    async (method: string, params: Record<string, string>) => {
      setRuntimeActionError(null);
      try {
        await daemon.request(method, params);
      } catch (reason) {
        setRuntimeActionError({
          project: projectName,
          message: reason instanceof Error ? reason.message : String(reason),
        });
      }
    },
    [projectName],
  );

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
                {backlogCount.data?.total ?? 0} items
              </Badge>
            </div>
            <p className="truncate text-xs text-muted-foreground" title={project.path}>
              {project.path} · ports{" "}
              <span className="tnum">
                {project.portRange[0]}–{project.portRange[1]}
              </span>
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
              aria-label={`New work item in ${project.name}`}
              onClick={() => setBacklogOpen(true)}
              className="h-8 gap-1.5 px-2.5"
            >
              + New work item
            </Button>
          </div>
        </header>

        <Card className="overflow-hidden rounded-md border-border/80 bg-card shadow-none">
          <div className="flex min-h-9 items-center gap-2 px-3">
            <span className="text-[13px] font-medium text-foreground">Backlog</span>
            <span className="text-[11px] text-muted-foreground">
              Future work, tracked where it lives
            </span>
            <span className="tnum ml-auto text-[11px] text-muted-foreground">
              {backlogCount.data?.total ?? 0} items
            </span>
          </div>
          <BacklogView
            key={project.name}
            project={project.name}
            onOpenTask={onOpenTask}
            onStartTask={(item) =>
              onNewTask(project.name, [item.title, item.body].filter(Boolean).join("\n\n"), item.id)
            }
          />
        </Card>

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
                Nothing running yet. Start services and new tasks will know the app is up, on which
                ports, and can run tests against it.
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
            {runtimeActionError?.project === projectName && (
              <span
                role="alert"
                className="max-w-48 truncate text-[11px] text-destructive"
                title={runtimeActionError.message}
              >
                {runtimeActionError.message}
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

      <NewWorkItemDrawer open={backlogOpen} onOpenChange={setBacklogOpen} project={project.name} />
    </ScrollArea>
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
