import { Loader2, Play, PlugZap, RotateCw, Square } from "lucide-react";
import { memo } from "react";

import { Button } from "@/components/ui/button";
import { pfBadge, serviceBadge } from "@/lib/status";
import { cn } from "@/lib/utils";

import { daemon } from "../../daemon";
import type { PortForwardInfo, ServiceInfo } from "../../protocol";
import { SIDEBAR_WIDTH } from "./constants";
import { StatusDot } from "./StatusDot";

function safeRequest(method: string, params: unknown, onError: (msg: string) => void) {
  daemon.request(method, params).catch((e: unknown) => {
    onError(e instanceof Error ? e.message : String(e));
  });
}

export function PortForwardSectionHeader({
  project,
  portforwards,
  onError,
}: {
  project: string;
  portforwards: PortForwardInfo[];
  onError: (msg: string) => void;
}) {
  const hasStartable = portforwards.some((pf) => pf.status === "stopped" || pf.status === "failed");
  const allActive = portforwards.every((pf) => pf.status === "active");
  const hasStarting = portforwards.some(
    (pf) => pf.status === "starting" || pf.status === "restarting",
  );
  const startAllDisabled = !hasStartable || hasStarting || allActive;

  return (
    <div className="sticky top-0 z-10 flex items-center bg-card px-3 py-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        Port Forwards
      </span>
      {!allActive && (
        <button
          type="button"
          disabled={startAllDisabled}
          className="ml-auto rounded p-px text-muted-foreground/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={
            hasStarting
              ? "Port-forwards starting…"
              : hasStartable
                ? "Start all port-forwards"
                : "No startable port-forwards"
          }
          aria-label="Start all port-forwards"
          onClick={() => safeRequest("portforward.startAll", { project }, onError)}
        >
          <Play className="size-3" />
        </button>
      )}
    </div>
  );
}

const ServiceRow = memo(function ServiceRow({
  project,
  service,
  selected,
  onSelect,
  onError,
}: {
  project: string;
  service: ServiceInfo;
  selected: boolean;
  onSelect: () => void;
  onError: (msg: string) => void;
}) {
  const badge = serviceBadge(service.status);
  const canStop = service.status === "running" || service.status === "starting";
  const canRestart = service.status === "running";

  return (
    <div
      className={cn(
        "flex w-full items-center gap-1.5 px-2 py-1 text-xs",
        selected ? "bg-secondary text-foreground" : "text-muted-foreground",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 rounded-sm py-0.5 text-left transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          selected
            ? "text-foreground"
            : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
        )}
        aria-label={`Select ${service.name}, ${badge.label}`}
        aria-pressed={selected}
        title={service.name}
      >
        <StatusDot variant={badge.variant} />
        <span className="min-w-0 flex-1 truncate font-medium">{service.name}</span>
        <span className="sr-only">{badge.label}</span>
      </button>
      <div className="flex shrink-0 items-center gap-px">
        {!canStop && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-5"
            title={`Start ${service.name}`}
            aria-label={`Start ${service.name}`}
            onClick={() =>
              safeRequest("service.start", { project, service: service.name }, onError)
            }
          >
            <Play className="size-3" />
          </Button>
        )}
        {canRestart && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-5"
            title={`Restart ${service.name}`}
            aria-label={`Restart ${service.name}`}
            onClick={() =>
              safeRequest("service.restart", { project, service: service.name }, onError)
            }
          >
            <RotateCw className="size-3" />
          </Button>
        )}
        {canStop && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-5 border-destructive/20 bg-destructive/5 text-destructive/75 hover:border-destructive/35 hover:bg-destructive/10 hover:text-destructive"
            title={`Stop ${service.name}`}
            aria-label={`Stop ${service.name}`}
            onClick={() => safeRequest("service.stop", { project, service: service.name }, onError)}
          >
            <Square className="size-3" />
          </Button>
        )}
      </div>
    </div>
  );
});

const PortForwardRow = memo(function PortForwardRow({
  project,
  pf,
  selected,
  onSelect,
  onError,
}: {
  project: string;
  pf: PortForwardInfo;
  selected: boolean;
  onSelect: () => void;
  onError: (msg: string) => void;
}) {
  const badge = pfBadge(pf.status);
  const isStarting = pf.status === "starting" || pf.status === "restarting";
  const isActive = pf.status === "active";
  const isStopped = pf.status === "stopped" || pf.status === "failed";

  return (
    <div
      className={cn(
        "flex w-full items-center gap-1.5 px-2 py-1 text-xs",
        selected ? "bg-secondary text-foreground" : "text-muted-foreground",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 rounded-sm py-0.5 text-left transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          selected
            ? "text-foreground"
            : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
        )}
        aria-label={`Select ${pf.name}, ${badge.label}`}
        aria-pressed={selected}
        title={pf.name}
      >
        <PlugZap className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium">{pf.name}</span>
        <span className="sr-only">{badge.label}</span>
      </button>
      <div className="flex shrink-0 items-center gap-px">
        {isStarting && (
          <span
            className="flex size-5 items-center justify-center text-muted-foreground"
            aria-label={`${pf.name} is ${pf.status}`}
            title={`${pf.name} is ${pf.status}`}
          >
            <Loader2 className="size-3 animate-spin" />
          </span>
        )}
        {isStopped && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-5"
            title={`Start ${pf.name}`}
            aria-label={`Start ${pf.name}`}
            onClick={() => safeRequest("portforward.start", { project, name: pf.name }, onError)}
          >
            <Play className="size-3" />
          </Button>
        )}
        {isActive && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-5 border-destructive/20 bg-destructive/5 text-destructive/75 hover:border-destructive/35 hover:bg-destructive/10 hover:text-destructive"
            title={`Stop ${pf.name}`}
            aria-label={`Stop ${pf.name}`}
            onClick={() => safeRequest("portforward.stop", { project, name: pf.name }, onError)}
          >
            <Square className="size-3" />
          </Button>
        )}
      </div>
    </div>
  );
});

export function RuntimeSidebar({
  project,
  services,
  portforwards,
  selectedKey,
  onSelect,
  onError,
}: {
  project: string;
  services: ServiceInfo[];
  portforwards: PortForwardInfo[];
  selectedKey: string | null;
  onSelect: (item: { kind: "service" | "portforward"; name: string }) => void;
  onError: (msg: string) => void;
}) {
  return (
    <div
      className="shrink-0 self-stretch overflow-y-auto border-l"
      style={{ width: SIDEBAR_WIDTH, minWidth: SIDEBAR_WIDTH }}
    >
      <div className="flex h-11 shrink-0 items-center border-b px-3 text-sm font-semibold">
        Services
      </div>
      {services.length > 0 && (
        <div className="flex flex-col">
          {services.map((svc) => (
            <ServiceRow
              key={svc.name}
              project={project}
              service={svc}
              selected={`service:${svc.name}` === selectedKey}
              onSelect={() => onSelect({ kind: "service", name: svc.name })}
              onError={onError}
            />
          ))}
        </div>
      )}
      {portforwards.length > 0 && (
        <div className="flex flex-col">
          <PortForwardSectionHeader
            project={project}
            portforwards={portforwards}
            onError={onError}
          />
          {portforwards.map((pf) => (
            <PortForwardRow
              key={pf.name}
              project={project}
              pf={pf}
              selected={`portforward:${pf.name}` === selectedKey}
              onSelect={() => onSelect({ kind: "portforward", name: pf.name })}
              onError={onError}
            />
          ))}
        </div>
      )}
    </div>
  );
}
