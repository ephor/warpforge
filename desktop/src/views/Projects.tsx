import {
  ChevronDown,
  ChevronRight,
  Copy,
  FolderGit2,
  Play,
  PlugZap,
  RotateCw,
  Send,
  Share2,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { AgentBadge } from "@/components/AgentBadge";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { elapsed, pfBadge, serviceBadge } from "@/lib/status";
import { taskLabel } from "@/lib/taskLabel";

import { daemon } from "../daemon";
import type { PortForwardInfo, ServiceInfo, Snapshot } from "../protocol";
import AddProjectDialog from "./AddProjectDialog";
import { ProjectList } from "./projects/ProjectList";

interface Props {
  snapshot: Snapshot;
  onOpenTask: (id: string) => void;
  onNewTask: (project?: string, prompt?: string) => void;
  onProjectAdded?: (projectName: string) => void;
}

export default function Projects({ snapshot, onOpenTask, onNewTask, onProjectAdded }: Props) {
  const [selected, setSelected] = useState(snapshot.projects[0]?.name ?? "");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [hoveredProject, setHoveredProject] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  const onRowMouseEnter = useCallback((name: string) => setHoveredProject(name), []);
  const onRowMouseLeave = useCallback(() => setHoveredProject(null), []);

  const project =
    snapshot.projects.find((p) => p.name === selected) ?? snapshot.projects[0] ?? null;
  const projectName = project?.name ?? "";
  const services = useMemo(
    () => snapshot.services.filter((s) => s.project === projectName),
    [snapshot.services, projectName],
  );
  const pfs = useMemo(
    () => snapshot.portforwards.filter((pf) => pf.project === projectName),
    [snapshot.portforwards, projectName],
  );
  const projectTasks = useMemo(
    () => snapshot.tasks.filter((t) => t.project === projectName),
    [snapshot.tasks, projectName],
  );
  const running = useMemo(
    () => services.filter((s) => s.status === "running" && s.allocatedPort > 0),
    [services],
  );
  const runningByProject = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of snapshot.services) {
      if (s.status === "running") {
        map.set(s.project, (map.get(s.project) ?? 0) + 1);
      }
    }
    return map;
  }, [snapshot.services]);

  if (!project) {
    return (
      <div className="mt-16 flex flex-col items-center gap-4 text-center text-muted-foreground">
        <p>
          No projects registered. Run <code className="text-foreground">wf add &lt;path&gt;</code>{" "}
          or add one below.
        </p>
        <Button variant="outline" onClick={() => setShowAddDialog(true)}>
          <FolderGit2 className="mr-1 size-4" />
          Add Project
        </Button>
        <AddProjectDialog
          open={showAddDialog}
          onOpenChange={setShowAddDialog}
          onAdded={onProjectAdded}
        />
      </div>
    );
  }

  return (
    <div className="grid h-full grid-cols-[200px_minmax(0,1fr)] gap-2">
      <ProjectList
        projects={snapshot.projects}
        selected={project.name}
        onSelect={setSelected}
        runningByProject={runningByProject}
        hoveredProject={hoveredProject}
        onRowMouseEnter={onRowMouseEnter}
        onRowMouseLeave={onRowMouseLeave}
        openMenu={openMenu}
        onMenuOpenChange={setOpenMenu}
        onAddProject={() => setShowAddDialog(true)}
      />

      <ScrollArea className="min-h-0">
        <div className="flex flex-col gap-2 pr-2">
          <div className="flex min-h-10 items-center gap-3 px-1">
            <div>
              <h1 className="text-lg font-semibold">{project.name}</h1>
              <p className="text-xs text-muted-foreground">
                {project.path} · ports{" "}
                <span className="tnum">
                  {project.portRange[0]}–{project.portRange[1]}
                </span>
              </p>
            </div>
          </div>

          <Card className="overflow-hidden rounded-md border-border/80 bg-card shadow-none">
            <div className="flex h-9 items-center gap-2 border-b border-border/80 px-3 text-xs font-medium text-muted-foreground">
              <Share2 className="size-3.5 text-primary" />
              Agent context
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

          <Card className="overflow-hidden rounded-md border-border/80 bg-card shadow-none">
            <div className="flex h-9 items-center gap-2 border-b border-border/80 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <span>Services</span>
              {project.declaredServices.length > 0 && (
                <div className="ml-auto">
                  {running.length === project.declaredServices.length ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 border-destructive/20 bg-destructive/5 px-2 text-[10px] font-normal normal-case tracking-normal text-destructive/75 hover:border-destructive/35 hover:bg-destructive/10 hover:text-destructive"
                      onClick={() =>
                        void daemon.request("service.stopAll", { project: project.name })
                      }
                    >
                      <Square className="size-3" />
                      Stop all
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 text-[10px] font-normal normal-case tracking-normal"
                      onClick={() =>
                        void daemon.request("service.startAll", { project: project.name })
                      }
                    >
                      <Play className="size-3" />
                      Start all
                    </Button>
                  )}
                </div>
              )}
            </div>
            <div className="divide-y">
              {project.declaredServices.length === 0 && (
                <div className="px-3 py-4 text-sm text-muted-foreground">
                  No services declared in .warpforge.yaml.
                </div>
              )}
              {project.declaredServices.map((name) => {
                const svc = services.find((s) => s.name === name);
                return (
                  <ServiceRow
                    key={name}
                    project={project.name}
                    name={name}
                    svc={svc}
                    onSendToAgent={(proj, text) => onNewTask(proj, text)}
                  />
                );
              })}
            </div>
          </Card>

          {pfs.length > 0 && (
            <Card className="overflow-hidden rounded-md border-border/80 bg-card shadow-none">
              <div className="flex h-9 items-center gap-2 border-b border-border/80 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <span>Port Forwards</span>
                <div className="ml-auto">
                  {pfs.every((pf) => pf.status === "active") ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 border-destructive/20 bg-destructive/5 px-2 text-[10px] font-normal normal-case tracking-normal text-destructive/75 hover:border-destructive/35 hover:bg-destructive/10 hover:text-destructive"
                      onClick={() =>
                        void daemon.request("portforward.stopAll", { project: project.name })
                      }
                    >
                      <Square className="size-3" />
                      Stop all
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 text-[10px] font-normal normal-case tracking-normal"
                      onClick={() =>
                        void daemon.request("portforward.startAll", { project: project.name })
                      }
                    >
                      <Play className="size-3" />
                      Start all
                    </Button>
                  )}
                </div>
              </div>
              <div className="divide-y">
                {pfs.map((pf) => (
                  <PortForwardRow
                    key={pf.name}
                    project={project.name}
                    pf={pf}
                    onSendToAgent={(proj, text) => onNewTask(proj, text)}
                  />
                ))}
              </div>
            </Card>
          )}

          <Card className="overflow-hidden rounded-md border-border/80 bg-card shadow-none">
            <div className="flex h-9 items-center border-b border-border/80 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Tasks
            </div>
            <div className="divide-y">
              {projectTasks.length === 0 && (
                <div className="px-3 py-4 text-sm text-muted-foreground">No tasks yet.</div>
              )}
              {projectTasks.map((t) => {
                return (
                  <button
                    type="button"
                    key={t.id}
                    onClick={() => onOpenTask(t.id)}
                    className="flex min-h-9 w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-secondary/40"
                  >
                    <StatusBadge status={t.status} />
                    <span className="flex-1 truncate text-sm">{taskLabel(t)}</span>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                      <AgentBadge agentId={t.agent} className="text-muted-foreground" />
                      <span aria-hidden className="h-1 w-1 rounded-full bg-muted-foreground/40" />
                      <span className="tnum">{elapsed(t.createdAt)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </Card>
        </div>
      </ScrollArea>

      <AddProjectDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        onAdded={onProjectAdded}
      />
    </div>
  );
}

const EMPTY_LOGS: string[] = [];

function ServiceRow({
  project,
  name,
  svc,
  onSendToAgent,
}: {
  project: string;
  name: string;
  svc: ServiceInfo | undefined;
  onSendToAgent: (project: string, text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const logs = useSyncExternalStore(
    daemon.subscribe,
    () => daemon.getState().serviceLogs[`${project}/${name}`] ?? EMPTY_LOGS,
  );

  const badge = serviceBadge(svc?.status ?? "stopped");
  const logText = logs.join("\n");
  const canStop = svc?.status === "running" || svc?.status === "starting";
  const canRestart = svc?.status === "running";

  useEffect(() => {
    if (!open) {
      return;
    }
    void daemon.fetchServiceLogs(project, name, { after: 0, limit: 300 });
  }, [open, project, name, svc?.logSeq]);

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-label={`Toggle ${name} service details`}
        aria-expanded={open}
        className="flex min-h-9 cursor-pointer items-center gap-3 px-3 py-1.5 hover:bg-secondary/30"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="w-36 truncate text-sm font-medium" title={name}>
          {name}
        </span>
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <span className="tnum w-16 font-mono text-xs text-primary">
          {svc && svc.allocatedPort > 0 ? `:${svc.allocatedPort}` : ""}
        </span>
        <span className="flex-1 truncate font-mono text-xs text-muted-foreground">
          {svc?.command ?? ""}
        </span>
        <div className="ml-auto flex gap-1" onClick={(e) => e.stopPropagation()}>
          {!canStop && (
            <Button
              variant="outline"
              size="icon"
              className="size-7"
              title={`Start ${name}`}
              aria-label={`Start ${name}`}
              onClick={() => void daemon.request("service.start", { project, service: name })}
            >
              <Play className="size-3" />
            </Button>
          )}
          {canRestart && (
            <Button
              variant="outline"
              size="icon"
              className="size-7"
              title={`Restart ${name}`}
              aria-label={`Restart ${name}`}
              onClick={() => void daemon.request("service.restart", { project, service: name })}
            >
              <RotateCw className="size-3" />
            </Button>
          )}
          {canStop && (
            <Button
              variant="outline"
              size="icon"
              className="size-7 border-destructive/20 bg-destructive/5 text-destructive/75 hover:border-destructive/35 hover:bg-destructive/10 hover:text-destructive"
              title={`Stop ${name}`}
              aria-label={`Stop ${name}`}
              onClick={() => void daemon.request("service.stop", { project, service: name })}
            >
              <Square className="size-3" />
            </Button>
          )}
        </div>
      </div>

      {open && (
        <div className="bg-deep-surface border-t px-3 pb-3 pt-2">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{logs.length} lines</span>
            <button
              type="button"
              className="ml-auto flex items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
              onClick={() => void navigator.clipboard.writeText(logText)}
            >
              <Copy className="size-3" /> copy
            </button>
            <button
              type="button"
              className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
              onClick={() =>
                onSendToAgent(project, `Logs for service "${name}":\n\`\`\`\n${logText}\n\`\`\``)
              }
            >
              <Send className="size-3" /> send to agent
            </button>
          </div>
          <ScrollArea className="h-48">
            <pre className="font-mono text-xs leading-relaxed text-green-400 whitespace-pre-wrap break-all">
              {logs.length === 0 ? "no logs yet" : logText}
            </pre>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}

function PortForwardRow({
  project,
  pf,
  onSendToAgent,
}: {
  project: string;
  pf: PortForwardInfo;
  onSendToAgent: (project: string, text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const logs = useSyncExternalStore(
    daemon.subscribe,
    () => daemon.getState().portforwardLogs[`${project}/${pf.name}`] ?? EMPTY_LOGS,
  );

  const badge = pfBadge(pf.status);
  const logText = logs.join("\n");
  const active = pf.status === "active";

  useEffect(() => {
    if (!open) {
      return;
    }
    void daemon.fetchPortForwardLogs(project, pf.name, { after: 0, limit: 300 });
  }, [open, project, pf.name, pf.logSeq]);

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-label={`Toggle ${pf.name} port-forward details`}
        aria-expanded={open}
        className="flex min-h-9 cursor-pointer items-center gap-3 px-3 py-1.5 hover:bg-secondary/30"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <PlugZap className="size-4 text-muted-foreground" />
        <span className="w-36 truncate text-sm font-medium" title={pf.name}>
          {pf.name}
        </span>
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <span className="tnum font-mono text-xs text-primary">
          :{pf.localPort} → {pf.remotePort}
        </span>
        <span className="flex-1 truncate font-mono text-xs text-muted-foreground">
          {pf.namespace}/{pf.pod}
        </span>
        <div className="ml-auto flex gap-1" onClick={(e) => e.stopPropagation()}>
          {!active && (
            <Button
              variant="outline"
              size="icon"
              className="size-7"
              title={`Start ${pf.name}`}
              aria-label={`Start ${pf.name}`}
              onClick={() =>
                void daemon.request("portforward.start", {
                  name: pf.name,
                  project: project,
                })
              }
            >
              <Play className="size-3" />
            </Button>
          )}
          {active && (
            <Button
              variant="outline"
              size="icon"
              className="size-7 border-destructive/20 bg-destructive/5 text-destructive/75 hover:border-destructive/35 hover:bg-destructive/10 hover:text-destructive"
              title={`Stop ${pf.name}`}
              aria-label={`Stop ${pf.name}`}
              onClick={() =>
                void daemon.request("portforward.stop", {
                  name: pf.name,
                  project: project,
                })
              }
            >
              <Square className="size-3" />
            </Button>
          )}
        </div>
      </div>

      {open && (
        <div className="bg-deep-surface border-t px-3 pb-3 pt-2">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{logs.length} lines</span>
            <button
              type="button"
              className="ml-auto flex items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
              onClick={() => void navigator.clipboard.writeText(logText)}
            >
              <Copy className="size-3" /> copy
            </button>
            <button
              type="button"
              className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
              onClick={() =>
                onSendToAgent(
                  project,
                  `Logs for port-forward "${pf.name}":\n\`\`\`\n${logText}\n\`\`\``,
                )
              }
            >
              <Send className="size-3" /> send to agent
            </button>
          </div>
          <ScrollArea className="h-48">
            <pre className="font-mono text-xs leading-relaxed text-green-400 whitespace-pre-wrap break-all">
              {logs.length === 0 ? "no logs yet" : logText}
            </pre>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
