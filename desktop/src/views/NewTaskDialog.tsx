import { useQuery } from "@tanstack/react-query";
import { History, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import type { ComposerHandle } from "../components/Composer";
import { Composer } from "../components/Composer";
import { AgentConfigBar } from "../components/AgentConfigBar";
import { TaskComposeBar } from "../components/TaskComposeBar";
import { daemon } from "../daemon";
import { daemonQuery } from "../query";
import type {
  ExternalSession,
  ProjectFile,
  PromptSubmission,
  Snapshot,
} from "../protocol";
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
export default function NewTaskDialog({ open, onOpenChange, snapshot, defaultProject, initialPrompt }: Props) {
  const openTask = useUi((s) => s.openTask);
  const autoNameTasks = useUi((s) => s.autoNameTasks);
  const textGenAgentId = useUi((s) => s.textGenAgentId);
  const textGenModel = useUi((s) => s.textGenModel);

  const firstProjectName = snapshot.projects[0]?.name ?? "";
  const [project, setProject] = useState(defaultProject ?? firstProjectName);
  const [agent, setAgent] = useState("");
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [configPicks, setConfigPicks] = useState<Record<string, string | undefined>>({});
  const [tags, setTags] = useState("");
  const [shareContext, setShareContext] = useState(true);
  const [useWorktree, setUseWorktree] = useState(false);
  const [orchChat, setOrchChat] = useState(false);
  const composerRef = useRef<ComposerHandle>(null);

  const enabledAgents = useMemo(
    () => snapshot.agents?.filter((a) => a.enabled) ?? [],
    [snapshot.agents],
  );
  const currentAgent = (snapshot.agents ?? []).find((a) => a.id === agent);
  const agentOptions = currentAgent?.models ?? [];
  const probeLoading = !!currentAgent && currentAgent.enabled && agentOptions.length === 0;

  // Reset selections when the overlay is (re)opened with new defaults.
  useEffect(() => {
    if (open) {
      setProject(defaultProject ?? firstProjectName);
      setPrompt(initialPrompt ?? "");
      setConfigPicks({});
      setTags("");
      setOrchChat(false);
    }
  }, [open, defaultProject, firstProjectName, initialPrompt]);

  useEffect(() => {
    setAgent(enabledAgents[0]?.id ?? "claude");
  }, [enabledAgents, project]);

  useEffect(() => {
    setConfigPicks({});
  }, [agent]);

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

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const resume = (s: ExternalSession) => {
    void daemon.resumeTask(project, s.agent, s.sessionId, s.title);
    onOpenChange(false);
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
    const resp = await daemon.request("task.create", {
      project,
      prompt: submission.text.trim(),
      attachments: submission.attachments,
      agent,
      tags: orchChat ? [...userTags, "orchestrator-chat"] : userTags,
      include_runtime_context: shareContext,
      worktree: orchChat ? false : useWorktree,
      default_model: modelPick,
      config_overrides: configOverrides,
    });
    const taskId =
      (resp as { taskId?: string } | null)?.taskId ??
      (resp as { result?: { taskId?: string } } | null)?.result?.taskId ??
      null;
    if (taskId) {
      toast.success("Task started", {
        description: `${orchChat ? "Orchestrator" : "Agent"} session created for ${project}`,
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
      <div className="flex h-full max-h-full w-full max-w-3xl flex-col px-8 py-8">
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-lg font-semibold">New task</h1>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              One task = one agent session. The agent starts working immediately.
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

        <div className="flex min-h-0 flex-1 flex-col">
          <TaskComposeBar
            projects={snapshot.projects}
            agents={snapshot.agents ?? []}
            services={snapshot.services}
            project={project}
            agent={agent}
            shareContext={shareContext}
            useWorktree={useWorktree}
            orchChat={orchChat}
            onProjectChange={setProject}
            onAgentChange={setAgent}
            onShareContextChange={setShareContext}
            onUseWorktreeChange={setUseWorktree}
            onOrchChatChange={setOrchChat}
          />

          <div className="mt-6 border-t border-border/70 pt-4">
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
                orchChat ? "What should the orchestrator coordinate?" : "What should the agent do?"
              }
            />
          </div>

          {/* Tags (collapsed, optional) */}
          <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
            <span>Tags</span>
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="bug, frontend"
              className="h-7 flex-1 rounded-md border border-input bg-background px-2 text-xs"
            />
          </div>

          {sessions.length > 0 && (
            <div className="mt-6 flex min-h-0 flex-1 flex-col gap-1.5">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <History className="size-3.5" />
                Resume a previous session
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
                {sessions.map((s) => (
                  <button
                    key={`${s.agent}:${s.sessionId}`}
                    type="button"
                    onClick={() => resume(s)}
                    className="flex w-full items-center gap-2 overflow-hidden border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-secondary"
                  >
                    <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                      {s.agent}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {s.title || `(untitled ${s.sessionId.slice(0, 8)})`}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {new Date(s.updatedAt * 1000).toLocaleDateString()}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <footer className="mt-6 flex items-center justify-end gap-2 border-t border-border/70 pt-4">
          <Button variant="ghost" onClick={close} type="button">
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => composerRef.current?.submit()}
            disabled={!prompt.trim() || !project}
          >
            {orchChat ? "Start orchestrator" : "Start task"}
          </Button>
        </footer>
      </div>
    </div>
  );
}
