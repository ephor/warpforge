import { PlugZap } from "lucide-react";
import type { MouseEvent } from "react";

import { openExternalLink } from "@/lib/externalLinks";
import { pfBadge, serviceBadge } from "@/lib/status";
import { cn } from "@/lib/utils";

import type { PortForwardInfo, ServiceInfo } from "../../protocol";
import { LogViewer } from "./LogViewer";
import { StatusDot } from "./StatusDot";

function ServicePortLink({ port, running }: { port: number; running: boolean }) {
  const url = `http://localhost:${port}`;
  if (!running) {
    return (
      <span
        className="shrink-0 font-mono text-[11px] text-primary/60"
        title={`Port ${port} (not running)`}
      >
        :{port}
      </span>
    );
  }
  return (
    <a
      href={url}
      title={`Open ${url}`}
      aria-label={`Open http://localhost:${port} in browser`}
      onClick={(e: MouseEvent) => {
        e.preventDefault();
        void openExternalLink(url);
      }}
      className={cn(
        "shrink-0 font-mono text-[11px] text-primary",
        "hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded-sm",
      )}
    >
      :{port}
    </a>
  );
}

export function ServiceDetailPane({
  project,
  service,
  onAppendToChat,
}: {
  project: string;
  service: ServiceInfo;
  onAppendToChat?: (formattedLogs: string) => void;
}) {
  const badge = serviceBadge(service.status);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <StatusDot variant={badge.variant} />
        <span className="text-xs font-medium">{service.name}</span>
        <span className="rounded border border-border px-1.5 py-px text-[10px] text-muted-foreground">
          {badge.label}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {service.command}
        </span>
        {service.allocatedPort > 0 && (
          <ServicePortLink port={service.allocatedPort} running={service.status === "running"} />
        )}
      </div>
      <LogViewer
        key={`${project}/${service.name}`}
        logKey={`${project}/${service.name}`}
        kind="service"
        project={project}
        name={service.name}
        onAppendToChat={onAppendToChat}
      />
    </div>
  );
}

export function PortForwardDetailPane({
  project,
  pf,
  onAppendToChat,
}: {
  project: string;
  pf: PortForwardInfo;
  onAppendToChat?: (formattedLogs: string) => void;
}) {
  const badge = pfBadge(pf.status);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <PlugZap className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">{pf.name}</span>
        <span className="rounded border border-border px-1.5 py-px text-[10px] text-muted-foreground">
          {badge.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {pf.namespace}/{pf.pod}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-primary">
          :{pf.localPort} → :{pf.remotePort}
        </span>
      </div>
      <LogViewer
        key={`${project}/${pf.name}`}
        logKey={`${project}/${pf.name}`}
        kind="portforward"
        project={project}
        name={pf.name}
        onAppendToChat={onAppendToChat}
      />
    </div>
  );
}
