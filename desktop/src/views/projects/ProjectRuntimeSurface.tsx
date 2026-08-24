import { useMemo } from "react";

import { RuntimePanel } from "@/components/RuntimePanel";

import type { PortForwardInfo, ServiceInfo } from "../../protocol";

export interface ProjectRuntimeSurfaceProps {
  project: string;
  /** Declared services included, so a project that has never run still lists them. */
  services: ServiceInfo[];
  portforwards: PortForwardInfo[];
  onAppendToChat?: (formattedLogs: string) => void;
}

/**
 * Runtime surface: the services/port-forwards panel at full height, with the live
 * URLs of whatever is up above it. The URLs are the part agents care about — a
 * task started while these are running knows the app is up and on which ports.
 *
 * Start/stop-everything lives in the panel's own list headers rather than in a
 * strip up here: two rows of controls over one list meant the same actions
 * appeared twice, and the list is where the thing being started is visible.
 * The interactive shell is its own surface, not a tab inside this one.
 */
export function ProjectRuntimeSurface({
  project,
  services,
  portforwards,
  onAppendToChat,
}: ProjectRuntimeSurfaceProps) {
  const running = useMemo(
    () => services.filter((s) => s.status === "running" && s.allocatedPort > 0),
    [services],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {running.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 px-3 py-1.5 font-mono text-xs">
          {running.map((service) => (
            <span key={service.name} className="flex gap-2">
              <span className="text-muted-foreground">{service.name}</span>
              <span className="tnum text-primary">http://localhost:{service.allocatedPort}</span>
            </span>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1">
        <RuntimePanel
          key={project}
          project={project}
          services={services}
          portforwards={portforwards}
          onAppendToChat={onAppendToChat}
        />
      </div>
    </div>
  );
}
