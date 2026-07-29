import {
  CheckCircle2,
  ChevronRight,
  CircleDotDashed,
  Workflow as WorkflowIcon,
  XCircle,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { SessionUpdate } from "@/protocol";

import { AgentBadge } from "./AgentBadge";
import { CollapsibleMarkdown, Markdown } from "./Markdown";

type WorkflowEvent = Extract<SessionUpdate, { kind: "workflow_event" }>;

export function WorkflowEventLine({
  compact,
  onOpenTask,
  update,
}: {
  compact?: boolean;
  onOpenTask?: (id: string) => void;
  update: WorkflowEvent;
}) {
  const Icon =
    update.tone === "running"
      ? CircleDotDashed
      : update.tone === "success"
        ? CheckCircle2
        : update.tone === "error"
          ? XCircle
          : WorkflowIcon;
  const tone = {
    error: "border-destructive/35 bg-destructive/[0.06] text-destructive",
    info: "border-border bg-secondary/20 text-muted-foreground",
    running: "border-primary/30 bg-primary/[0.06] text-primary",
    success: "border-ok/30 bg-ok/[0.05] text-ok",
    warning: "border-warn/35 bg-warn/[0.06] text-warn",
  }[update.tone];
  const showAgentCards = update.event === "stage_started";

  return (
    <section className={cn("min-w-0 rounded-lg border px-3 py-2.5", tone)}>
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="size-4 shrink-0" />
        <span
          className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground"
          title={update.title}
        >
          {update.title}
        </span>
        {!showAgentCards &&
          update.agents.map((agent) => (
            <button
              key={agent.taskId}
              type="button"
              disabled={!onOpenTask}
              onClick={() => onOpenTask?.(agent.taskId)}
              className="flex max-w-44 shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-background/50 hover:text-foreground disabled:pointer-events-none"
              aria-label={`Open ${agent.label} agent session`}
            >
              <AgentBadge agentId={agent.agent} size="xs" className="min-w-0" />
            </button>
          ))}
      </div>

      {showAgentCards && update.agents.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {update.agents.map((agent) => (
            <button
              key={agent.taskId}
              type="button"
              disabled={!onOpenTask}
              onClick={() => onOpenTask?.(agent.taskId)}
              className={cn(
                "group flex min-w-44 max-w-full items-center gap-2 rounded-md border border-border bg-background/45 px-2.5 py-2 text-left text-foreground transition-colors",
                onOpenTask
                  ? "hover:border-primary/40 hover:bg-background/70"
                  : "cursor-default disabled:pointer-events-none",
              )}
              aria-label={`Open ${agent.label} agent session`}
            >
              <span className="size-2 shrink-0 rounded-full bg-current" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold">{agent.label}</span>
                <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
                  <AgentBadge
                    agentId={agent.agent}
                    size="xs"
                    className="min-w-0 text-muted-foreground"
                  />
                  {agent.model && (
                    <span className="truncate text-[10px] text-muted-foreground">
                      {agent.model}
                    </span>
                  )}
                </span>
              </span>
              {onOpenTask && (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
              )}
            </button>
          ))}
        </div>
      )}

      {update.detail &&
        (compact ? (
          <Markdown className="mt-2 text-xs text-current">{update.detail}</Markdown>
        ) : (
          <div className="mt-2 border-t border-border pt-2 text-foreground">
            <CollapsibleMarkdown>{update.detail}</CollapsibleMarkdown>
          </div>
        ))}
    </section>
  );
}
