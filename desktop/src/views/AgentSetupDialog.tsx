import { Bot, Download } from "lucide-react";
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

export default function AgentSetupDialog({ detected, onClose }: Props) {
  const [enabled, setEnabled] = useState<Set<string>>(
    () => new Set(detected.filter((a) => a.installed).map((a) => a.id)),
  );

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

  const save = async () => {
    const agents: AgentConfig[] = detected
      .filter((a) => enabled.has(a.id))
      .map((a) => ({
        acpCommand: a.defaultAcpCommand,
        displayName: a.displayName,
        enabled: true,
        id: a.id,
      }));
    await daemon.saveAgents(agents);
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
          {detected.map((agent) => {
            const on = enabled.has(agent.id);
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => toggle(agent.id)}
                className={cn(
                  "flex items-start gap-3 rounded-md border p-3 text-left transition-colors",
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
                      <span className="rounded-full bg-green-500/15 px-1.5 py-0.5 text-[10px] font-medium text-green-600 dark:text-green-400">
                        installed
                      </span>
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
                  {!agent.installed && (
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      Install: <span className="font-mono">{agent.installHint}</span>
                    </p>
                  )}
                </div>
              </button>
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
