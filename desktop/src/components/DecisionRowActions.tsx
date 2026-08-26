import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { AttentionItem } from "@/lib/attentionRail";
import { decisionActionKinds, permissionApproveOption } from "@/lib/decisionActions";

import { daemon } from "../daemon";

/**
 * Inline actions for one decision-queue row, so a queue can be drained without
 * opening each task. Renders nothing for rows with no actionable barrier
 * (blocked/interrupted/paused) — those keep only their open affordance.
 */
export function DecisionRowActions({ item }: { item: AttentionItem }) {
  const kinds = decisionActionKinds(item);
  if (kinds.length === 0) return null;
  return <RowActions item={item} kind={kinds[0]} />;
}

function RowActions({
  item,
  kind,
}: {
  item: AttentionItem;
  kind: "permission" | "question" | "limit";
}) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");

  const busy = busyAction !== null;

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusyAction(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyAction(null);
    }
  };

  if (kind === "permission") {
    const permission = item.permission;
    if (!permission) return null;
    const approve = permissionApproveOption(permission.options);
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {permission.options.map((opt) => (
            <Button
              key={opt}
              size="sm"
              variant={opt !== approve ? "destructive" : "default"}
              className="gap-1 px-2.5"
              disabled={busy}
              onClick={() =>
                void act(`answer "${opt}"`, async () => {
                  await daemon.request("session.permission", {
                    outcome: opt,
                    request_id: permission.request_id,
                    task_id: item.task.id,
                  });
                })
              }
            >
              {busyAction === `answer "${opt}"` ? "…" : opt}
            </Button>
          ))}
        </div>
        <ErrorLine error={error} />
      </div>
    );
  }

  if (kind === "question") {
    const send = (message: string) =>
      void act("send reply", async () => {
        await daemon.workflowReply(item.task.id, message);
        setText("");
      });
    return (
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Reply to workflow question"
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && text.trim()) send(text);
          }}
          placeholder="Type an answer…"
          value={text}
        />
        <Button
          size="sm"
          className="gap-1 px-2.5"
          disabled={busy || !text.trim()}
          onClick={() => send(text)}
        >
          {busyAction === "send reply" ? "Sending…" : "Send"}
        </Button>
        <Button size="sm" className="gap-1 px-2.5" disabled={busy} onClick={() => send("yes")}>
          Yes
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="gap-1 px-2.5"
          disabled={busy}
          onClick={() => send("no")}
        >
          No
        </Button>
        <ErrorLine error={error} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          className="gap-1 px-2.5"
          disabled={busy}
          title="Run one more fix → review cycle"
          onClick={() =>
            void act("add one review round", () =>
              daemon.workflowDecide(item.task.id, "extend", { rounds: 1 }),
            )
          }
        >
          {busyAction === "add one review round" ? "Continuing…" : "1 more round"}
        </Button>
        <Button
          size="sm"
          className="gap-1 px-2.5"
          disabled={busy}
          title="Stop the pipeline and send the current changes to human review"
          onClick={() =>
            void act("finish the workflow", () => daemon.workflowDecide(item.task.id, "finish"))
          }
        >
          {busyAction === "finish the workflow" ? "Finishing…" : "Finish for review"}
        </Button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="w-full text-[11px] text-destructive">
      {error}
    </p>
  );
}
