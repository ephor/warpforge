import type { PortForwardStatus, ServiceStatus, TaskStatus } from "@/protocol";

type Variant = "default" | "outline" | "ok" | "warn" | "destructive";

export function taskBadge(s: TaskStatus): { variant: Variant; label: string } {
  switch (s) {
    case "running":
      return { label: "running", variant: "ok" };
    case "queued":
      return { label: "queued", variant: "outline" };
    case "idle":
      return { label: "idle", variant: "outline" };
    case "needs_review":
      return { label: "needs review", variant: "warn" };
    case "blocked":
      return { label: "blocked", variant: "destructive" };
    case "interrupted":
      return { label: "interrupted", variant: "destructive" };
    case "done":
      return { label: "done", variant: "default" };
  }
}

/** Badge reflecting the live agent activity (overrides the coarse status while
 * the agent is actively working a turn). */
export function activityBadge(
  tone: "thinking" | "working" | "writing",
  label: string,
): { variant: Variant; label: string } {
  const variant: Variant = tone === "writing" ? "ok" : tone === "working" ? "warn" : "default";
  return { label, variant };
}

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

export function orchNodeBadge(s: "pending" | "running" | "complete" | "failed" | "skipped"): {
  variant: Variant;
  label: string;
} {
  switch (s) {
    case "running":
      return { label: "running", variant: "ok" };
    case "pending":
      return { label: "pending", variant: "outline" };
    case "complete":
      return { label: "done", variant: "default" };
    case "failed":
      return { label: "failed", variant: "destructive" };
    case "skipped":
      return { label: "skipped", variant: "outline" };
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
