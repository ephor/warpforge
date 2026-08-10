import { useQuery, useQueryClient } from "@tanstack/react-query";
import { History, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { AgentBadge } from "../components/AgentBadge";
import { AgentConfigBar } from "../components/AgentConfigBar";
import type { ComposerHandle } from "../components/Composer";
import { Composer } from "../components/Composer";
import { TaskComposeBar } from "../components/TaskComposeBar";
import { daemon } from "../daemon";
import type {
  ExternalSession,
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
}

/**
 * "New Task" full-screen overlay. Renders on top of the current view so
 * the underlying view state is preserved. Sending the first prompt
 * creates the task and closes the overlay.
 */
export default function NewTaskDialog({
  open,
  onOpenChange,
  snapshot,
  defaultProject,
  initialPrompt,
}: Props) {
  const queryClient = useQueryClient();
  const openTask = useUi((s) => s.openTask);
  const autoNameTasks = useUi((s) => s.autoNameTasks);
  const textGenAgentId = useUi((s) => s.textGenAgentId);
  const textGenModel = useUi((s) => s.textGenModel);

  const firstProjectName = snapshot.projects[0]?.name ?? "";
  const enabledAgents = useMemo(
    () => snapshot.agents?.filter((a) => a.enabled) ?? [],
    [snapshot.agents],
  );
  const [project, setProject] = useState(defaultProject ?? firstProjectName);
  const [selectedAgent, setSelectedAgent] = useState(enabledAgents[0]?.id ?? "claude");
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [configPicks, setConfigPicks] = useState<Record<string, string | undefined>>({});
  const [tags, setTags] = useState("");
  const [shareContext, setShareContext] = useState(true);
  const [useWorktree, setUseWorktree] = useState(false);
  const [orchChat, setOrchChat] = useState(false);
  const [workflow, setWorkflow] = useState<string | null>(null);
  const composerRef = useRef<ComposerHandle>(null);

  const agent = enabledAgents.some((candidate) => candidate.id === selectedAgent)
    ? selectedAgent
    : (enabledAgents[0]?.id ?? "claude");
  const currentAgent = (snapshot.agents ?? []).find((a) => a.id === agent);
  const agentOptions = currentAgent?.models ?? [];
  const probeLoading = !!currentAgent && currentAgent.enabled && agentOptions.length === 0;

  const changeProject = (nextProject: string) => {
    setProject(nextProject);
    setSelectedAgent(enabledAgents[0]?.id ?? "claude");
    setConfigPicks({});
    // Workflows are per-project files — a pick can't carry over.
    setWorkflow(null);
  };

  // A workflow and the orchestrator chat are different engines for the same
  // task, so picking one clears the other.
  const changeWorkflow = (next: string | null) => {
    setWorkflow(next);
    if (next) setOrchChat(false);
  };

  const changeOrchChat = (next: boolean) => {
    setOrchChat(next);
    if (next) setWorkflow(null);
  };

  const changeAgent = (nextAgent: string) => {
    setSelectedAgent(nextAgent);
    setConfigPicks({});
  };

  // Escape key closes overlay.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [open, onOpenChange]);

  const sessionsQuery = useQuery({
    enabled: !!project,
    queryFn: () => daemon.listSessions(project),
    queryKey: ["sessions", project],
  });
  const sessions = sessionsQuery.data ?? [];
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
  const selectedWorkflow = workflows.find((w) => w.id === workflow) ?? null;

  const ejectWorkflow = async (id: string) => {
    try {
      const path = await daemon.workflowEject(project, id);
      toast.success("Workflow copied to project", { description: path });
      await queryClient.invalidateQueries({ queryKey: ["workflows", project] });
    } catch (e) {
      toast.error("Could not copy workflow", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const resume = async (s: ExternalSession) => {
    try {
      const taskId = await daemon.resumeTask(project, s.agent, s.sessionId, s.title);
      if (!taskId) throw new Error("Warpforge did not return the resumed task id");
      openTask(taskId);
      onOpenChange(false);
    } catch (e) {
      toast.error("Could not resume the session", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const create = async (submission: PromptSubmission) => {
    if (!submission.text.trim() || !project) return;
    const userTags = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const modelOpt = agentOptions.find((opt) =>
      `${opt.category ?? ""} ${opt.id} ${opt.name}`.toLowerCase().includes("model"),
    );
    const modelPick = modelOpt ? configPicks[modelOpt.id] : undefined;
    // Forward all non-model picks as config_overrides so they're applied
    // via session/setConfigOption before the first prompt.
    const configOverrides: Record<string, string> = {};
    for (const opt of agentOptions) {
      if (opt.id === modelOpt?.id) continue;
      const pick = configPicks[opt.id];
      if (pick != null) configOverrides[opt.id] = pick;
    }
    let resp: unknown;
    try {
      resp = await daemon.request("task.create", {
        project,
        prompt: submission.text.trim(),
        attachments: submission.attachments,
        agent,
        tags: orchChat ? [...userTags, "orchestrator-chat"] : userTags,
        include_runtime_context: shareContext,
        worktree: orchChat ? false : useWorktree,
        default_model: modelPick,
        config_overrides: configOverrides,
        workflow: workflow ?? undefined,
      });
    } catch (e) {
      // A workflow can fail validation daemon-side (edited YAML between the
      // list and the send) — keep the dialog open so the prompt isn't lost.
      toast.error("Could not start the task", {
        description: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    const taskId =
      (resp as { taskId?: string } | null)?.taskId ??
      (resp as { result?: { taskId?: string } } | null)?.result?.taskId ??
      null;
    if (taskId) {
      openTask(taskId);
      toast.success(selectedWorkflow ? "Workflow started" : "Task started", {
        description: selectedWorkflow
          ? `${selectedWorkflow.name} pipeline running in ${project}`
          : `${orchChat ? "Orchestrator" : "Agent"} session created for ${project}`,
        action: {
          label: "Open task",
          onClick: () => openTask(taskId),
        },
        duration: 8000,
      });
      // Auto-generate a title asynchronously if enabled and an agent is picked.
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
            // Silently ignore — task creation must never feel slow or noisy.
          }
        })();
      }
    }
    onOpenChange(false);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <div className="flex h-full max-h-full w-full max-w-5xl flex-col px-4 py-4 sm:px-8 sm:py-6">
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
              Start from outcome
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight">New task</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Describe what you want to ship. Choose execution details only when they matter.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {selectedWorkflow
                ? `${selectedWorkflow.name} pipeline`
                : orchChat
                  ? "Orchestrator chat"
                  : "Single agent"}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={close}
              aria-label="Close"
              type="button"
            >
              <X className="size-4" />
            </Button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-4 pb-4">
            <section
              aria-labelledby="task-prompt-heading"
              className="rounded-lg border border-border/80 bg-card/25"
            >
              <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border/60 px-4 py-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    Prompt
                  </p>
                  <h2 id="task-prompt-heading" className="mt-1 text-base font-semibold">
                    What are you trying to ship?
                  </h2>
                </div>
                <span className="text-xs text-muted-foreground">
                  Attachments and @files supported
                </span>
              </div>
              <div className="px-2 pb-2 pt-1">
                <Composer
                  key={`${project}-${agent}`}
                  ref={composerRef}
                  initialValue={prompt}
                  onDraftChange={setPrompt}
                  files={projectFiles}
                  filesLoading={filesQuery.isLoading}
                  imageSupported
                  hideSendButton
                  onSend={create}
                  toolbar={
                    <AgentConfigBar
                      options={agentOptions}
                      picks={configPicks}
                      loading={probeLoading}
                      onSelect={(opt, value) =>
                        setConfigPicks((prev) => ({ ...prev, [opt.id]: value }))
                      }
                    />
                  }
                  placeholder={
                    selectedWorkflow
                      ? `What should the ${selectedWorkflow.name} pipeline work on?`
                      : orchChat
                        ? "What should the orchestrator coordinate?"
                        : "What should the agent do?"
                  }
                />
              </div>
              <div className="flex items-center gap-2 border-t border-border/60 px-4 py-2 text-xs text-muted-foreground">
                <label htmlFor="task-tags" className="shrink-0">
                  Tags
                </label>
                <input
                  id="task-tags"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="bug, frontend"
                  className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs"
                />
              </div>
            </section>

            <section
              aria-labelledby="task-execution-heading"
              className="rounded-lg border border-border/70 bg-card/15 px-4 py-3"
            >
              <div className="mb-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Execution context
                </p>
                <h2 id="task-execution-heading" className="mt-1 text-sm font-semibold">
                  Where and how should it run?
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Pick project, agent, runtime context, worktree, or an explicit pipeline.
                </p>
              </div>
              <TaskComposeBar
                projects={snapshot.projects}
                agents={snapshot.agents ?? []}
                services={snapshot.services}
                project={project}
                agent={agent}
                shareContext={shareContext}
                useWorktree={useWorktree}
                orchChat={orchChat}
                workflows={workflows}
                workflow={workflow}
                onProjectChange={changeProject}
                onAgentChange={changeAgent}
                onShareContextChange={setShareContext}
                onUseWorktreeChange={setUseWorktree}
                onOrchChatChange={changeOrchChat}
                onWorkflowChange={changeWorkflow}
                onEjectWorkflow={ejectWorkflow}
              />
            </section>

            {sessions.length > 0 && (
              <section aria-labelledby="resume-session-heading" className="rounded-lg border">
                <div className="flex items-center gap-1.5 border-b px-3 py-2 text-xs text-muted-foreground">
                  <History className="size-3.5" />
                  <h2 id="resume-session-heading" className="font-medium">
                    Resume a previous session
                  </h2>
                </div>
                <div className="max-h-56 overflow-y-auto">
                  {sessions.map((s) => (
                    <button
                      key={`${s.agent}:${s.sessionId}`}
                      type="button"
                      onClick={() => void resume(s)}
                      className="flex w-full items-center gap-2 overflow-hidden border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-secondary"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {s.title || `(untitled ${s.sessionId.slice(0, 8)})`}
                      </span>
                      <AgentBadge
                        agentId={s.agent}
                        size="xs"
                        className="shrink-0 text-muted-foreground"
                      />
                      <span className="tnum shrink-0 text-xs text-muted-foreground">
                        {new Date(s.updatedAt * 1000).toLocaleDateString()}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        </main>

        <footer className="flex items-center justify-end gap-2 border-t border-border/70 pt-4">
          <Button variant="ghost" onClick={close} type="button">
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => composerRef.current?.submit()}
            disabled={!prompt.trim() || !project}
          >
            {selectedWorkflow ? "Start workflow" : orchChat ? "Start orchestrator" : "Start task"}
          </Button>
        </footer>
      </div>
    </div>
  );
}
