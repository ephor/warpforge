import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Play, PlugZap, RefreshCw, RotateCw, Server, Square, TerminalSquare } from "lucide-react";
import { daemon } from "../daemon";
import { PortForwardInfo, ServiceInfo } from "../protocol";
import { pfBadge, serviceBadge } from "@/lib/status";
import { cn } from "@/lib/utils";

type RuntimeTab =
  | { kind: "service"; name: string }
  | { kind: "portforward"; name: string };

const EMPTY_LOGS: string[] = [];

export function RuntimePanel({
  project,
  services,
  portforwards,
}: {
  project: string;
  services: ServiceInfo[];
  portforwards: PortForwardInfo[];
}) {
  const tabs = useMemo<RuntimeTab[]>(
    () => [
      ...services.map((s) => ({ kind: "service" as const, name: s.name })),
      ...portforwards.map((p) => ({ kind: "portforward" as const, name: p.name })),
    ],
    [services, portforwards],
  );
  const [active, setActive] = useState<RuntimeTab | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const activeService =
    active?.kind === "service" ? services.find((s) => s.name === active.name) : null;
  const activeServiceName = activeService?.name ?? null;
  const activePortForward =
    active?.kind === "portforward" ? portforwards.find((p) => p.name === active.name) : null;
  const liveLogs = useSyncExternalStore(
    daemon.subscribe,
    () =>
      activeService
        ? (daemon.getState().serviceLogs[`${project}/${activeService.name}`] ?? [])
        : EMPTY_LOGS,
  );
  const displayLogs = activeService && liveLogs.length > 0 ? liveLogs : logs;

  useEffect(() => {
    if (!active && tabs.length > 0) {
      setActive(tabs[0]);
      return;
    }
    if (active && !tabs.some((t) => t.kind === active.kind && t.name === active.name)) {
      setActive(tabs[0] ?? null);
    }
  }, [active, tabs]);

  const fetchLogs = useCallback(() => {
    if (!activeServiceName) {
      setLogs([]);
      setError(null);
      return;
    }
    setError(null);
    daemon
      .fetchServiceLogs(project, activeServiceName, { after: 0, limit: 300 })
      .then(setLogs)
      .catch((e: Error) => setError(e.message));
  }, [activeServiceName, project]);

  useEffect(fetchLogs, [fetchLogs, activeService?.logSeq]);

  if (tabs.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-[#0b0d0f] font-mono text-xs">
        <div className="flex h-9 items-center gap-2 border-b px-3 text-muted-foreground">
          <TerminalSquare className="size-3.5" />
          runtime
        </div>
        <div className="flex flex-1 items-center px-3 text-muted-foreground">
          No services or port-forwards for this project.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0b0d0f] font-mono text-xs text-[#d1d5db]">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/80 bg-card/70 px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {services.map((service) => (
            <RuntimeTabButton
              key={`service:${service.name}`}
              active={active?.kind === "service" && active.name === service.name}
              icon={<Server className="size-3.5" />}
              label={service.name}
              status={serviceBadge(service.status).label}
              onClick={() => setActive({ kind: "service", name: service.name })}
            />
          ))}
          {portforwards.map((pf) => (
            <RuntimeTabButton
              key={`pf:${pf.name}`}
              active={active?.kind === "portforward" && active.name === pf.name}
              icon={<PlugZap className="size-3.5" />}
              label={pf.name}
              status={pfBadge(pf.status).label}
              onClick={() => setActive({ kind: "portforward", name: pf.name })}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={fetchLogs}
          disabled={!activeService}
          className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40"
          title="Refresh logs"
          aria-label="Refresh logs"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>

      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border/60 bg-background/40 px-3 text-[11px] text-muted-foreground">
        {activeService ? (
          <>
            <span className={statusDot(serviceBadge(activeService.status).variant)} />
            <span>{activeService.status}</span>
            <span className="text-border">|</span>
            <span className="min-w-0 flex-1 truncate">{activeService.command}</span>
            {activeService.allocatedPort > 0 && (
              <span className="shrink-0 text-primary">:{activeService.allocatedPort}</span>
            )}
            <ServiceRuntimeControls project={project} service={activeService} />
          </>
        ) : activePortForward ? (
          <>
            <span className={statusDot(pfBadge(activePortForward.status).variant)} />
            <span>{activePortForward.status}</span>
            <span className="text-border">|</span>
            <span className="truncate">
              {activePortForward.namespace}/{activePortForward.pod}
            </span>
            <span className="ml-auto shrink-0 text-primary">
              :{activePortForward.localPort} -&gt; {activePortForward.remotePort}
            </span>
          </>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-2 leading-relaxed">
        {activeService ? (
          error ? (
            <pre className="whitespace-pre-wrap text-destructive">{error}</pre>
          ) : displayLogs.length === 0 ? (
            <pre className="text-muted-foreground">[{activeService.name}] no logs yet</pre>
          ) : (
            displayLogs.map((line, i) => (
              <pre key={`${i}:${line}`} className="whitespace-pre-wrap break-words">
                <span className="select-none text-muted-foreground">$ </span>
                {line}
              </pre>
            ))
          )
        ) : activePortForward ? (
          <pre className="whitespace-pre-wrap text-muted-foreground">
            {`$ port-forward ${activePortForward.name}
status: ${activePortForward.status}
target: ${activePortForward.namespace}/${activePortForward.pod}
local:  :${activePortForward.localPort}
remote: :${activePortForward.remotePort}

Port-forward logs will appear here when daemon streaming is wired to this panel.`}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

function ServiceRuntimeControls({
  project,
  service,
}: {
  project: string;
  service: ServiceInfo;
}) {
  const canStop = service.status === "running" || service.status === "starting";
  const canRestart = service.status === "running" || service.status === "starting";
  const action = canRestart ? "service.restart" : "service.start";
  const label = canRestart ? `Restart ${service.name}` : `Start ${service.name}`;

  return (
    <div className="ml-1 flex shrink-0 items-center gap-1">
      <button
        type="button"
        title={label}
        aria-label={label}
        onClick={() => void daemon.request(action, { project, service: service.name })}
        className="rounded border border-border/80 p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
      >
        {canRestart ? <RotateCw className="size-3.5" /> : <Play className="size-3.5" />}
      </button>
      <button
        type="button"
        title={`Stop ${service.name}`}
        aria-label={`Stop ${service.name}`}
        disabled={!canStop}
        onClick={() => void daemon.request("service.stop", { project, service: service.name })}
        className="rounded border border-destructive/40 p-1 text-destructive hover:bg-destructive/15 disabled:border-border/60 disabled:text-muted-foreground disabled:opacity-40"
      >
        <Square className="size-3.5" />
      </button>
    </div>
  );
}

function RuntimeTabButton({
  active,
  icon,
  label,
  status,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  status: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-7 max-w-[220px] shrink-0 items-center gap-1.5 rounded-md border px-2 text-left",
        active
          ? "border-border bg-secondary text-foreground"
          : "border-transparent text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
      <span className="shrink-0 text-[10px] opacity-70">{status}</span>
    </button>
  );
}

function statusDot(variant: string): string {
  return cn(
    "size-2 rounded-full",
    variant === "ok" && "bg-ok",
    variant === "warn" && "bg-warn",
    variant === "destructive" && "bg-destructive",
    variant !== "ok" && variant !== "warn" && variant !== "destructive" && "bg-muted-foreground",
  );
}
