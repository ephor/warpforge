import { useState } from "react";
import {
  Plus,
  Play,
  Square,
  RotateCw,
  PlugZap,
  Radio,
  FolderGit2,
  Share2,
} from "lucide-react";
import { daemon } from "../daemon";
import { ServiceInfo, Snapshot } from "../protocol";
import { serviceBadge, pfBadge, taskBadge, elapsed } from "@/lib/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

interface Props {
  snapshot: Snapshot;
  onOpenTask: (id: string) => void;
  onNewTask: (project?: string) => void;
}

/**
 * Projects — per-project drilldown, not just an infra table. Crucially, the
 * running services are framed as *agent context*: the block a new task from
 * this project inherits, so the agent knows the app is already up on real
 * ports and can hit endpoints / run tests. This is what stops Projects being
 * a fifth wheel (see UI_CONCEPT.md).
 */
export default function Projects({ snapshot, onOpenTask, onNewTask }: Props) {
  const [selected, setSelected] = useState(snapshot.projects[0]?.name ?? "");

  if (snapshot.projects.length === 0) {
    return (
      <div className="mt-16 text-center text-muted-foreground">
        No projects registered. Run <code className="text-foreground">wf add &lt;path&gt;</code> —
        the list updates live.
      </div>
    );
  }

  const project = snapshot.projects.find((p) => p.name === selected) ?? snapshot.projects[0];
  const services = snapshot.services.filter((s) => s.project === project.name);
  const pfs = snapshot.portforwards.filter((pf) => pf.project === project.name);
  const projectTasks = snapshot.tasks.filter((t) => t.project === project.name);
  const running = services.filter((s) => s.status === "running" && s.allocatedPort > 0);

  return (
    <div className="grid h-full grid-cols-[220px_1fr] gap-4">
      {/* Project list */}
      <Card className="flex min-h-0 flex-col">
        <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Projects
        </div>
        <Separator />
        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-1 p-2">
            {snapshot.projects.map((p) => {
              const active = p.name === project.name;
              const up = snapshot.services.filter(
                (s) => s.project === p.name && s.status === "running",
              ).length;
              return (
                <button
                  key={p.name}
                  onClick={() => setSelected(p.name)}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                    active ? "bg-secondary" : "hover:bg-secondary/50",
                  )}
                >
                  <FolderGit2 className="size-4 text-muted-foreground" />
                  <span className="flex-1 truncate">{p.name}</span>
                  {up > 0 && (
                    <span className="tnum flex items-center gap-1 text-xs text-ok">
                      <Radio className="size-3" />
                      {up}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </Card>

      {/* Detail */}
      <ScrollArea className="min-h-0">
        <div className="flex flex-col gap-4 pr-3">
          <div className="flex items-center gap-3">
            <div>
              <h1 className="text-lg font-semibold">{project.name}</h1>
              <p className="text-xs text-muted-foreground">
                {project.path} · ports{" "}
                <span className="tnum">
                  {project.portRange[0]}–{project.portRange[1]}
                </span>
              </p>
            </div>
            <div className="ml-auto flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void daemon.request("service.startAll", { project: project.name })}
              >
                <Play className="size-4" />
                start all
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void daemon.request("service.stopAll", { project: project.name })}
              >
                <Square className="size-4" />
                stop all
              </Button>
              <Button size="sm" onClick={() => onNewTask(project.name)}>
                <Plus className="size-4" />
                New task here
              </Button>
            </div>
          </div>

          {/* Agent context — the integration that ties infra to tasks */}
          <Card className="border-primary/30 bg-primary/5 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-primary">
              <Share2 className="size-4" />
              Shared with new agent sessions
            </div>
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
          </Card>

          {/* Services */}
          <Card>
            <div className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Services
            </div>
            <div className="divide-y">
              {project.declaredServices.length === 0 && (
                <div className="px-3 py-4 text-sm text-muted-foreground">
                  No services declared in .workspace.yaml.
                </div>
              )}
              {project.declaredServices.map((name) => {
                const svc = services.find((s) => s.name === name);
                return <ServiceRow key={name} project={project.name} name={name} svc={svc} />;
              })}
              {pfs.map((pf) => {
                const badge = pfBadge(pf.status);
                return (
                  <div key={pf.name} className="flex items-center gap-3 px-3 py-2">
                    <PlugZap className="size-4 text-muted-foreground" />
                    <span className="w-40 truncate text-sm font-medium">{pf.name}</span>
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                    <span className="tnum font-mono text-xs text-primary">
                      :{pf.localPort} → {pf.remotePort}
                    </span>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {pf.namespace}/{pf.pod}
                    </span>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="ml-auto"
                      onClick={() =>
                        void daemon.request("portforward.stop", {
                          project: project.name,
                          name: pf.name,
                        })
                      }
                    >
                      stop
                    </Button>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Tasks in this project */}
          <Card>
            <div className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Tasks
            </div>
            <div className="divide-y">
              {projectTasks.length === 0 && (
                <div className="px-3 py-4 text-sm text-muted-foreground">No tasks yet.</div>
              )}
              {projectTasks.map((t) => {
                const badge = taskBadge(t.status);
                return (
                  <button
                    key={t.id}
                    onClick={() => onOpenTask(t.id)}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-secondary/40"
                  >
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                    <span className="flex-1 truncate text-sm">{t.prompt}</span>
                    <span className="text-xs text-muted-foreground">{t.agent}</span>
                    <span className="tnum text-xs text-muted-foreground">
                      {elapsed(t.createdAt)}
                    </span>
                  </button>
                );
              })}
            </div>
          </Card>
        </div>
      </ScrollArea>
    </div>
  );
}

function ServiceRow({
  project,
  name,
  svc,
}: {
  project: string;
  name: string;
  svc: ServiceInfo | undefined;
}) {
  const badge = serviceBadge(svc?.status ?? "stopped");
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <span className="w-40 truncate text-sm font-medium">{name}</span>
      <Badge variant={badge.variant}>{badge.label}</Badge>
      <span className="tnum w-16 font-mono text-xs text-primary">
        {svc && svc.allocatedPort > 0 ? `:${svc.allocatedPort}` : ""}
      </span>
      <span className="flex-1 truncate font-mono text-xs text-muted-foreground">
        {svc?.command ?? ""}
      </span>
      <div className="ml-auto flex gap-1">
        <Button
          variant="outline"
          size="sm"
          className="h-7"
          onClick={() => void daemon.request("service.restart", { project, service: name })}
        >
          <RotateCw className="size-3" />
        </Button>
        <Button
          variant="destructive"
          size="sm"
          className="h-7"
          onClick={() => void daemon.request("service.stop", { project, service: name })}
        >
          <Square className="size-3" />
        </Button>
      </div>
    </div>
  );
}
