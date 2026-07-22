import { GitBranch, GitMerge, Share2 } from "lucide-react";

import { cn } from "@/lib/utils";

import { AgentBadge } from "./AgentBadge";
import type { AgentConfig, ProjectInfo, ServiceInfo } from "../protocol";

interface TaskComposeBarProps {
  projects: ProjectInfo[];
  agents: AgentConfig[];
  services: ServiceInfo[];

  project: string;
  agent: string;
  shareContext: boolean;
  useWorktree: boolean;
  orchChat: boolean;

  onProjectChange: (v: string) => void;
  onAgentChange: (v: string) => void;
  onShareContextChange: (v: boolean) => void;
  onUseWorktreeChange: (v: boolean) => void;
  onOrchChatChange: (v: boolean) => void;
}

/**
 * Config chips above the Composer in the New Task view. Model + effort
 * selectors are intentionally NOT here — they live inside the Composer's
 * `toolbar` slot via `AgentConfigBar` so New Task's composer looks identical
 * to MissionControl's ("running" agent with the model chip attached).
 *
 * Project + agent (harness) use horizontal chips rather than `<Select>` because
 * the lists are short and chips read cleaner inline. The harness (agent) can
 * only be picked here — once a task is running its agent is locked.
 */
export function TaskComposeBar({
  projects,
  agents,
  services,
  project,
  agent,
  shareContext,
  useWorktree,
  orchChat,
  onProjectChange,
  onAgentChange,
  onShareContextChange,
  onUseWorktreeChange,
  onOrchChatChange,
}: TaskComposeBarProps) {
  const enabledAgents = agents.filter((a) => a.enabled);
  const agentChoices = enabledAgents.length > 0 ? enabledAgents : [{ id: "claude", displayName: "Claude" }];
  const runningForProject = services.filter(
    (s) => s.project === project && s.status === "running" && s.allocatedPort > 0,
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <FieldLabel>Project</FieldLabel>
        {projects.length === 0 ? (
          <span className="text-xs text-muted-foreground">No projects added.</span>
        ) : (
          projects.map((p) => (
            <Chip key={p.name} active={project === p.name} onClick={() => onProjectChange(p.name)}>
              {p.name}
            </Chip>
          ))
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <FieldLabel>{orchChat ? "Lead agent" : "Agent"}</FieldLabel>
        {agentChoices.map((a) => (
          <Chip key={a.id} active={agent === a.id} onClick={() => onAgentChange(a.id)}>
            <AgentBadge agentId={a.id} displayName={a.displayName} size="md" />
          </Chip>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <PillToggle
          active={shareContext}
          onClick={() => onShareContextChange(!shareContext)}
          icon={<Share2 className="size-3" />}
          label="Share services"
          tooltip={
            runningForProject.length > 0
              ? `Agent sees ${runningForProject.map((s) => `${s.name}:${s.allocatedPort}`).join(", ")}`
              : "No services running for this project."
          }
        />
        <PillToggle
          active={useWorktree && !orchChat}
          disabled={orchChat}
          onClick={() => onUseWorktreeChange(!useWorktree)}
          icon={<GitBranch className="size-3" />}
          label="Worktree"
          tooltip="Isolated git worktree"
        />
        <PillToggle
          active={orchChat}
          onClick={() => onOrchChatChange(!orchChat)}
          icon={<GitMerge className="size-3" />}
          label="Orchestrator"
          tooltip="Chat + sub-agents"
        />
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mr-1 text-[11px] uppercase tracking-wider text-muted-foreground">
      {children}
    </span>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors",
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function PillToggle({
  active,
  disabled,
  onClick,
  icon,
  label,
  tooltip,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  tooltip?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={tooltip}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors",
        active
          ? "border-primary/40 bg-primary/10 text-foreground"
          : "border-border text-muted-foreground",
        disabled && "cursor-not-allowed opacity-40",
      )}
    >
      {icon}
      {label}
    </button>
  );
}