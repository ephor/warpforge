import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Share2, History, GitBranch, GitMerge } from "lucide-react";
import { daemon } from "../daemon";
import { ExternalSession, ProjectFile, PromptSubmission, Snapshot } from "../protocol";
import { daemonQuery } from "../query";
import { Composer, ComposerHandle } from "../components/Composer";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
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
  // Chat orchestrator: the selected agent becomes a lead that delegates to
  // sub-agents (via the spawn_agent / read_inbox MCP tools) and processes their
  // results in one conversation. Tag "orchestrator-chat" wires the bridge.
  const [orchChat, setOrchChat] = useState(false);
  const composerRef = useRef<ComposerHandle>(null);

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
  const running = snapshot.services.filter(
    (s) => s.project === project && s.status === "running" && s.allocatedPort > 0,
  );

  useEffect(() => {
    if (open) {
      setProject(defaultProject ?? snapshot.projects[0]?.name ?? "");
      setPrompt(initialPrompt ?? "");
      setTags("");
      setOrchChat(false);
    }
  }, [open, defaultProject, initialPrompt]);

  useEffect(() => {
    setAgent(agentOptions[0]?.id ?? "claude");
  }, [project]);

  const sessionsQuery = useQuery({
    queryKey: ["sessions", project],
    queryFn: () => daemon.listSessions(project),
    enabled: open && !!project,
  });
  const sessions = sessionsQuery.data ?? [];
  const filesQuery = useQuery({
    queryKey: ["fileList", "new", project],
    queryFn: daemonQuery<ProjectFile[]>("file.list", { project }),
    enabled: open && !!project,
  });
  const projectFiles = Array.isArray(filesQuery.data) ? filesQuery.data : [];

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
    await daemon.request("task.create", {
      project,
      prompt: submission.text.trim(),
      attachments: submission.attachments,
      agent,
      // The "orchestrator-chat" tag makes the daemon wire the warpforge MCP
      // bridge (spawn_agent / read_inbox) into this session.
      tags: orchChat ? [...userTags, "orchestrator-chat"] : userTags,
      include_runtime_context: shareContext,
      worktree: orchChat ? false : useWorktree,
    });
    onOpenChange(false);
  };

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

          {/* Agent — for an orchestrator this is the lead agent. */}
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {orchChat ? "Lead agent (orchestrator)" : "Agent"}
            <Select value={agent} onValueChange={setAgent}>
              <SelectTrigger>
                <SelectValue placeholder="Agent" />
              </SelectTrigger>
              <SelectContent>
                {(agentOptions.length ? agentOptions : [{ id: "claude", label: "Claude" }]).map(
                  (a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.label}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </label>

          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            Prompt
            <Composer
              key={`${open}-${project}-${initialPrompt ?? ""}`}
              ref={composerRef}
              initialValue={prompt}
              onDraftChange={setPrompt}
              files={projectFiles}
              filesLoading={filesQuery.isLoading}
              imageSupported
              hideSendButton
              onSend={create}
              placeholder={orchChat ? "What should the orchestrator coordinate?" : "What should the agent do?"}
            />
            <span>Image support is negotiated when the agent starts; unsupported image prompts are marked blocked.</span>
          </div>

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

          {/* Toggles: share context + worktree + orchestrator */}
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

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setUseWorktree((v) => !v)}
                disabled={orchChat}
                className={cn(
                  "flex items-center gap-3 rounded-md border p-2.5 text-left transition-colors",
                  useWorktree && !orchChat ? "border-primary/40 bg-primary/5" : "border-border",
                  orchChat && "opacity-40",
                )}
              >
                <div
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded border",
                    useWorktree && !orchChat ? "border-primary bg-primary" : "border-muted-foreground",
                  )}
                >
                  {useWorktree && !orchChat && (
                    <div className="size-2 rounded-sm bg-primary-foreground" />
                  )}
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
                onClick={() => setOrchChat((v) => !v)}
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
          <Button onClick={() => composerRef.current?.submit()} disabled={!prompt.trim() || !project}>
            {orchChat ? "Start orchestrator" : "Start task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
