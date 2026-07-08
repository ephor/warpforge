import { Server, PlugZap } from "lucide-react";
import { ServiceInfo, PortForwardInfo } from "../protocol";
import { serviceBadge, pfBadge } from "@/lib/status";
import { Badge } from "@/components/ui/badge";

/**
 * Read-only view of a task project's running services + port-forwards, so you
 * can watch runtime state without leaving the agent page. Start/stop still live
 * in the Projects view.
 */
export function RuntimePanel({
  services,
  portforwards,
}: {
  services: ServiceInfo[];
  portforwards: PortForwardInfo[];
}) {
  if (services.length === 0 && portforwards.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground">
        No services or port-forwards for this project.
      </div>
    );
  }
  return (
    <div className="divide-y text-xs">
      {services.map((s) => {
        const badge = serviceBadge(s.status);
        return (
          <div key={s.name} className="flex items-center gap-2 px-3 py-1.5">
            <Server className="size-3.5 text-muted-foreground" />
            <span className="w-32 truncate font-medium">{s.name}</span>
            <Badge variant={badge.variant}>{badge.label}</Badge>
            <span className="tnum ml-auto font-mono text-muted-foreground">
              :{s.allocatedPort}
            </span>
          </div>
        );
      })}
      {portforwards.map((pf) => {
        const badge = pfBadge(pf.status);
        return (
          <div key={pf.name} className="flex items-center gap-2 px-3 py-1.5">
            <PlugZap className="size-3.5 text-muted-foreground" />
            <span className="w-32 truncate font-medium">{pf.name}</span>
            <Badge variant={badge.variant}>{badge.label}</Badge>
            <span className="tnum ml-auto font-mono text-primary">
              :{pf.localPort} → {pf.remotePort}
            </span>
          </div>
        );
      })}
    </div>
  );
}
