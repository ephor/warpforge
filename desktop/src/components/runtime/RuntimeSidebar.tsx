import { Loader2, Play, RotateCw, Square } from "lucide-react";
import { memo } from "react";

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

/**
 * A list heading with its own bulk controls, in the same shape every other
 * panel heading in the app uses (`Files`, `Changes`): 44px tall, bottom rule,
 * title left, icon actions right. Services and port-forwards both get one, so
 * the two lists read as siblings — a control present for one and missing for
 * the other looked like an oversight rather than a distinction.
 *
 * Start shows while anything is still down and stop while anything is still
 * up, instead of one button whose meaning you have to infer from the rows.
 */
function SectionHeader({
  label,
  bulk,
  onError,
}: {
  label: string;
  bulk: {
    noun: string;
    project: string;
    startMethod: string;
    stopMethod: string;
    hasStartable: boolean;
    hasStoppable: boolean;
    isSettling: boolean;
    allUp: boolean;
  };
  onError: (msg: string) => void;
}) {
  const { allUp, hasStartable, hasStoppable, isSettling, noun, project } = bulk;
  return (
    <div className="sticky top-0 z-10 flex h-11 items-center gap-2 border-b bg-card px-3 text-sm font-semibold">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {!allUp && (
        <button
          type="button"
          disabled={!hasStartable || isSettling}
          className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={
            isSettling
              ? `${noun} starting…`
              : hasStartable
                ? `Start all ${noun}`
                : `No startable ${noun}`
          }
          aria-label={`Start all ${noun}`}
          onClick={() => safeRequest(bulk.startMethod, { project }, onError)}
        >
          <Play className="size-3.5" />
        </button>
      )}
      {hasStoppable && (
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={`Stop all ${noun}`}
          aria-label={`Stop all ${noun}`}
          onClick={() => safeRequest(bulk.stopMethod, { project }, onError)}
        >
          <Square className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * A row action. Hidden until the row is hovered, focused or selected: a list of
 * fifteen forwards otherwise renders fifteen identical bordered play buttons
 * down the edge, which reads as a control panel rather than a list of names.
 * The slot keeps its width either way so nothing shifts as the pointer moves,
 * and it toggles `invisible` rather than fading — the Tauri WebView mispaints
 * opacity transitions that start and cancel inside a frame (ADR-0002
 * invariant 13).
 */
const ROW_ACTION =
  "flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function rowActionsClass(selected: boolean): string {
  return cn(
    "flex shrink-0 items-center gap-px",
    selected ? "visible" : "invisible group-hover:visible group-focus-within:visible",
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
        "group flex w-full items-center gap-1.5 px-2 py-1 text-xs",
        selected
          ? "bg-secondary text-foreground"
          : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          selected ? "text-foreground" : "text-muted-foreground group-hover:text-foreground",
        )}
        aria-label={`Select ${service.name}, ${badge.label}`}
        aria-pressed={selected}
        title={service.name}
      >
        <StatusDot variant={badge.variant} />
        <span className="min-w-0 flex-1 truncate font-medium">{service.name}</span>
        <span className="sr-only">{badge.label}</span>
      </button>
      <div className={rowActionsClass(selected)}>
        {!canStop && (
          <button
            type="button"
            className={ROW_ACTION}
            title={`Start ${service.name}`}
            aria-label={`Start ${service.name}`}
            onClick={() =>
              safeRequest("service.start", { project, service: service.name }, onError)
            }
          >
            <Play className="size-3" />
          </button>
        )}
        {canRestart && (
          <button
            type="button"
            className={ROW_ACTION}
            title={`Restart ${service.name}`}
            aria-label={`Restart ${service.name}`}
            onClick={() =>
              safeRequest("service.restart", { project, service: service.name }, onError)
            }
          >
            <RotateCw className="size-3" />
          </button>
        )}
        {canStop && (
          <button
            type="button"
            className={cn(ROW_ACTION, "hover:text-destructive")}
            title={`Stop ${service.name}`}
            aria-label={`Stop ${service.name}`}
            onClick={() => safeRequest("service.stop", { project, service: service.name }, onError)}
          >
            <Square className="size-3" />
          </button>
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
        "group flex w-full items-center gap-1.5 px-2 py-1 text-xs",
        selected
          ? "bg-secondary text-foreground"
          : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          selected ? "text-foreground" : "text-muted-foreground group-hover:text-foreground",
        )}
        aria-label={`Select ${pf.name}, ${badge.label}`}
        aria-pressed={selected}
        title={pf.name}
      >
        {/* Same status dot as a service row: which list a row is in already
            says what kind of thing it is, so the icon is free to carry the
            status instead — and the two lists scan as one. */}
        <StatusDot variant={badge.variant} />
        <span className="min-w-0 flex-1 truncate font-medium">{pf.name}</span>
        <span className="sr-only">{badge.label}</span>
      </button>
      <div className={rowActionsClass(selected)}>
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
          <button
            type="button"
            className={ROW_ACTION}
            title={`Start ${pf.name}`}
            aria-label={`Start ${pf.name}`}
            onClick={() => safeRequest("portforward.start", { project, name: pf.name }, onError)}
          >
            <Play className="size-3" />
          </button>
        )}
        {isActive && (
          <button
            type="button"
            className={cn(ROW_ACTION, "hover:text-destructive")}
            title={`Stop ${pf.name}`}
            aria-label={`Stop ${pf.name}`}
            onClick={() => safeRequest("portforward.stop", { project, name: pf.name }, onError)}
          >
            <Square className="size-3" />
          </button>
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
      {services.length > 0 && (
        <div className="flex flex-col">
          <SectionHeader
            label="Services"
            onError={onError}
            bulk={{
              allUp: services.every((svc) => svc.status === "running"),
              hasStartable: services.some(
                (svc) => svc.status === "stopped" || svc.status === "failed",
              ),
              hasStoppable: services.some(
                (svc) => svc.status === "running" || svc.status === "starting",
              ),
              isSettling: services.some((svc) => svc.status === "starting"),
              noun: "services",
              project,
              startMethod: "service.startAll",
              stopMethod: "service.stopAll",
            }}
          />
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
          <SectionHeader
            label="Port Forwards"
            onError={onError}
            bulk={{
              allUp: portforwards.every((pf) => pf.status === "active"),
              hasStartable: portforwards.some(
                (pf) => pf.status === "stopped" || pf.status === "failed",
              ),
              hasStoppable: portforwards.some((pf) => pf.status === "active"),
              isSettling: portforwards.some(
                (pf) => pf.status === "starting" || pf.status === "restarting",
              ),
              noun: "port-forwards",
              project,
              startMethod: "portforward.startAll",
              stopMethod: "portforward.stopAll",
            }}
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
