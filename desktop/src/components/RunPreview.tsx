import { ChevronRight, FileDiff, MessageSquare, Repeat } from "lucide-react";
import { Fragment } from "react";

import { agentDisplayName } from "@/lib/agentNames";
import { cn } from "@/lib/utils";

import type { AgentConfig, WorkflowMeta } from "../protocol";
import { AgentLogo } from "./AgentLogo";
import type { TaskMode } from "./TaskComposeBar";

/**
 * Shows what pressing Start will actually do, as a strip of blocks rather than
 * a paragraph: the mode toggle names the shape of the run, this draws it.
 *
 * Workflow is drawn from the selected template's real stages and round limit —
 * never from a canned picture. Orchestrator is explicitly an example, because
 * the lead decides the split at runtime and no honest preview exists before
 * the prompt is read; it is staffed from the user's own enabled harnesses so
 * the icons match what they will see in the sidebar.
 *
 * Every mode draws a single row of equal-height blocks. That is a layout
 * constraint, not a coincidence: the preview sits under a vertically centred
 * column, so a mode whose diagram is two rows tall would shove the composer up
 * the screen the moment you switch tabs.
 */
export function RunPreview({
  agent,
  agents,
  mode,
  workflow,
}: {
  agent: string;
  agents: AgentConfig[];
  mode: TaskMode;
  workflow: WorkflowMeta | null;
}) {
  const agentName = agentDisplayName(agent, agents.find((a) => a.id === agent)?.displayName);
  const logo = (id: string) => (
    <AgentLogo
      agentId={id}
      displayName={agentDisplayName(id, agents.find((a) => a.id === id)?.displayName)}
      className="size-4 shrink-0"
    />
  );

  if (mode === "workflow") {
    if (!workflow) return null;
    const stages = parseStages(workflow.stages ?? []);
    if (stages.length === 0) return null;
    const rounds = workflow.maxRounds ?? 0;
    return (
      <Preview
        note={"Every stage runs on " + agentName + " unless the template names its own agent."}
      >
        {stages.map((stage, index) => {
          const next = stages[index + 1];
          const loop = stage.kind === "review" && next?.kind === "fix";
          return (
            <Fragment key={stage.kind}>
              <Node
                icon={logo(agent)}
                title={STAGE_COPY[stage.kind]?.title ?? stage.kind}
                caption={
                  stage.count > 1
                    ? stage.count + " reviewers in parallel"
                    : (STAGE_COPY[stage.kind]?.caption ?? "stage " + (index + 1))
                }
              />
              {next && <Arrow loop={loop} label={loop && rounds > 0 ? "×" + rounds : undefined} />}
            </Fragment>
          );
        })}
      </Preview>
    );
  }

  if (mode === "orchestrator") {
    // Rotate through the enabled harnesses so the fan shows that workers are
    // not all the lead. With one harness installed they correctly all match.
    const pool = agents.length > 0 ? agents.map((a) => a.id) : [agent];
    return (
      <Preview note="Example split — the lead reads your prompt and decides the real one.">
        {/* `flex-none` beats the Node's own `flex-1` through twMerge: the lead is
            a fixed anchor and the fan divides whatever is left. */}
        <Node
          className="w-56 flex-none"
          lead
          icon={logo(agent)}
          title={agentName + " leads"}
          caption="your conversation"
        />
        <Arrow />
        {WORKER_EXAMPLE.map((worker, index) => (
          <Node
            key={worker.title}
            icon={logo(pool[(index + 1) % pool.length])}
            title={worker.title}
            caption={worker.caption}
          />
        ))}
      </Preview>
    );
  }

  return (
    <Preview note="One session, no delegation and no review stage.">
      <Node
        icon={<MessageSquare aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
        title="Your prompt"
        caption="plus any files you @mention"
      />
      <Arrow />
      <Node icon={logo(agent)} title={agentName} caption="works until the task is done" />
      <Arrow />
      <Node
        icon={<FileDiff aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
        title="Changes to review"
        caption="staged in the task's Changes rail"
      />
    </Preview>
  );
}

/** `review×2` carries the reviewer count the daemon resolved from the YAML. */
function parseStages(stages: string[]): { kind: string; count: number }[] {
  return stages.map((stage) => {
    const [kind, count] = stage.split("×");
    return { count: Number(count) || 1, kind };
  });
}

const STAGE_COPY: Record<string, { title: string; caption: string }> = {
  fix: { caption: "applies the findings", title: "Fix" },
  implement: { caption: "writes the code", title: "Implement" },
  plan: { caption: "writes the plan first", title: "Plan" },
  review: { caption: "checks the diff", title: "Review" },
};

const WORKER_EXAMPLE = [
  { caption: "worker", title: "Explore the codebase" },
  { caption: "worker", title: "Implement the change" },
  { caption: "worker", title: "Update the docs" },
  { caption: "child workflow", title: "Review pipeline" },
];

function Preview({ children, note }: { children: React.ReactNode; note: string }) {
  return (
    <section aria-label="Run preview" className="flex flex-col gap-2">
      <div className="flex items-stretch gap-1.5">{children}</div>
      <p className="text-[11px] text-muted-foreground">{note}</p>
    </section>
  );
}

function Node({
  caption,
  className,
  icon,
  lead = false,
  title,
}: {
  caption: string;
  className?: string;
  icon: React.ReactNode;
  lead?: boolean;
  title: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg bg-card px-3 py-2",
        lead && "ring-1 ring-primary/30",
        className,
      )}
    >
      <span className="flex items-center gap-1.5">
        {icon}
        <span className="truncate text-xs font-medium text-foreground">{title}</span>
      </span>
      <span className="truncate pl-[22px] text-[11px] text-muted-foreground">{caption}</span>
    </div>
  );
}

function Arrow({ label, loop = false }: { label?: string; loop?: boolean }) {
  const Icon = loop ? Repeat : ChevronRight;
  return (
    <span className="flex shrink-0 flex-col items-center justify-center gap-0.5 self-center text-muted-foreground">
      <Icon aria-hidden className={cn("size-3.5", loop && "text-primary")} />
      {label && <span className="tnum text-[10px] leading-none text-primary">{label}</span>}
    </span>
  );
}
