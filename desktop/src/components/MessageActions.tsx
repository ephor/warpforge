import { Check, Copy, GitBranch } from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { AgentConfig } from "@/protocol";

export const MessageActions = memo(function MessageActions({
  agents,
  className,
  onContinue,
  text,
}: {
  agents: AgentConfig[];
  className?: string;
  onContinue: (agent: string) => Promise<void>;
  text: string;
}) {
  const [copied, setCopied] = useState(false);
  const [startingAgent, setStartingAgent] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      toast.error("Could not copy this message");
    }
  }, [text]);

  const start = useCallback(
    async (agent: string) => {
      setStartingAgent(agent);
      try {
        await onContinue(agent);
      } catch (cause) {
        toast.error(
          cause instanceof Error ? cause.message : "Could not create conversation branch",
        );
      } finally {
        setStartingAgent(null);
      }
    },
    [onContinue],
  );

  return (
    <div
      className={cn(
        "flex items-center rounded-md border border-border/80 bg-background/95 p-0.5 text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => void copy()}
        className="rounded p-1 hover:bg-secondary hover:text-foreground"
        aria-label="Copy message"
        title="Copy message"
      >
        {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={startingAgent !== null}
            className="rounded p-1 hover:bg-secondary hover:text-foreground disabled:opacity-50"
            aria-label="Continue with another agent"
            title="Continue with…"
          >
            <GitBranch className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Continue with…</DropdownMenuLabel>
          {agents.map((agent) => (
            <DropdownMenuItem
              key={agent.id}
              disabled={startingAgent !== null}
              onSelect={() => void start(agent.id)}
            >
              {agent.displayName}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
});
