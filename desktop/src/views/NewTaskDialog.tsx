import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Share2, History, GitBranch } from "lucide-react";
import { daemon } from "../daemon";
import { ExternalSession, Snapshot } from "../protocol";
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

export default function NewTaskDialog({ open, onOpenChange, snapshot, defaultProject, initialPrompt }: Props) {
  const [project, setProject] = useState(defaultProject ?? snapshot.projects[0]?.name ?? "");
  const [agent, setAgent] = useState("");
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [tags, setTags] = useState("");
  const [shareContext, setShareContext] = useState(true);
  const [useWorktree, setUseWorktree] = useState(false);

  const projectInfo = snapshot.projects.find((p) => p.name === project);
  // Global agent registry (from setup wizard) takes priority over per-project templates.
  const agentOptions =
    snapshot.agents && snapshot.agents.length > 0
      ? snapshot.agents.filter((a) => a.enabled).map((a) => ({ id: a.id, label: a.displayName }))
      : (projectInfo ? Object.keys(projectInfo.agentTemplates) : []).map((id) => ({ id, label: id }));
  const running = snapshot.services.filter(
    (s) => s.project === project && s.status === "running" && s.allocatedPort > 0,
  );

  useEffect(() => {
    if (open) {
      setProject(defaultProject ?? snapshot.projects[0]?.name ?? "");
      setPrompt(initialPrompt ?? "");
      setTags("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultProject, initialPrompt]);

  useEffect(() => {
    setAgent(agentOptions[0]?.id ?? "claude");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  // Resumable claude/codex sessions for the selected project.
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

  const create = () => {
    if (!prompt.trim() || !project) return;
    void daemon.request("task.create", {
      project,
      prompt: prompt.trim(),
      agent,
      tags: tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      include_runtime_context: shareContext,
      worktree: useWorktree,
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
          <div className="grid grid-cols-2 gap-3">
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
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Agent
              <Select value={agent} onValueChange={setAgent}>
                <SelectTrigger>
                  <SelectValue placeholder="Agent" />
                </SelectTrigger>
                <SelectContent>
                  {(agentOptions.length ? agentOptions : [{ id: "claude", label: "Claude" }]).map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>

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

          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Tags (comma-separated)
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="bug, frontend"
              className="h-8 rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>

          {/* Runtime context toggle — the Projects↔Tasks bridge */}
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
                Share running services with the agent
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {running.length > 0 ? (
                  <>
                    Tells the agent about{" "}
                    <span className="font-mono text-foreground">
                      {running.map((s) => `${s.name}:${s.allocatedPort}`).join(", ")}
                    </span>{" "}
                    so it can hit live endpoints and run tests.
                  </>
                ) : (
                  "No services running for this project right now."
                )}
              </p>
            </div>
          </button>

          {/* Worktree isolation toggle */}
          <button
            type="button"
            onClick={() => setUseWorktree((v) => !v)}
            className={cn(
              "flex items-start gap-3 rounded-md border p-3 text-left transition-colors",
              useWorktree ? "border-primary/40 bg-primary/5" : "border-border",
            )}
          >
            <div
              className={cn(
                "mt-0.5 flex size-4 items-center justify-center rounded border",
                useWorktree ? "border-primary bg-primary" : "border-muted-foreground",
              )}
            >
              {useWorktree && <div className="size-2 rounded-sm bg-primary-foreground" />}
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <GitBranch className="size-3.5 text-primary" />
                Run in isolated worktree
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Creates a separate git worktree so this task's changes don't
                conflict with the main working tree or other tasks.
              </p>
            </div>
          </button>
          {/* Resume an existing claude/codex session found on disk */}
          {sessions.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <History className="size-3.5" />
                Resume a previous session in this project
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
            Start task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
