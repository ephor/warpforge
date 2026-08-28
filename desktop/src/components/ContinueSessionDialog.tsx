import { Check, ChevronDown } from "lucide-react";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { AgentLogo } from "@/components/AgentLogo";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { agentDisplayName } from "@/lib/agentNames";
import {
  buildHandoffSeed,
  canContinueHere,
  type CarryMode,
  defaultCarryMode,
  type Destination,
} from "@/lib/continueSession";
import { buildConversationBranchPrompt, renderTranscript } from "@/lib/conversationBranch";
import { estimateTokens, formatTokenRange } from "@/lib/tokenEstimate";
import { cn } from "@/lib/utils";
import type { SessionUpdate, TaskInfo } from "@/protocol";
import { useUi } from "@/store/ui";

import { daemon } from "../daemon";

function Choice({
  selected,
  onSelect,
  title,
  cost,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  cost: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "w-full rounded-md border p-3 text-left transition-colors",
        selected ? "border-primary bg-secondary/60" : "border-border hover:bg-secondary/40",
      )}
    >
      <span className="flex items-baseline gap-2">
        <Check className={cn("size-3.5 shrink-0 text-primary", selected ? "" : "opacity-0")} />
        <span className="flex-1 text-sm font-medium text-foreground">{title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{cost}</span>
      </span>
      <span className="mt-1 block pl-[1.375rem] text-xs text-muted-foreground">{children}</span>
    </button>
  );
}

/** A compact chip that opens a menu — the shape the app picks harnesses with. */
function Picker({
  label,
  value,
  icon,
  children,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs text-foreground hover:bg-secondary/60"
        >
          {icon}
          <span className="max-w-32 truncate">{value}</span>
          <ChevronDown aria-hidden className="size-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Give a freshly created task a title, if the developer asked for that. The
 * seed prompt is a whole transcript or handoff, so without this the board shows
 * a wall of text where a label belongs. Fire-and-forget: a missing title is a
 * cosmetic loss, not a reason to fail the continuation.
 */
function nameNewTask(taskId: string) {
  const { autoNameTasks, textGenAgentId, textGenModel } = useUi.getState();
  if (!autoNameTasks || !textGenAgentId) return;
  void (async () => {
    try {
      const generated = await daemon.generateText(
        taskId,
        textGenAgentId,
        "task_title",
        textGenModel ?? undefined,
      );
      if (generated?.trim()) await daemon.setTaskTitle(taskId, generated.trim().slice(0, 80));
    } catch {
      // Silent.
    }
  })();
}

/**
 * Choose how a conversation continues in a fresh session.
 *
 * Reached two ways: from a task whose agent has lost its session for good, and
 * from "Continue with…" on a message. Both face the same question — the old
 * context has to travel somehow — so both ask it here.
 */
export function ContinueSessionDialog({
  open,
  onOpenChange,
  task,
  updates,
  throughIndex,
  targetAgent,
  onOpenTask,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: TaskInfo;
  updates: SessionUpdate[];
  /** Last update to carry over — the fork point, or the end of the session. */
  throughIndex: number;
  /** Harness that continues the work. */
  targetAgent: string;
  onOpenTask: (id: string) => void;
}) {
  const daemonState = useSyncExternalStore(daemon.subscribe, daemon.getState);
  const agents = (daemonState.snapshot.agents ?? []).filter((agent) => agent.enabled);
  const accounts = daemonState.snapshot.accounts ?? [];
  const transcript = useMemo(
    () => renderTranscript(updates, throughIndex),
    [updates, throughIndex],
  );
  const estimate = useMemo(() => estimateTokens(transcript), [transcript]);
  const continueHereAllowed = canContinueHere(task, targetAgent);

  const [carry, setCarry] = useState<CarryMode>(() => defaultCarryMode(estimate));
  const [destination, setDestination] = useState<Destination>(continueHereAllowed ? "here" : "new");
  const [compactAgent, setCompactAgent] = useState(targetAgent);
  const [compactAccount, setCompactAccount] = useState<string>("");
  const [busy, setBusy] = useState(false);
  // `busy` reaches the button a render later, so two fast clicks would both
  // pass through and create two tasks. This closes the gap synchronously.
  const running = useRef(false);
  // A summary costs a round trip through a model. If sending it fails, keep it
  // so retrying does not pay for the same document twice.
  const handoffCache = useRef<string | null>(null);

  const branchWorktree = useUi((s) => s.branchWorktree);
  const setBranchWorktree = useUi((s) => s.setBranchWorktree);

  const compactAccounts = accounts.filter((account) => account.agentId === compactAgent);
  const compactAgentName = agentDisplayName(
    compactAgent,
    agents.find((agent) => agent.id === compactAgent)?.displayName,
  );

  // Changing who summarises invalidates a document the previous one produced.
  const chooseCompactAgent = (id: string) => {
    setCompactAgent(id);
    setCompactAccount("");
    handoffCache.current = null;
  };
  const chooseCompactAccount = (id: string) => {
    setCompactAccount(id);
    handoffCache.current = null;
  };

  const run = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      let text: string;
      if (carry === "summary") {
        const document =
          handoffCache.current ??
          (await daemon.generateText(task.id, compactAgent, "handoff", undefined, {
            accountId: compactAccount || undefined,
            input: transcript,
          }));
        if (!document.trim()) throw new Error("The handoff came back empty");
        handoffCache.current = document;
        text = buildHandoffSeed(task, document);
      } else {
        text = buildConversationBranchPrompt(task, updates, throughIndex);
        if (!text) throw new Error("There is nothing to carry over");
      }

      if (destination === "here") {
        await daemon.request("session.prompt", {
          attachments: [],
          task_id: task.id,
          text,
        });
        onOpenTask(task.id);
      } else {
        const result = await daemon.request("task.create", {
          agent: targetAgent,
          attachments: [],
          config_overrides: {},
          include_runtime_context: true,
          project: task.project,
          prompt: text,
          tags: ["conversation-branch", `branched-from:${task.id}`],
          worktree: branchWorktree,
        });
        const createdTaskId = (result as { taskId?: string })?.taskId;
        if (!createdTaskId) throw new Error("Warpforge did not return the new task id");
        nameNewTask(createdTaskId);
        onOpenTask(createdTaskId);
      }
      onOpenChange(false);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not continue this session");
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Continue in a new session</DialogTitle>
          <DialogDescription>
            {agentDisplayName(targetAgent)} starts fresh, so the earlier conversation has to travel
            with it. Warpforge kept the transcript either way — this only decides what the new
            session reads.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2" role="radiogroup" aria-label="What the new session reads">
          <Choice
            selected={carry === "full"}
            onSelect={() => setCarry("full")}
            title="Full transcript"
            cost={`free · ${formatTokenRange(estimate)}`}
          >
            Every message, verbatim. Nothing is interpreted, but the new session starts with its
            window part-filled and will compact sooner.
          </Choice>
          <Choice
            selected={carry === "summary"}
            onSelect={() => setCarry("summary")}
            title="Handoff summary"
            cost="one pass"
          >
            Goal, decisions, where work stopped, next steps — plus the tool calls and edits, so the
            new session knows what already happened.
          </Choice>
        </div>

        {carry === "summary" && (
          // Two harnesses are in play and only one of them continues the work.
          // Without the footnote the picker reads as "who takes over", which it
          // is not — it only chooses who reads the transcript and writes the
          // brief. The note gets its own row so a long harness name cannot push
          // it into an unpredictable wrap.
          <div className="space-y-1.5 text-xs text-muted-foreground">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0">Written by</span>
              <Picker
                label="Harness that writes the handoff"
                value={compactAgentName}
                icon={
                  <AgentLogo
                    agentId={compactAgent}
                    displayName={compactAgentName}
                    className="size-3.5 shrink-0"
                  />
                }
              >
                {agents.map((agent) => {
                  const name = agentDisplayName(agent.id, agent.displayName);
                  return (
                    <DropdownMenuItem
                      key={agent.id}
                      className="text-xs"
                      onSelect={() => chooseCompactAgent(agent.id)}
                    >
                      <AgentLogo
                        agentId={agent.id}
                        displayName={name}
                        className="size-3.5 shrink-0"
                      />
                      <span className="flex-1 truncate">{name}</span>
                      {compactAgent === agent.id && <Check aria-hidden className="size-3.5" />}
                    </DropdownMenuItem>
                  );
                })}
              </Picker>
              {compactAccounts.length > 1 && (
                <Picker
                  label="Account that writes the handoff"
                  value={
                    compactAccounts.find((account) => account.id === compactAccount)?.label ??
                    "Active account"
                  }
                >
                  {compactAccounts.map((account) => (
                    <DropdownMenuItem
                      key={account.id}
                      className="text-xs"
                      onSelect={() => chooseCompactAccount(account.id)}
                    >
                      <span className="flex-1 truncate">
                        {account.label}
                        {account.active ? " (active)" : ""}
                      </span>
                      {compactAccount === account.id && <Check aria-hidden className="size-3.5" />}
                    </DropdownMenuItem>
                  ))}
                </Picker>
              )}
            </div>
            <p>
              <span aria-hidden className="mr-1 opacity-70">
                *
              </span>
              Writes the handoff only. {agentDisplayName(targetAgent)} still continues the work.
              {compactAccounts.length > 1 && " Switch account if this one is out of quota."}
            </p>
          </div>
        )}

        {/* Continuing in place is only on the table for a session the agent has
            forgotten. While the session still works it already holds this
            conversation, so there is nothing to hand it. */}
        {continueHereAllowed ? (
          <div
            className="space-y-2 border-t border-border pt-3"
            role="radiogroup"
            aria-label="Where the work continues"
          >
            <Choice
              selected={destination === "here"}
              onSelect={() => setDestination("here")}
              title="Continue in this task"
              cost=""
            >
              One thread on the board — the conversation carries on below what is already there.
            </Choice>
            <Choice
              selected={destination === "new"}
              onSelect={() => setDestination("new")}
              title="Start a new task"
              cost=""
            >
              Leaves this one as it stands and opens a fresh task seeded with the context.
            </Choice>
          </div>
        ) : (
          <p className="border-t border-border pt-3 text-xs text-muted-foreground">
            Opens a new task seeded with the context. This one is left as it stands.
          </p>
        )}

        {destination === "new" && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={branchWorktree}
              onChange={(event) => setBranchWorktree(event.target.checked)}
              className="size-3.5 accent-[hsl(var(--primary))]"
            />
            Run it in a new worktree
          </label>
        )}

        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void run()}>
            {busy ? (carry === "summary" ? "Summarising…" : "Starting…") : "Continue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
