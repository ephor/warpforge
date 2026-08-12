import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Folder, GitBranch, Share2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { agentDisplayName } from "@/lib/agentNames";
import { cn } from "@/lib/utils";

import { AgentConfigBar } from "../components/AgentConfigBar";
import { AgentLogo } from "../components/AgentLogo";
import type { ComposerHandle } from "../components/Composer";
import { Composer } from "../components/Composer";
import { RunPreview } from "../components/RunPreview";
import type { TaskMode } from "../components/TaskComposeBar";
import { WorkflowPicker } from "../components/TaskComposeBar";
import { daemon } from "../daemon";
import type {
  AgentConfig,
  GitBranchList,
  ProjectFile,
  PromptSubmission,
  Snapshot,
  WorkflowMeta,
} from "../protocol";
import { daemonQuery } from "../query";
import { useUi } from "../store/ui";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  snapshot: Snapshot;
  defaultProject: string | null;
  initialPrompt?: string;
  /** Backlog item this task is being started from, if any. The created task is
   *  linked to it so the board can show (and reopen) the run it produced. */
  backlogItemId?: string | null;
}

/**
 * New-task surface. It is mounted inside the app shell rather than in a modal
 * portal: the sidebar remains available, while this transient state replaces
 * the current main view. Sending the first prompt creates the task and closes
 * the surface.
 */
export default function NewTaskDialog({
  open,
  onOpenChange,
  snapshot,
  defaultProject,
  initialPrompt,
  backlogItemId,
}: Props) {
  const queryClient = useQueryClient();
  const openTask = useUi((s) => s.openTask);
  const autoNameTasks = useUi((s) => s.autoNameTasks);
  const textGenAgentId = useUi((s) => s.textGenAgentId);
  const textGenModel = useUi((s) => s.textGenModel);

  const firstProjectName = snapshot.projects[0]?.name ?? "";
  const enabledAgents = useMemo(
    () => snapshot.agents?.filter((candidate) => candidate.enabled) ?? [],
    [snapshot.agents],
  );
  const [project, setProject] = useState(defaultProject ?? firstProjectName);
  const [selectedAgent, setSelectedAgent] = useState(enabledAgents[0]?.id ?? "claude");
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [configPicks, setConfigPicks] = useState<Record<string, string | undefined>>({});
  const [tags, setTags] = useState("");
  const [shareContext, setShareContext] = useState(true);
  const useWorktree = useUi((s) => s.newTaskWorktree);
  const setUseWorktree = useUi((s) => s.setNewTaskWorktree);
  const [mode, setMode] = useState<TaskMode>("single");
  const [workflow, setWorkflow] = useState<string | null>(null);
  const composerRef = useRef<ComposerHandle>(null);

  const agent = enabledAgents.some((candidate) => candidate.id === selectedAgent)
    ? selectedAgent
    : (enabledAgents[0]?.id ?? "claude");
  const currentAgent = (snapshot.agents ?? []).find((candidate) => candidate.id === agent);
  const agentOptions = currentAgent?.models ?? [];
  const probeLoading = !!currentAgent && currentAgent.enabled && agentOptions.length === 0;

  const branchQuery = useQuery({
    enabled: open && !!project,
    queryFn: daemonQuery<GitBranchList>("git.branches", { project }),
    queryKey: ["branches", "project", project],
  });
  const branch = branchQuery.data?.current ?? null;
  const filesQuery = useQuery({
    enabled: !!project,
    queryFn: daemonQuery<ProjectFile[]>("file.list", { project }),
    queryKey: ["fileList", "new", project],
  });
  const projectFiles = Array.isArray(filesQuery.data) ? filesQuery.data : [];
  const workflowsQuery = useQuery({
    enabled: !!project,
    queryFn: () => daemon.workflowList(project),
    queryKey: ["workflows", project],
  });
  const workflows: WorkflowMeta[] = workflowsQuery.data ?? [];
  const selectedWorkflow = workflows.find((candidate) => candidate.id === workflow) ?? null;

  const changeProject = (nextProject: string) => {
    setProject(nextProject);
    // Only the workflow is project-scoped, so only the workflow is dropped.
    // Realising you picked the wrong project must not cost you the harness,
    // the model picks or the prompt you already typed.
    setWorkflow(null);
    setMode((current) => (current === "workflow" ? "single" : current));
  };

  const changeAgent = (nextAgent: string) => {
    setSelectedAgent(nextAgent);
    // Config options are the harness's own selectors, so these cannot survive.
    setConfigPicks({});
  };

  const changeWorkflow = (nextWorkflow: string | null) => {
    setWorkflow(nextWorkflow);
    setMode(nextWorkflow ? "workflow" : "single");
  };

  const changeMode = (next: string) => {
    if (next !== "single" && next !== "orchestrator" && next !== "workflow") return;
    if (next === "workflow") {
      const firstValidWorkflow = workflows.find((candidate) => candidate.valid);
      if (!firstValidWorkflow) return;
      setWorkflow((current) => current ?? firstValidWorkflow.id);
    } else {
      setWorkflow(null);
    }
    setMode(next);
  };

  const ejectWorkflow = async (id: string) => {
    try {
      const path = await daemon.workflowEject(project, id);
      toast.success("Workflow copied to project", { description: path });
      await queryClient.invalidateQueries({ queryKey: ["workflows", project] });
    } catch (error) {
      toast.error("Could not copy workflow", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [close, open]);

  const create = async (submission: PromptSubmission) => {
    if (!submission.text.trim() || !project) return;
    const userTags = tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    const modelOpt = agentOptions.find((option) =>
      ((option.category ?? "") + " " + option.id + " " + option.name)
        .toLowerCase()
        .includes("model"),
    );
    const modelPick = modelOpt ? configPicks[modelOpt.id] : undefined;
    // Forward all non-model picks as config_overrides so they are applied via
    // session/setConfigOption before the first prompt.
    const configOverrides: Record<string, string> = {};
    for (const option of agentOptions) {
      if (option.id === modelOpt?.id) continue;
      const pick = configPicks[option.id];
      if (pick != null) configOverrides[option.id] = pick;
    }

    let response: unknown;
    try {
      response = await daemon.request("task.create", {
        project,
        prompt: submission.text.trim(),
        attachments: submission.attachments,
        agent,
        tags: mode === "orchestrator" ? [...userTags, "orchestrator-chat"] : userTags,
        include_runtime_context: shareContext,
        worktree: mode === "orchestrator" ? false : useWorktree,
        default_model: modelPick,
        config_overrides: configOverrides,
        workflow: workflow ?? undefined,
        backlog_item_id: backlogItemId ?? undefined,
      });
    } catch (error) {
      // A workflow can fail validation daemon-side after the list loads; keep
      // the surface open so the prompt is not lost.
      toast.error("Could not start the task", {
        description: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const taskId =
      (response as { taskId?: string } | null)?.taskId ??
      (response as { result?: { taskId?: string } } | null)?.result?.taskId ??
      null;
    if (!taskId) {
      close();
      return;
    }
    if (backlogItemId) {
      try {
        await daemon.linkWorkItemTask(backlogItemId, taskId);
        void queryClient.invalidateQueries({ queryKey: ["backlog", project] });
      } catch (error) {
        // The task itself succeeded; a failed link must not strand the user
        // on a still-open dialog with no task opened. Report it and continue.
        toast.error("Task started, but linking it to the backlog item failed", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    }
    openTask(taskId);
    toast.success(selectedWorkflow ? "Workflow started" : "Task started", {
      description: selectedWorkflow
        ? selectedWorkflow.name + " pipeline running in " + project
        : (mode === "orchestrator" ? "Orchestrator" : "Agent") + " session created for " + project,
      action: {
        label: "Open task",
        onClick: () => openTask(taskId),
      },
      duration: 8000,
    });
    if (autoNameTasks && textGenAgentId) {
      void (async () => {
        try {
          const generated = await daemon.generateText(
            taskId,
            textGenAgentId,
            "task_title",
            textGenModel ?? undefined,
          );
          if (generated?.trim()) {
            await daemon.setTaskTitle(taskId, generated.trim().slice(0, 80));
          }
        } catch {
          // Task creation should never feel slow or noisy.
        }
      })();
    }
    close();
  };

  const selectedProject = snapshot.projects.find((candidate) => candidate.name === project) ?? null;
  const agentChoices: AgentConfig[] =
    enabledAgents.length > 0
      ? enabledAgents
      : [{ acpCommand: "claude", displayName: "Claude", enabled: true, id: "claude", models: [] }];
  const runningForProject = snapshot.services.filter(
    (service) =>
      service.project === project && service.status === "running" && service.allocatedPort > 0,
  );
  const hasValidWorkflows = workflows.some((candidate) => candidate.valid);
  const canStart = !!prompt.trim() && !!project && (mode !== "workflow" || !!selectedWorkflow);
  const startLabel =
    mode === "workflow"
      ? "Start workflow"
      : mode === "orchestrator"
        ? "Start orchestrator"
        : "Start task";
  const workspaceLine =
    mode === "orchestrator"
      ? "Lead and workers share your current checkout."
      : useWorktree
        ? "Runs in an isolated git worktree."
        : "Runs in your current checkout.";

  if (!open) return null;

  return (
    <div data-testid="new-task-page" className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          New task
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          onClick={close}
          aria-label="Close new task"
          title="Close (Esc)"
          type="button"
        >
          <X className="size-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[1100px] flex-col justify-center gap-6 px-4 pb-14 sm:px-6">
          {/* Nothing between the title and the composer may appear or disappear
              with the mode: this block anchors the screen, and the pipeline
              picker lives in the run-context row below instead. */}
          <div className="flex flex-col items-center gap-3">
            <h1 className="text-center text-2xl font-semibold tracking-tight">
              What are you trying to ship?
            </h1>
            <ModeSelector mode={mode} hasValidWorkflows={hasValidWorkflows} onChange={changeMode} />
          </div>

          {/* The composer is the only bordered island on this screen: everything
              else — mode, run context, tags — sits flat on the canvas so the eye
              lands on the one thing that has to be filled in. */}
          <div>
            {/* No `key` here on purpose: remounting the composer when the
                project or harness changes threw away the prompt already typed. */}
            <Composer
              ref={composerRef}
              className="p-0"
              initialValue={prompt}
              onDraftChange={setPrompt}
              files={projectFiles}
              filesLoading={filesQuery.isLoading}
              imageSupported
              hideSendButton
              onSend={create}
              toolbar={
                <>
                  <ProjectChip
                    projects={snapshot.projects}
                    project={project}
                    title={
                      selectedProject
                        ? selectedProject.path +
                          " · ports " +
                          selectedProject.portRange[0] +
                          "–" +
                          selectedProject.portRange[1]
                        : "Choose a project"
                    }
                    onChange={changeProject}
                  />
                  <HarnessChip
                    agents={agentChoices}
                    agent={agent}
                    title={
                      currentAgent
                        ? "Runs " + currentAgent.acpCommand + " for this task"
                        : "Choose a harness"
                    }
                    onChange={changeAgent}
                  />
                  <ChipDivider />
                  <AgentConfigBar
                    options={agentOptions}
                    picks={configPicks}
                    loading={probeLoading}
                    onSelect={(option, value) =>
                      setConfigPicks((previous) => ({ ...previous, [option.id]: value }))
                    }
                  />
                  <ChipDivider />
                  <ToggleChip
                    active={useWorktree && mode !== "orchestrator"}
                    disabled={mode === "orchestrator"}
                    icon={GitBranch}
                    label="Worktree"
                    title={
                      mode === "orchestrator"
                        ? "An orchestrator and its workers share your current checkout."
                        : "Run in an isolated git worktree. Remembered for the next task."
                    }
                    onClick={() => setUseWorktree(!useWorktree)}
                  />
                  <ToggleChip
                    active={shareContext}
                    icon={Share2}
                    label="Services"
                    title={
                      runningForProject.length > 0
                        ? "Agent sees " +
                          runningForProject
                            .map((service) => service.name + ":" + service.allocatedPort)
                            .join(", ")
                        : "No services running for this project."
                    }
                    onClick={() => setShareContext((current) => !current)}
                  />
                </>
              }
              placeholder={
                selectedWorkflow
                  ? "What should the " + selectedWorkflow.name + " pipeline work on?"
                  : mode === "orchestrator"
                    ? "What should the orchestrator coordinate?"
                    : "What should the agent do?"
              }
            />

            <div className="mt-2 flex h-8 items-center gap-2">
              {mode === "workflow" && (
                <WorkflowPicker
                  workflows={workflows}
                  selected={selectedWorkflow}
                  onSelect={changeWorkflow}
                  onEject={ejectWorkflow}
                />
              )}
              <p
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-1.5 text-[11px]",
                  mode === "workflow" && !selectedWorkflow ? "text-warn" : "text-muted-foreground",
                )}
              >
                {mode === "workflow" && !selectedWorkflow ? (
                  <span className="truncate">Select a valid workflow before starting.</span>
                ) : (
                  <>
                    {branch && (
                      <>
                        <GitBranch aria-hidden className="size-3 shrink-0" />
                        <span className="max-w-48 truncate font-medium text-foreground/75">
                          {branch}
                        </span>
                        <span aria-hidden>·</span>
                      </>
                    )}
                    <span className="truncate">{workspaceLine}</span>
                  </>
                )}
              </p>
              <label htmlFor="task-tags" className="sr-only">
                Tags
              </label>
              <input
                id="task-tags"
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                placeholder="Tags"
                className="h-8 w-28 shrink-0 rounded-md bg-transparent px-2 text-xs transition-colors placeholder:text-muted-foreground/70 hover:bg-secondary/60 focus-visible:bg-secondary/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <Button
                type="button"
                size="sm"
                onClick={() => composerRef.current?.submit()}
                disabled={!canStart}
                className="h-8 shrink-0"
              >
                {startLabel}
              </Button>
            </div>
          </div>

          {/* Reserved so that switching modes — or landing in Workflow with no
              pipeline picked yet, where the preview has nothing to draw — never
              re-centres the column above it. */}
          <div className="min-h-[4.5rem]">
            <RunPreview
              agent={agent}
              agents={agentChoices}
              mode={mode}
              workflow={selectedWorkflow}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Deliberately the same shape and weight as `AgentConfigBar`'s selectors —
 *  these sit in the same toolbar row, so anything heavier makes the project and
 *  harness pickers read as a different kind of control than the model picker. */
const CHIP =
  "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground";
const CHIP_ACTIVE = "bg-secondary text-foreground";

const MODES: { id: TaskMode; label: string }[] = [
  { id: "single", label: "Single agent" },
  { id: "orchestrator", label: "Orchestrator" },
  { id: "workflow", label: "Workflow" },
];

function ModeSelector({
  hasValidWorkflows,
  mode,
  onChange,
}: {
  hasValidWorkflows: boolean;
  mode: TaskMode;
  onChange: (next: TaskMode) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Execution mode"
      className="flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg bg-card p-0.5"
    >
      {MODES.map(({ id, label }) => {
        const disabled = id === "workflow" && !hasValidWorkflows;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={mode === id}
            disabled={disabled}
            title={disabled ? "This project has no valid workflows" : undefined}
            onClick={() => onChange(id)}
            className={cn(
              "h-7 shrink-0 rounded-md px-3 text-xs transition-colors",
              mode === id
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground",
              disabled && "cursor-not-allowed opacity-40 hover:text-muted-foreground",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function ChipDivider() {
  return <span aria-hidden className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />;
}

function ProjectChip({
  onChange,
  project,
  projects,
  title,
}: {
  onChange: (next: string) => void;
  project: string;
  projects: Snapshot["projects"];
  title: string;
}) {
  if (projects.length === 0) {
    return <span className="px-1.5">No projects added.</span>;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Project" title={title} className={CHIP}>
          <Folder aria-hidden className="size-3 shrink-0" />
          <span className="max-w-32 truncate">{project}</span>
          <ChevronDown aria-hidden className="size-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {projects.map((candidate) => (
          <DropdownMenuItem
            key={candidate.name}
            className="text-xs"
            onSelect={() => onChange(candidate.name)}
          >
            <Check
              aria-hidden
              className={cn("size-3.5 shrink-0", project === candidate.name ? "" : "opacity-0")}
            />
            <span className="truncate">{candidate.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function HarnessChip({
  agent,
  agents,
  onChange,
  title,
}: {
  agent: string;
  agents: AgentConfig[];
  onChange: (next: string) => void;
  title: string;
}) {
  const current = agents.find((candidate) => candidate.id === agent);
  const currentName = agentDisplayName(agent, current?.displayName);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Harness" title={title} className={CHIP}>
          <AgentLogo agentId={agent} displayName={currentName} className="size-3.5 shrink-0" />
          <span className="max-w-32 truncate">{currentName}</span>
          <ChevronDown aria-hidden className="size-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {agents.map((candidate) => {
          const name = agentDisplayName(candidate.id, candidate.displayName);
          return (
            <DropdownMenuItem
              key={candidate.id}
              className="text-xs"
              onSelect={() => onChange(candidate.id)}
            >
              <AgentLogo agentId={candidate.id} displayName={name} className="size-3.5 shrink-0" />
              <span className="flex-1 truncate">{name}</span>
              {agent === candidate.id && <Check aria-hidden className="size-3.5 shrink-0" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ToggleChip({
  active,
  disabled = false,
  icon: Icon,
  label,
  onClick,
  title,
}: {
  active: boolean;
  disabled?: boolean;
  icon: typeof GitBranch;
  label: string;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={title}
      className={cn(CHIP, active && CHIP_ACTIVE)}
    >
      <Icon aria-hidden className={cn("size-3 shrink-0", active && "text-primary")} />
      {label}
    </button>
  );
}
