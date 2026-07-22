import { Bot, Download, Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import { daemon } from "../daemon";
import type { AgentConfig, DetectedAgent } from "../protocol";

interface Props {
  detected: DetectedAgent[];
  onClose: () => void;
}

/** Last non-empty line of command output, for a compact error hint. */
function lastLine(output: string): string {
  const lines = output.trim().split("\n");
  return lines[lines.length - 1]?.trim() ?? "";
}

export default function AgentSetupDialog({ detected, onClose }: Props) {
  const [agents, setAgents] = useState<DetectedAgent[]>(detected);
  const [enabled, setEnabled] = useState<Set<string>>(
    () => new Set(detected.filter((a) => a.installed).map((a) => a.id)),
  );
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});

  const toggle = (id: string) =>
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  const manage = async (id: string) => {
    setBusy((prev) => new Set(prev).add(id));
    setErrors((prev) => {
      const { [id]: _cleared, ...rest } = prev;
      return rest;
    });
    try {
      const result = await daemon.installAgent(id);
      if (!result.ok) {
        setErrors((prev) => ({ ...prev, [id]: lastLine(result.output) || "install failed" }));
      }
      // Re-detect so version/status badges reflect the new install.
      const refreshed = await daemon.detectAgents();
      setAgents(refreshed);
      if (result.ok) {
        const nowInstalled = refreshed.find((a) => a.id === id)?.installed;
        if (nowInstalled) setEnabled((prev) => new Set(prev).add(id));
      }
    } catch (e) {
      setErrors((prev) => ({ ...prev, [id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const save = async () => {
    const configs: AgentConfig[] = agents
      .filter((a) => enabled.has(a.id))
      .map((a) => ({
        acpCommand: a.defaultAcpCommand,
        displayName: a.displayName,
        enabled: true,
        id: a.id,
        models: [],
        lastModel: undefined,
      }));
    await daemon.saveAgents(configs);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="size-5" />
            Set up AI agents
          </DialogTitle>
          <DialogDescription>
            Select which agents to enable. Warpforge connects to them via ACP (Agent Client
            Protocol) over stdio.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {agents.map((agent) => {
            const on = enabled.has(agent.id);
            const isBusy = busy.has(agent.id);
            const behind = agent.status === "behind";
            return (
              <div
                key={agent.id}
                role="button"
                tabIndex={0}
                onClick={() => toggle(agent.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggle(agent.id);
                  }
                }}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-md border p-3 text-left transition-colors",
                  on ? "border-primary/40 bg-primary/5" : "border-border",
                )}
              >
                <div
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border",
                    on ? "border-primary bg-primary" : "border-muted-foreground",
                  )}
                >
                  {on && <div className="size-2 rounded-sm bg-primary-foreground" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {agent.displayName}
                    {agent.installed ? (
                      behind ? (
                        <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                          update available
                        </span>
                      ) : (
                        <span className="rounded-full bg-green-500/15 px-1.5 py-0.5 text-[10px] font-medium text-green-600 dark:text-green-400">
                          {agent.version ? `v${agent.version}` : "installed"}
                        </span>
                      )
                    ) : (
                      <span className="flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        <Download className="size-2.5" />
                        not found
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                    {agent.defaultAcpCommand}
                  </p>
                  {behind && agent.latestVersion && (
                    <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                      v{agent.version} → v{agent.latestVersion}
                    </p>
                  )}
                  {!agent.installed && !agent.canManage && (
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      Install: <span className="font-mono">{agent.installHint}</span>
                    </p>
                  )}
                  {errors[agent.id] && (
                    <p className="mt-0.5 font-mono text-[11px] text-red-500">{errors[agent.id]}</p>
                  )}
                </div>
                {agent.canManage && (!agent.installed || behind) && (
                  <Button
                    size="sm"
                    variant={behind ? "default" : "secondary"}
                    disabled={isBusy}
                    onClick={(e) => {
                      e.stopPropagation();
                      void manage(agent.id);
                    }}
                  >
                    {isBusy && <Loader2 className="size-3 animate-spin" />}
                    {isBusy ? "Working…" : agent.installed ? "Update" : "Install"}
                  </Button>
                )}
              </div>
            );
          })}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose}>
            Skip for now
          </Button>
          <Button onClick={() => void save()} disabled={enabled.size === 0}>
            Save {enabled.size > 0 ? `(${enabled.size})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
