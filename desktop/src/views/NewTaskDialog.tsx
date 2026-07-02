import { useEffect, useState } from "react";
import { Share2 } from "lucide-react";
import { daemon } from "../daemon";
import { Snapshot } from "../protocol";
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
}

export default function NewTaskDialog({ open, onOpenChange, snapshot, defaultProject }: Props) {
  const [project, setProject] = useState(defaultProject ?? snapshot.projects[0]?.name ?? "");
  const [agent, setAgent] = useState("");
  const [prompt, setPrompt] = useState("");
  const [tags, setTags] = useState("");
  const [shareContext, setShareContext] = useState(true);

  const projectInfo = snapshot.projects.find((p) => p.name === project);
  const agentOptions = projectInfo ? Object.keys(projectInfo.agentTemplates) : [];
  const running = snapshot.services.filter(
    (s) => s.project === project && s.status === "running" && s.allocatedPort > 0,
  );

  useEffect(() => {
    if (open) {
      setProject(defaultProject ?? snapshot.projects[0]?.name ?? "");
      setPrompt("");
      setTags("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultProject]);

  useEffect(() => {
    setAgent(agentOptions[0] ?? "claude");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

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
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
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
                  {(agentOptions.length ? agentOptions : ["claude", "codex"]).map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
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
