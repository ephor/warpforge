import { PortForwardStatus, ServiceStatus, TaskStatus } from "@/protocol";

type Variant = "default" | "outline" | "ok" | "warn" | "destructive";

export function taskBadge(s: TaskStatus): { variant: Variant; label: string } {
  switch (s) {
    case "running":
      return { variant: "ok", label: "running" };
    case "queued":
      return { variant: "outline", label: "queued" };
    case "idle":
      return { variant: "outline", label: "idle" };
    case "needs_review":
      return { variant: "warn", label: "needs review" };
    case "blocked":
      return { variant: "destructive", label: "blocked" };
    case "interrupted":
      return { variant: "destructive", label: "interrupted" };
    case "done":
      return { variant: "default", label: "done" };
  }
}

/** Badge reflecting the live agent activity (overrides the coarse status while
 * the agent is actively working a turn). */
export function activityBadge(
  tone: "thinking" | "working" | "writing",
  label: string,
): { variant: Variant; label: string } {
  const variant: Variant = tone === "writing" ? "ok" : tone === "working" ? "warn" : "default";
  return { variant, label };
}

export function serviceBadge(s: ServiceStatus): { variant: Variant; label: string } {
  switch (s) {
    case "running":
      return { variant: "ok", label: "running" };
    case "starting":
      return { variant: "warn", label: "starting" };
    case "failed":
      return { variant: "destructive", label: "failed" };
    case "stopped":
      return { variant: "outline", label: "stopped" };
  }
}

export function pfBadge(s: PortForwardStatus): { variant: Variant; label: string } {
  switch (s) {
    case "active":
      return { variant: "ok", label: "active" };
    case "starting":
    case "restarting":
      return { variant: "warn", label: s };
    case "failed":
      return { variant: "destructive", label: "failed" };
    case "stopped":
      return { variant: "outline", label: "stopped" };
  }
}

/** Left-edge accent colour for a task tile, by status. */
export function taskEdge(s: TaskStatus): string {
  switch (s) {
    case "running":
      return "border-l-ok";
    case "needs_review":
      return "border-l-warn";
    case "blocked":
    case "interrupted":
      return "border-l-destructive";
    default:
      return "border-l-border";
  }
}

export function elapsed(sinceUnix: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - sinceUnix);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
