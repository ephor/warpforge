import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  GitBranch,
  GitMerge,
  Route,
  Share2,
} from "lucide-react";
import { Fragment } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import type { AgentConfig, ProjectInfo, ServiceInfo, WorkflowMeta } from "../protocol";
import { AgentBadge } from "./AgentBadge";

interface TaskComposeBarProps {
  projects: ProjectInfo[];
  agents: AgentConfig[];
  services: ServiceInfo[];

  project: string;
  agent: string;
  shareContext: boolean;
  useWorktree: boolean;
  orchChat: boolean;
  /** Available workflow templates for the selected project. */
  workflows: WorkflowMeta[];
  /** Selected workflow id, or null for a plain single-agent task. */
  workflow: string | null;

  onProjectChange: (v: string) => void;
  onAgentChange: (v: string) => void;
  onShareContextChange: (v: boolean) => void;
  onUseWorktreeChange: (v: boolean) => void;
  onOrchChatChange: (v: boolean) => void;
  onWorkflowChange: (v: string | null) => void;
  onEjectWorkflow: (id: string) => void;
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
  workflows,
  workflow,
  onProjectChange,
  onAgentChange,
  onShareContextChange,
  onUseWorktreeChange,
  onOrchChatChange,
  onWorkflowChange,
  onEjectWorkflow,
}: TaskComposeBarProps) {
  const enabledAgents = agents.filter((a) => a.enabled);
  const agentChoices =
    enabledAgents.length > 0 ? enabledAgents : [{ id: "claude", displayName: "Claude" }];
  const runningForProject = services.filter(
    (s) => s.project === project && s.status === "running" && s.allocatedPort > 0,
  );
  const selectedWorkflow = workflows.find((w) => w.id === workflow) ?? null;

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
        <FieldLabel>{orchChat || workflow ? "Lead agent" : "Agent"}</FieldLabel>
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
          disabled={!!workflow}
          onClick={() => onOrchChatChange(!orchChat)}
          icon={<GitMerge className="size-3" />}
          label="Orchestrator"
          tooltip={workflow ? "Not available with a workflow selected" : "Chat + sub-agents"}
        />
        <WorkflowPicker
          workflows={workflows}
          selected={selectedWorkflow}
          disabled={orchChat}
          onSelect={onWorkflowChange}
          onEject={onEjectWorkflow}
        />
      </div>
      {selectedWorkflow && (
        <p className="-mt-2 text-xs text-muted-foreground">
          {selectedWorkflow.description ? `${selectedWorkflow.description} ` : ""}
          {(selectedWorkflow.stages ?? []).join(" \u2192 ")}
          {selectedWorkflow.maxRounds
            ? `, up to ${selectedWorkflow.maxRounds} review round${selectedWorkflow.maxRounds === 1 ? "" : "s"}`
            : ""}
          {". The agent above leads any stage the workflow doesn\u2019t assign."}
        </p>
      )}
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

/**
 * Workflow template picker. A workflow replaces the single-agent run with a
 * daemon-driven pipeline, so it is mutually exclusive with the orchestrator
 * chat. Invalid templates stay listed (with their parse error) so a typo in a
 * project's YAML is visible here rather than silently missing.
 */
function WorkflowPicker({
  workflows,
  selected,
  disabled,
  onSelect,
  onEject,
}: {
  workflows: WorkflowMeta[];
  selected: WorkflowMeta | null;
  disabled?: boolean;
  onSelect: (id: string | null) => void;
  onEject: (id: string) => void;
}) {
  if (workflows.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={
            disabled
              ? "Not available with the orchestrator enabled"
              : "Run this task as a configured pipeline"
          }
          className={cn(
            "flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors",
            selected
              ? "border-primary/40 bg-primary/10 text-foreground"
              : "border-border text-muted-foreground",
            disabled && "cursor-not-allowed opacity-40",
          )}
        >
          <Route className="size-3" />
          {selected ? selected.name : "Workflow"}
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuItem onSelect={() => onSelect(null)}>
          <span className="flex w-full items-center gap-2">
            <Check className={cn("size-3.5", selected ? "opacity-0" : "opacity-100")} />
            <span className="flex flex-col">
              <span>No workflow</span>
              <span className="text-xs text-muted-foreground">
                One agent works the task directly.
              </span>
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Pipelines
        </DropdownMenuLabel>
        {workflows.map((w) => (
          <Fragment key={w.id}>
            <DropdownMenuItem
              disabled={!w.valid}
              title={w.valid ? (w.warnings ?? []).join("\n") || undefined : (w.error ?? undefined)}
              onSelect={() => onSelect(w.id)}
            >
              <span className="flex w-full items-start gap-2">
                <Check
                  className={cn(
                    "mt-0.5 size-3.5 shrink-0",
                    selected?.id === w.id ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate">{w.name}</span>
                    {w.source === "builtin" && (
                      <span className="shrink-0 rounded bg-secondary px-1 text-[10px] text-muted-foreground">
                        built-in
                      </span>
                    )}
                    {!w.valid && <AlertTriangle className="size-3 shrink-0 text-destructive" />}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {w.valid ? (w.stages ?? []).join(" \u2192 ") : (w.error ?? "invalid workflow")}
                  </span>
                </span>
              </span>
            </DropdownMenuItem>
            {/* Ejecting is its own row: a nested button inside a menu item
                never receives the click, because Radix closes the menu first. */}
            {w.source === "builtin" && w.valid && (
              <DropdownMenuItem
                title="Write a copy into .warpforge/workflows/ so you can edit it"
                onSelect={() => onEject(w.id)}
              >
                <span className="flex items-center gap-2 pl-5 text-xs text-muted-foreground">
                  <Copy className="size-3" />
                  Copy to project
                </span>
              </DropdownMenuItem>
            )}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
