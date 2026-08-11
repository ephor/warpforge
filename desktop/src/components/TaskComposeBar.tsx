import {
  AlertTriangle,
  Check,
  ChevronDown,
  FileDown,
  Folder,
  GitBranch,
  Route,
  Share2,
} from "lucide-react";
import { useRef } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { agentDisplayName } from "@/lib/agentNames";
import { cn } from "@/lib/utils";

import type { AgentConfig, ProjectInfo, ServiceInfo, WorkflowMeta } from "../protocol";
import { AgentLogo } from "./AgentLogo";

/**
 * How a task executes. `single` and `orchestrator` differ in *who decides* the
 * plan; `workflow` replaces the decision with a fixed pipeline. They are one
 * three-way choice rather than independent toggles because a task runs exactly
 * one of them. (An orchestrator can still spawn a pipeline mid-run — that is
 * the lead's runtime call, not this pre-flight choice.)
 */
export type TaskMode = "single" | "orchestrator" | "workflow";

/**
 * Every control in this bar is one shape at one height. The bar mixes single
 * buttons, dropdowns and segmented groups, and letting each pick its own pill
 * radius made the row read as unrelated widgets rather than one context strip.
 */
const CONTROL =
  "flex h-8 shrink-0 items-center rounded-lg border-border px-2.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40";
const ACTIVE_CONTROL = "border-primary/40 bg-primary/10 text-foreground";
/** Segmented groups wrap their items, so the border+height sit on the wrapper. */
const GROUP = "flex h-8 shrink-0 items-center gap-0.5 rounded-lg border border-border p-0.5";

interface TaskComposeBarProps {
  projects: ProjectInfo[];
  agents: AgentConfig[];
  services: ServiceInfo[];

  project: string;
  agent: string;
  shareContext: boolean;
  useWorktree: boolean;
  mode: TaskMode;
  /** Current branch of the project repo; null while loading or when not a repo. */
  branch: string | null;
  /** Available workflow templates for the selected project. */
  workflows: WorkflowMeta[];
  /** Selected workflow id, or null when no pipeline is chosen. */
  workflow: string | null;

  onProjectChange: (v: string) => void;
  onAgentChange: (v: string) => void;
  onShareContextChange: (v: boolean) => void;
  onUseWorktreeChange: (v: boolean) => void;
  onModeChange: (v: TaskMode) => void;
  onWorkflowChange: (v: string | null) => void;
  onEjectWorkflow: (id: string) => void;
}

/**
 * A single row of run context above the New Task composer: where it runs, which
 * harness drives it, and which execution mode. Model + effort selectors are
 * intentionally NOT here — they live inside the Composer's `toolbar` slot via
 * `AgentConfigBar`, so this bar answers "where/how" and the composer answers
 * "with what settings".
 *
 * Everything stays on one line and nothing hides behind an "advanced" flyout:
 * orchestration and pipelines are the product's differentiators, so burying
 * them would be the wrong trade even though it would look tidier.
 */
export function TaskComposeBar({
  projects,
  agents,
  services,
  project,
  agent,
  shareContext,
  useWorktree,
  mode,
  branch,
  workflows,
  workflow,
  onProjectChange,
  onAgentChange,
  onShareContextChange,
  onUseWorktreeChange,
  onModeChange,
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
  const hasWorkflows = workflows.some((w) => w.valid);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <ProjectPicker projects={projects} project={project} onChange={onProjectChange} />

        <Divider />

        <div role="radiogroup" aria-label="Agent" className={GROUP}>
          {agentChoices.map((a) => {
            const name = agentDisplayName(a.id, a.displayName);
            return (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={agent === a.id}
                aria-label={name}
                title={name}
                onClick={() => onAgentChange(a.id)}
                className={cn(
                  "flex h-full items-center rounded-md px-2 transition-colors",
                  agent === a.id ? "bg-secondary" : "opacity-50 hover:opacity-100",
                )}
              >
                <AgentLogo agentId={a.id} displayName={name} className="size-4" />
              </button>
            );
          })}
        </div>

        <Divider />

        <div role="radiogroup" aria-label="Execution mode" className={GROUP}>
          <ModeButton mode="single" current={mode} onSelect={onModeChange}>
            Single
          </ModeButton>
          <ModeButton mode="orchestrator" current={mode} onSelect={onModeChange}>
            Orchestrator
          </ModeButton>
          <ModeButton
            mode="workflow"
            current={mode}
            onSelect={onModeChange}
            disabled={!hasWorkflows}
            title={hasWorkflows ? undefined : "No pipelines defined in this project"}
          >
            Workflow
          </ModeButton>
        </div>

        {mode === "workflow" && (
          <WorkflowPicker
            workflows={workflows}
            selected={selectedWorkflow}
            onSelect={onWorkflowChange}
            onEject={onEjectWorkflow}
          />
        )}

        <Divider />

        {/* No `ml-auto` here: pushing these right fought `flex-wrap`, so a row
            that did not fit left them stranded on a line of their own. */}
        <div className="flex items-center gap-2">
          <PillToggle
            active={shareContext}
            onClick={() => onShareContextChange(!shareContext)}
            icon={<Share2 className="size-3.5 shrink-0" />}
            label="Share services"
            tooltip={
              runningForProject.length > 0
                ? `Agent sees ${runningForProject.map((s) => `${s.name}:${s.allocatedPort}`).join(", ")}`
                : "No services running for this project."
            }
          />
          <PillToggle
            active={useWorktree && mode !== "orchestrator"}
            disabled={mode === "orchestrator"}
            onClick={() => onUseWorktreeChange(!useWorktree)}
            icon={<GitBranch className="size-3.5 shrink-0" />}
            label="Worktree"
            tooltip={
              mode === "orchestrator"
                ? "An orchestrator and its workers share your current checkout."
                : "Run in an isolated git worktree. Remembered for the next task."
            }
          />
        </div>
      </div>

      <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        {branch && (
          <span className="inline-flex items-center gap-1">
            <GitBranch className="size-3 shrink-0" />
            <span className="max-w-64 truncate font-medium text-foreground/80">{branch}</span>
            <span aria-hidden>·</span>
          </span>
        )}
        <span>
          {mode === "orchestrator"
            ? "The lead and its workers all run in your current checkout."
            : useWorktree
              ? "Runs in an isolated git worktree, so your current checkout stays untouched."
              : "Runs in your current checkout."}
        </span>
      </p>
    </div>
  );
}

function Divider() {
  return <span aria-hidden className="h-5 w-px shrink-0 bg-border" />;
}

function ModeButton({
  mode,
  current,
  disabled,
  title,
  onSelect,
  children,
}: {
  mode: TaskMode;
  current: TaskMode;
  disabled?: boolean;
  title?: string;
  onSelect: (v: TaskMode) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={current === mode}
      disabled={disabled}
      title={title}
      onClick={() => onSelect(mode)}
      className={cn(
        "h-full rounded-md px-2.5 text-sm transition-colors",
        current === mode
          ? "bg-primary/15 text-foreground"
          : "text-muted-foreground hover:text-foreground",
        disabled && "cursor-not-allowed opacity-40 hover:text-muted-foreground",
      )}
    >
      {children}
    </button>
  );
}

function ProjectPicker({
  projects,
  project,
  onChange,
}: {
  projects: ProjectInfo[];
  project: string;
  onChange: (v: string) => void;
}) {
  if (projects.length === 0) {
    return <span className="text-xs text-muted-foreground">No projects added.</span>;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Project" className={cn(CONTROL, "gap-1.5 border")}>
          <Folder className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="max-w-44 truncate font-medium">{project}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {projects.map((p) => (
          <DropdownMenuItem key={p.name} onSelect={() => onChange(p.name)}>
            <span className="flex w-full items-center gap-2">
              <Check className={cn("size-3.5", project === p.name ? "opacity-100" : "opacity-0")} />
              <span className="truncate">{p.name}</span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
      className={cn(CONTROL, "gap-1.5 border", active ? ACTIVE_CONTROL : "text-muted-foreground")}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * Workflow template picker, shown only in `workflow` mode. Invalid templates
 * stay listed (with their parse error) so a typo in a project's YAML is visible
 * here rather than silently missing.
 */
export function WorkflowPicker({
  workflows,
  selected,
  onSelect,
  onEject,
}: {
  workflows: WorkflowMeta[];
  selected: WorkflowMeta | null;
  onSelect: (id: string | null) => void;
  onEject: (id: string) => void;
}) {
  // Radix closes the menu on pointer-up, so a nested <button> unmounts before
  // its click ever fires — the eject affordance has to be part of the menu
  // item and tell `onSelect` which of the two actions was aimed at. Keyboard
  // selection never sets this, so Enter always means "pick this pipeline".
  const ejecting = useRef(false);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Which pipeline to run"
          className={cn(
            "flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
            selected ? ACTIVE_CONTROL : "border-border text-muted-foreground",
          )}
        >
          <Route className="size-3.5 shrink-0" />
          <span className="max-w-40 truncate" title={selected?.name}>
            {selected ? selected.name : "Pick a pipeline"}
          </span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Pipelines
        </DropdownMenuLabel>
        {workflows.map((w) => (
          <DropdownMenuItem
            key={w.id}
            disabled={!w.valid}
            title={w.valid ? (w.warnings ?? []).join("\n") || undefined : (w.error ?? undefined)}
            onPointerDownCapture={(event) => {
              ejecting.current = !!(event.target as HTMLElement).closest("[data-eject]");
            }}
            onSelect={(event) => {
              if (!ejecting.current) {
                onSelect(w.id);
                return;
              }
              ejecting.current = false;
              // Stay open: the row redraws as a project workflow once the copy
              // lands, which is the confirmation that it worked.
              event.preventDefault();
              onEject(w.id);
            }}
          >
            <span className="flex w-full items-start gap-2">
              <Check
                className={cn(
                  "mt-0.5 size-3.5 shrink-0",
                  selected?.id === w.id ? "opacity-100" : "opacity-0",
                )}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-xs">{w.name}</span>
                  {w.source === "builtin" && (
                    <span className="shrink-0 rounded bg-secondary px-1 text-[10px] text-muted-foreground">
                      built-in
                    </span>
                  )}
                  {!w.valid && <AlertTriangle className="size-3 shrink-0 text-destructive" />}
                </span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {w.valid ? (w.stages ?? []).join(" → ") : (w.error ?? "invalid workflow")}
                </span>
              </span>
              {w.source === "builtin" && w.valid && (
                <span
                  data-eject
                  role="button"
                  title="Save an editable copy in .warpforge/workflows/"
                  aria-label={`Save ${w.name} into this project`}
                  className="ml-auto flex shrink-0 items-center self-center rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  <FileDown className="size-3.5" />
                </span>
              )}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
