import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Share2, History, GitBranch, GitMerge } from "lucide-react";
import { daemon } from "../daemon";
import { ExternalSession, OrchestratorConfig, Snapshot } from "../protocol";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  snapshot: Snapshot;
  defaultProject: string | null;
  initialPrompt?: string;
}

const DEFAULT_ORCH: OrchestratorConfig = {
  plannerAgent: "claude",
  workerPool: [],
  reviewerPool: [],
  worktreesEnabled: true,
};

export default function NewTaskDialog({
  open,
  onOpenChange,
  snapshot,
  defaultProject,
  initialPrompt,
}: Props) {
  const [project, setProject] = useState(defaultProject ?? snapshot.projects[0]?.name ?? "");
  const [agent, setAgent] = useState("");
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [tags, setTags] = useState("");
  const [shareContext, setShareContext] = useState(true);
  const [useWorktree, setUseWorktree] = useState(false);
  const [orchestrate, setOrchestrate] = useState(false);
  // Chat orchestrator (B): a lead agent that delegates to sub-agents and
  // processes their results in one conversation. Distinct from the deterministic
  // "orchestrate" pipeline above.
  const [orchChat, setOrchChat] = useState(false);
  const [orch, setOrch] = useState<OrchestratorConfig>(DEFAULT_ORCH);
  const [orchLoaded, setOrchLoaded] = useState(false);

  const projectInfo = snapshot.projects.find((p) => p.name === project);
  const agentOptions =
    snapshot.agents && snapshot.agents.length > 0
      ? snapshot.agents
          .filter((a) => a.enabled)
          .map((a) => ({ id: a.id, label: a.displayName }))
      : (projectInfo ? Object.keys(projectInfo.agentTemplates) : []).map((id) => ({
          id,
          label: id,
        }));
  const agentIds = agentOptions.map((a) => a.id);
  const running = snapshot.services.filter(
    (s) => s.project === project && s.status === "running" && s.allocatedPort > 0,
  );

  useEffect(() => {
    if (open) {
      setProject(defaultProject ?? snapshot.projects[0]?.name ?? "");
      setPrompt(initialPrompt ?? "");
      setTags("");
      setOrchestrate(false);
      setOrchChat(false);
      setOrchLoaded(false);
    }
  }, [open, defaultProject, initialPrompt]);

  useEffect(() => {
    setAgent(agentOptions[0]?.id ?? "claude");
  }, [project]);

  useEffect(() => {
    if (orchestrate && !orchLoaded) {
      void daemon.orchestrateGetConfig().then((c) => {
        setOrch(c);
        setOrchLoaded(true);
      });
    }
  }, [orchestrate, orchLoaded]);

  const sessionsQuery = useQuery({
    queryKey: ["sessions", project],
    queryFn: () => daemon.listSessions(project),
    enabled: open && !!project,
  });
  const sessions = sessionsQuery.data ?? [];

  const resume = (s: ExternalSession) => {
    void daemon.resumeTask(project, s.agent, s.sessionId, s.title);
    onOpenChange(false);
  };

  const create = async () => {
    if (!prompt.trim() || !project) return;
    if (orchestrate) {
      await daemon.orchestrateSaveConfig(orch);
      void daemon.orchestrateStart(project, prompt.trim());
    } else {
      const userTags = tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      void daemon.request("task.create", {
        project,
        prompt: prompt.trim(),
        agent,
        // The "orchestrator-chat" tag makes the daemon wire the warpforge MCP
        // bridge (spawn_agent / read_inbox) into this session.
        tags: orchChat ? [...userTags, "orchestrator-chat"] : userTags,
        include_runtime_context: shareContext,
        worktree: orchChat ? false : useWorktree,
      });
    }
    onOpenChange(false);
  };

  const toggleWorkerPool = (agentId: string) =>
    setOrch((c) => {
      const has = c.workerPool.some((e) => e.agent === agentId);
      return {
        ...c,
        workerPool: has
          ? c.workerPool.filter((e) => e.agent !== agentId)
          : [...c.workerPool, { agent: agentId }],
      };
    });

  const toggleReviewerPool = (agentId: string) =>
    setOrch((c) => {
      const has = c.reviewerPool.some((e) => e.agent === agentId);
      return {
        ...c,
        reviewerPool: has
          ? c.reviewerPool.filter((e) => e.agent !== agentId)
          : [...c.reviewerPool, { agent: agentId }],
      };
    });

  const isWorker = (id: string) => orch.workerPool.some((e) => e.agent === id);
  const isReviewer = (id: string) => orch.reviewerPool.some((e) => e.agent === id);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            One task = one agent session. The agent starts working immediately.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* Project */}
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Project
            <Select value={project} onValueChange={setProject}>
              <SelectTrigger>
                <SelectValue placeholder="Select project" />
              </SelectTrigger>
              <SelectContent>
                {snapshot.projects.map((p) => (
                  <SelectItem key={p.name} value={p.name}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          {/* Agent selector OR pipeline config */}
          {orchestrate && orchLoaded ? (
            <div className="flex flex-col gap-2 rounded-md border border-primary/30 bg-primary/[0.02] p-3">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <GitMerge className="size-4 text-primary" />
                Pipeline
              </div>

              {/* Planner */}
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Planner
                <Select
                  value={orch.plannerAgent}
                  onValueChange={(v: string) => setOrch((c) => ({ ...c, plannerAgent: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {agentIds.map((a) => (
                      <SelectItem key={a} value={a}>
                        {a}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>

              {/* Worker pool — toggles */}
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  Worker pool — planner picks from these
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {agentIds.map((id) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => toggleWorkerPool(id)}
                      className={cn(
                        "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                        isWorker(id)
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border text-muted-foreground hover:border-muted-foreground",
                      )}
                    >
                      {id}
                    </button>
                  ))}
                </div>
                {orch.workerPool.length === 0 && (
                  <p className="text-[11px] text-muted-foreground/60">
                    No workers selected — planner will have no one to delegate to.
                  </p>
                )}
              </div>

              {/* Reviewer pool — toggles */}
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  Reviewer pool — cross-vendor quality checks
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {agentIds.map((id) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => toggleReviewerPool(id)}
                      className={cn(
                        "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                        isReviewer(id)
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border text-muted-foreground hover:border-muted-foreground",
                      )}
                    >
                      {id}
                    </button>
                  ))}
                </div>
                {orch.reviewerPool.length === 0 && (
                  <p className="text-[11px] text-muted-foreground/60">
                    No reviewers — results won&apos;t be cross-checked.
                  </p>
                )}
              </div>

              {/* Worktrees toggle */}
              <button
                type="button"
                onClick={() => setOrch((c) => ({ ...c, worktreesEnabled: !c.worktreesEnabled }))}
                className={cn(
                  "flex items-center gap-2 rounded-md border p-2 text-xs transition-colors",
                  orch.worktreesEnabled
                    ? "border-primary/40 bg-primary/5 text-foreground"
                    : "border-border text-muted-foreground",
                )}
              >
                <div
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded border",
                    orch.worktreesEnabled ? "border-primary bg-primary" : "border-muted-foreground",
                  )}
                >
                  {orch.worktreesEnabled && <div className="size-1.5 rounded-sm bg-primary-foreground" />}
                </div>
                <GitBranch className="size-3.5" />
                Worktrees for workers
              </button>
            </div>
          ) : (
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Agent
              <Select value={agent} onValueChange={setAgent}>
                <SelectTrigger>
                  <SelectValue placeholder="Agent" />
                </SelectTrigger>
                <SelectContent>
                  {(agentOptions.length
                    ? agentOptions
                    : [{ id: "claude", label: "Claude" }]
                  ).map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}

          {/* Prompt */}
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Prompt
            <Textarea
              autoFocus
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should the agent do?"
              className="min-h-[90px]"
            />
          </label>

          {/* Tags */}
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Tags (comma-separated)
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="bug, frontend"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>

          {/* Toggles: share context + worktree + orchestrate */}
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setShareContext((v) => !v)}
              className={cn(
                "flex items-start gap-3 rounded-md border p-3 text-left transition-colors",
                shareContext ? "border-primary/40 bg-primary/5" : "border-border",
              )}
            >
              <div
                className={cn(
                  "mt-0.5 flex size-4 items-center justify-center rounded border",
                  shareContext ? "border-primary bg-primary" : "border-muted-foreground",
                )}
              >
                {shareContext && <div className="size-2 rounded-sm bg-primary-foreground" />}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  <Share2 className="size-3.5 text-primary" />
                  Share running services
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {running.length > 0
                    ? `Agent will see ${running.map((s) => `${s.name}:${s.allocatedPort}`).join(", ")}`
                    : "No services running for this project."}
                </p>
              </div>
            </button>

            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setUseWorktree((v) => !v)}
                className={cn(
                  "flex items-center gap-3 rounded-md border p-2.5 text-left transition-colors",
                  useWorktree ? "border-primary/40 bg-primary/5" : "border-border",
                )}
              >
                <div
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded border",
                    useWorktree ? "border-primary bg-primary" : "border-muted-foreground",
                  )}
                >
                  {useWorktree && <div className="size-2 rounded-sm bg-primary-foreground" />}
                </div>
                <div>
                  <div className="text-sm font-medium">
                    <GitBranch className="mr-1 inline size-3.5 text-primary" />
                    Worktree
                  </div>
                  <p className="text-[11px] text-muted-foreground">Isolated git worktree</p>
                </div>
              </button>

              <button
                type="button"
                onClick={() =>
                  setOrchestrate((v) => {
                    if (!v) setOrchChat(false);
                    return !v;
                  })
                }
                className={cn(
                  "flex items-center gap-3 rounded-md border p-2.5 text-left transition-colors",
                  orchestrate ? "border-primary/40 bg-primary/5" : "border-border",
                )}
              >
                <div
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded border",
                    orchestrate ? "border-primary bg-primary" : "border-muted-foreground",
                  )}
                >
                  {orchestrate && <div className="size-2 rounded-sm bg-primary-foreground" />}
                </div>
                <div>
                  <div className="text-sm font-medium">
                    <GitMerge className="mr-1 inline size-3.5 text-primary" />
                    Pipeline
                  </div>
                  <p className="text-[11px] text-muted-foreground">Planner → workers</p>
                </div>
              </button>

              <button
                type="button"
                onClick={() =>
                  setOrchChat((v) => {
                    if (!v) setOrchestrate(false);
                    return !v;
                  })
                }
                className={cn(
                  "flex items-center gap-3 rounded-md border p-2.5 text-left transition-colors",
                  orchChat ? "border-primary/40 bg-primary/5" : "border-border",
                )}
              >
                <div
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded border",
                    orchChat ? "border-primary bg-primary" : "border-muted-foreground",
                  )}
                >
                  {orchChat && <div className="size-2 rounded-sm bg-primary-foreground" />}
                </div>
                <div>
                  <div className="text-sm font-medium">
                    <GitMerge className="mr-1 inline size-3.5 text-primary" />
                    Orchestrator
                  </div>
                  <p className="text-[11px] text-muted-foreground">Chat + sub-agents</p>
                </div>
              </button>
            </div>
          </div>

          {/* Resume session */}
          {sessions.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <History className="size-3.5" />
                Resume a previous session
              </div>
              <div className="max-h-40 overflow-y-auto rounded-md border">
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

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={create} disabled={!prompt.trim() || !project}>
            {orchestrate ? "Start orchestration" : orchChat ? "Start orchestrator" : "Start task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
