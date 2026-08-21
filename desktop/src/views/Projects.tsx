import { useQuery } from "@tanstack/react-query";
import { EllipsisVertical, FolderGit2, Pencil, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SurfaceTab } from "@/components/workspace";
import { disposeTerminalWorkspace } from "@/lib/terminalWorkspace";
import { DEFAULT_PROJECT_SURFACE, type ProjectSurface, useUi } from "@/store/ui";

import { BacklogView } from "../components/backlog/BacklogView";
import { NewWorkItemDrawer } from "../components/backlog/NewWorkItemDrawer";
import type { WorkItem } from "../components/backlog/types";
import { WorkItemDrawer } from "../components/backlog/WorkItemDrawer";
import { daemon } from "../daemon";
import type { ServiceInfo, Snapshot } from "../protocol";
import { ProjectFilesSurface } from "./projects/ProjectFilesSurface";
import { ProjectRuntimeSurface } from "./projects/ProjectRuntimeSurface";
import { PROJECT_SURFACE_TABS, ProjectSurfaceBar } from "./projects/ProjectSurfaceBar";
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
  const [backlogOpen, setBacklogOpen] = useState(false);
  const [openItem, setOpenItem] = useState<WorkItem | null>(null);

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
  const surface = useUi(
    (state) => state.projectSurfaceByProject[projectName] ?? DEFAULT_PROJECT_SURFACE,
  );
  const setProjectSurface = useUi((state) => state.setProjectSurface);
  const clearProjectSurface = useUi((state) => state.clearProjectSurface);
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
  const surfaceTabs = useMemo<readonly SurfaceTab<ProjectSurface>[]>(() => {
    const runtimeCount = runtimeServices.length + pfs.length + projectTerminals.length || undefined;
    return PROJECT_SURFACE_TABS.map((tab) =>
      tab.id === "runtime" ? { ...tab, count: runtimeCount } : tab,
    );
  }, [pfs.length, projectTerminals.length, runtimeServices.length]);
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

  const linkedTask = useMemo(
    () => snapshot.tasks.find((task) => task.id === openItem?.taskId) ?? null,
    [openItem?.taskId, snapshot.tasks],
  );

  const startTaskFromItem = useCallback(
    (item: WorkItem) => {
      setOpenItem(null);
      onNewTask(item.project, [item.title, item.body].filter(Boolean).join("\n\n"), item.id);
    },
    [onNewTask],
  );

  const openTaskFromItem = useCallback(
    (taskId: string) => {
      setOpenItem(null);
      onOpenTask(taskId);
    },
    [onOpenTask],
  );

  const confirmProjectRemoval = useCallback(async () => {
    if (!removeProject) return;
    const remainingProjects = snapshot.projects.filter((item) => item.name !== removeProject);
    await daemon.removeProject(removeProject, true);
    disposeTerminalWorkspace(removeProject);
    clearRuntimeOpen(removeProject);
    clearProjectSurface(removeProject);
    setRemoveProject(null);
    if (selectedProjectId === removeProject) {
      openProject(remainingProjects[0]?.name ?? "");
    }
  }, [
    clearProjectSurface,
    clearRuntimeOpen,
    openProject,
    removeProject,
    selectedProjectId,
    snapshot.projects,
  ]);

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
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-1">
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
            size="sm"
            aria-label={`New work item in ${project.name}`}
            onClick={() => setBacklogOpen(true)}
            className="h-8 gap-1.5 px-2.5"
          >
            + New work item
          </Button>
        </div>
      </header>

      <ProjectSurfaceBar
        activeSurface={surface}
        onSurfaceChange={(next) => setProjectSurface(project.name, next)}
        tabs={surfaceTabs}
      />

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {surface === "files" ? (
          <ProjectFilesSurface project={project.name} rootPath={project.path} />
        ) : surface === "runtime" ? (
          <ProjectRuntimeSurface
            project={project.name}
            services={runtimeServices}
            portforwards={pfs}
            terminals={projectTerminals}
            declaredServices={project.declaredServices}
            onAppendToChat={(formattedLogs) => onNewTask(project.name, formattedLogs)}
          />
        ) : (
          <div className="h-full">
            <BacklogView
              key={project.name}
              project={project.name}
              onOpenTask={onOpenTask}
              onOpenItem={setOpenItem}
              onStartTask={startTaskFromItem}
            />
          </div>
        )}
      </div>

      <RemoveProjectDialog
        project={removeProject}
        liveCounts={removeLiveCounts}
        onCancel={() => setRemoveProject(null)}
        onConfirm={confirmProjectRemoval}
      />

      <NewWorkItemDrawer open={backlogOpen} onOpenChange={setBacklogOpen} project={project.name} />

      <WorkItemDrawer
        item={openItem}
        linkedTask={linkedTask}
        onClose={() => setOpenItem(null)}
        onStartTask={startTaskFromItem}
        onOpenTask={openTaskFromItem}
      />
    </div>
  );
}
