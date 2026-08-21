import { Play, Square } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { RuntimePanel } from "@/components/RuntimePanel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { daemon } from "../../daemon";
import type { PortForwardInfo, ServiceInfo, Snapshot } from "../../protocol";

export interface ProjectRuntimeSurfaceProps {
  project: string;
  /** Declared services included, so a project that has never run still lists them. */
  services: ServiceInfo[];
  portforwards: PortForwardInfo[];
  terminals: Snapshot["terminals"];
  declaredServices: string[];
  onAppendToChat?: (formattedLogs: string) => void;
}

/**
 * Runtime surface: the full-height services/terminals panel with the
 * start-everything controls and the live URL strip above it. The URLs are the
 * part agents care about — a task started while these are up knows the app is
 * running and on which ports.
 */
export function ProjectRuntimeSurface({
  project,
  services,
  portforwards,
  terminals,
  declaredServices,
  onAppendToChat,
}: ProjectRuntimeSurfaceProps) {
  const [actionError, setActionError] = useState<string | null>(null);

  const running = useMemo(
    () => services.filter((s) => s.status === "running" && s.allocatedPort > 0),
    [services],
  );
  const allServicesRunning =
    declaredServices.length > 0 &&
    declaredServices.every(
      (name) => services.find((service) => service.name === name)?.status === "running",
    );
  const allForwardsActive =
    portforwards.length > 0 && portforwards.every((forward) => forward.status === "active");

  const runRuntimeAction = useCallback(async (method: string, params: Record<string, string>) => {
    setActionError(null);
    try {
      await daemon.request(method, params);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 px-3 py-1">
        <span className="text-[11px] text-muted-foreground">
          {runtimeResourceSummary(services, portforwards, terminals)}
        </span>
        {actionError && (
          <span
            role="alert"
            className="max-w-48 truncate text-[11px] text-destructive"
            title={actionError}
          >
            {actionError}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {declaredServices.length > 0 && (
            <RuntimeBulkButton
              active={allServicesRunning}
              label={allServicesRunning ? "Stop all services" : "Start all services"}
              text={allServicesRunning ? "Stop services" : "Start services"}
              onClick={() =>
                void runRuntimeAction(
                  allServicesRunning ? "service.stopAll" : "service.startAll",
                  { project },
                )
              }
            />
          )}
          {portforwards.length > 0 && (
            <RuntimeBulkButton
              active={allForwardsActive}
              label={allForwardsActive ? "Stop all port-forwards" : "Start all port-forwards"}
              text={allForwardsActive ? "Stop forwards" : "Start forwards"}
              onClick={() =>
                void runRuntimeAction(
                  allForwardsActive ? "portforward.stopAll" : "portforward.startAll",
                  { project },
                )
              }
            />
          )}
        </div>
      </div>

      {running.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 px-3 pb-2 font-mono text-xs">
          {running.map((service) => (
            <span key={service.name} className="flex gap-2">
              <span className="text-muted-foreground">{service.name}</span>
              <span className="tnum text-primary">http://localhost:{service.allocatedPort}</span>
            </span>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 border-t border-border/70">
        <RuntimePanel
          key={project}
          project={project}
          services={services}
          portforwards={portforwards}
          initialTab={terminals.length > 0 ? "terminal" : "services"}
          onAppendToChat={onAppendToChat}
        />
      </div>
    </div>
  );
}

function RuntimeBulkButton({
  active,
  label,
  text,
  onClick,
}: {
  active: boolean;
  label: string;
  text: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "h-7 gap-1.5 px-2 text-xs",
        active &&
          "border-destructive/20 bg-destructive/5 text-destructive/75 hover:border-destructive/35 hover:bg-destructive/10 hover:text-destructive",
      )}
    >
      {active ? <Square className="size-3" /> : <Play className="size-3" />}
      {text}
    </Button>
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
