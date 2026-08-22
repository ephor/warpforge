import { useCallback, useEffect, useMemo, useState } from "react";

import { useUi } from "@/store/ui";

import type { PortForwardInfo, ServiceInfo } from "../../protocol";
import { makeSidebarKey, type SidebarItem } from "./constants";
import { PortForwardDetailPane, ServiceDetailPane } from "./RuntimeDetail";
import { RuntimeHeader } from "./RuntimeHeader";
import { RuntimeSidebar } from "./RuntimeSidebar";

export function RuntimePanel({
  project,
  services,
  portforwards,
  onAppendToChat,
}: {
  project: string;
  services: ServiceInfo[];
  portforwards: PortForwardInfo[];
  onAppendToChat?: (formattedLogs: string) => void;
}) {
  const hasItems = services.length > 0 || portforwards.length > 0;
  const [actionError, setActionError] = useState<string | null>(null);
  const sidebarCollapsed = useUi((s) => s.runtimeSidebarCollapsed);
  const toggleSidebarCollapsed = useUi((s) => s.toggleRuntimeSidebarCollapsed);

  const statusSignature = useMemo(() => {
    const svcPart = services.map((s) => `${s.name}:${s.status}`).join(",");
    const pfPart = portforwards.map((p) => `${p.name}:${p.status}`).join(",");
    return `${svcPart}|${pfPart}`;
  }, [services, portforwards]);

  useEffect(() => {
    setActionError(null);
  }, [statusSignature]);

  const sidebarItems = useMemo<SidebarItem[]>(() => {
    const items: SidebarItem[] = services.map((s) => ({ kind: "service", name: s.name }));
    for (const p of portforwards) {
      items.push({ kind: "portforward", name: p.name });
    }
    return items;
  }, [services, portforwards]);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const resolvedKey = useMemo(() => {
    if (selectedKey && sidebarItems.some((i) => makeSidebarKey(i) === selectedKey)) {
      return selectedKey;
    }
    return sidebarItems.length > 0 ? makeSidebarKey(sidebarItems[0]) : null;
  }, [selectedKey, sidebarItems]);

  const selectedService = useMemo(
    () => services.find((s) => `service:${s.name}` === resolvedKey) ?? null,
    [services, resolvedKey],
  );
  const selectedPf = useMemo(
    () => portforwards.find((p) => `portforward:${p.name}` === resolvedKey) ?? null,
    [portforwards, resolvedKey],
  );

  const handleSelect = useCallback((item: SidebarItem) => {
    setSelectedKey(makeSidebarKey(item));
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <RuntimeHeader
        actionError={actionError}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={toggleSidebarCollapsed}
      />

      <div className="min-h-0 flex-1">
        {!hasItems ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
            No services or port-forwards configured for this project.
          </div>
        ) : (
          <div className="flex h-full min-h-0">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {selectedService ? (
                <ServiceDetailPane
                  project={project}
                  service={selectedService}
                  onAppendToChat={onAppendToChat}
                />
              ) : selectedPf ? (
                <PortForwardDetailPane
                  project={project}
                  pf={selectedPf}
                  onAppendToChat={onAppendToChat}
                />
              ) : (
                <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
                  Select a service to view logs
                </div>
              )}
            </div>
            {!sidebarCollapsed && (
              <RuntimeSidebar
                project={project}
                services={services}
                portforwards={portforwards}
                selectedKey={resolvedKey}
                onSelect={handleSelect}
                onError={setActionError}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
