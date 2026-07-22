import type { PortForwardStatus, ServiceStatus } from "@/protocol";

type Variant = "default" | "outline" | "ok" | "warn" | "destructive";

export function serviceBadge(s: ServiceStatus): { variant: Variant; label: string } {
  switch (s) {
    case "running":
      return { label: "running", variant: "ok" };
    case "starting":
      return { label: "starting", variant: "warn" };
    case "failed":
      return { label: "failed", variant: "destructive" };
    case "stopped":
      return { label: "stopped", variant: "outline" };
  }
}

export function pfBadge(s: PortForwardStatus): { variant: Variant; label: string } {
  switch (s) {
    case "active":
      return { label: "active", variant: "ok" };
    case "starting":
    case "restarting":
      return { label: s, variant: "warn" };
    case "failed":
      return { label: "failed", variant: "destructive" };
    case "stopped":
      return { label: "stopped", variant: "outline" };
  }
}

export function elapsed(sinceUnix: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - sinceUnix);
  if (s < 60) {
    return `${s}s`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m`;
  }
  if (s < 86400) {
    return `${Math.floor(s / 3600)}h`;
  }
  return `${Math.floor(s / 86400)}d`;
}
