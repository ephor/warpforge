import { ChevronRight, FilePen, ListTodo, TriangleAlert, Wrench } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { withOccurrenceKeys } from "@/lib/renderKeys";
import { toolDisplayTitle } from "@/lib/toolDisplay";
import { cn } from "@/lib/utils";

import type { FileLinkResolver } from "../../components/Markdown";
import { BufferedMarkdown, CollapsibleMarkdown, Markdown } from "../../components/Markdown";
import { ThinkingBlock } from "../../components/ThinkingBlock";
import { WorkflowEventLine } from "../../components/WorkflowEventLine";
import { daemon } from "../../daemon";
import type { EditHunk, SessionUpdate } from "../../protocol";

/** A tool-call card whose output can be expanded/collapsed. Collapsed by default. */
function ToolCallLine({
  update,
  dot,
}: {
  update: Extract<SessionUpdate, { kind: "tool_call" }>;
  dot: string;
}) {
  const [open, setOpen] = useState(false);
  const hasContent = Boolean(update.content);
  const title = toolDisplayTitle(update);
  return (
    <div className="min-w-0 overflow-hidden rounded-md border bg-secondary/30">
      <button
        type="button"
        disabled={!hasContent}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm",
          hasContent && "hover:bg-secondary/50",
        )}
      >
        {hasContent ? (
          <ChevronRight
            className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
          />
        ) : (
          <Wrench className={cn("size-3.5 shrink-0", dot)} />
        )}
        <span className="min-w-0 flex-1 truncate font-medium" title={title}>
          {title}
        </span>
        {update.tool_kind && update.tool_kind !== "other" && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {update.tool_kind}
          </span>
        )}
        <span className={cn("shrink-0 text-xs", dot)}>{update.status.replace("_", " ")}</span>
      </button>
      {open && hasContent && (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words border-t px-2.5 py-2 font-mono text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          {update.content}
        </pre>
      )}
    </div>
  );
}

/**
 * A permission prompt with allow/deny buttons. Once answered it collapses to a
 * muted "responded" row — the update itself lingers in the stream, so we track
 * the answer locally to stop showing live buttons.
 */
function PermissionLine({
  update,
  taskId,
  resolvedOutcome,
}: {
  update: Extract<SessionUpdate, { kind: "permission_request" }>;
  taskId?: string;
  /** Outcome recorded in the stream — persists across reopen/restart. */
  resolvedOutcome?: string;
}) {
  const [clicked, setClicked] = useState<string | null>(null);
  const answered = clicked ?? resolvedOutcome ?? null;
  return (
    <div
      className={cn(
        "min-w-0 overflow-hidden rounded-md border px-2.5 py-2",
        answered ? "border-border bg-secondary/20" : "border-warn/40 bg-warn/5",
      )}
    >
      <p
        className={cn(
          "flex min-w-0 items-start gap-1.5",
          answered ? "text-muted-foreground" : "mb-2 text-warn",
        )}
      >
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{update.title}</span>
        {answered && (
          <span className="shrink-0 whitespace-nowrap text-xs">✓ {answered.replace("_", " ")}</span>
        )}
      </p>
      {!answered &&
        (taskId ? (
          <div className="flex flex-wrap gap-1.5">
            {update.options.map((opt) => (
              <Button
                key={opt}
                size="sm"
                variant={opt === "deny" ? "destructive" : "default"}
                onClick={() => {
                  setClicked(opt);
                  void daemon.request("session.permission", {
                    outcome: opt,
                    request_id: update.request_id,
                    task_id: taskId,
                  });
                }}
              >
                {opt.replace("_", " ")}
              </Button>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Open the task to respond.</p>
        ))}
    </div>
  );
}

export function StreamLine({
  update,
  compact,
  taskId,
  resolved,
  resolveFilePath,
  onOpenFile,
  onOpenFileDiff,
  onOpenTask,
  project,
  thinkingActive,
  textStreaming,
}: {
  update: SessionUpdate;
  compact?: boolean;
  /** When set, permission requests render inline allow/deny buttons. */
  taskId?: string;
  /** Request_id → recorded outcome, from persisted permission_resolved updates. */
  resolved?: Record<string, string>;
  resolveFilePath?: FileLinkResolver;
  onOpenFile?: (path: string) => void;
  onOpenFileDiff?: (path: string, hunks?: EditHunk[]) => void;
  /** Opens a workflow stage/reviewer child from an inline timeline card. */
  onOpenTask?: (id: string) => void;
  /** Project root label retained after stripping the machine-specific prefix. */
  project?: string;
  /** True only for the thought block currently receiving streamed deltas. */
  thinkingActive?: boolean;
  /** True only for the assistant text block currently receiving deltas. */
  textStreaming?: boolean;
}) {
  switch (update.kind) {
    case "user_message":
      return (
        <div
          className={cn(
            "rounded-md border border-primary/20 bg-primary/10 px-3.5 py-2.5 text-foreground shadow-sm my-3",
            compact && "text-xs px-2.5 py-1.5",
          )}
        >
          {compact ? (
            <Markdown
              className="text-current"
              resolveFilePath={resolveFilePath}
              onOpenFile={onOpenFile}
            >
              {`› ${update.text}`}
            </Markdown>
          ) : (
            <CollapsibleMarkdown resolveFilePath={resolveFilePath} onOpenFile={onOpenFile}>
              {update.text}
            </CollapsibleMarkdown>
          )}
          {!!update.attachments?.length && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {withOccurrenceKeys(update.attachments, (attachment) =>
                attachment.type === "file" ? `file:${attachment.path}` : `image:${attachment.name}`,
              ).map(({ item: attachment, key }) => (
                <span
                  key={key}
                  className="rounded border border-primary/20 bg-background/40 px-1.5 py-0.5 font-mono text-[10px]"
                >
                  {attachment.type === "file" ? `@${attachment.path}` : `image: ${attachment.name}`}
                </span>
              ))}
            </div>
          )}
        </div>
      );
    case "agent_text":
      return compact ? (
        <Markdown
          className="text-current"
          resolveFilePath={resolveFilePath}
          onOpenFile={onOpenFile}
        >
          {update.text}
        </Markdown>
      ) : textStreaming ? (
        <BufferedMarkdown resolveFilePath={resolveFilePath} onOpenFile={onOpenFile}>
          {update.text}
        </BufferedMarkdown>
      ) : (
        <Markdown resolveFilePath={resolveFilePath} onOpenFile={onOpenFile}>
          {update.text}
        </Markdown>
      );
    case "workflow_event":
      return <WorkflowEventLine update={update} compact={compact} onOpenTask={onOpenTask} />;
    case "agent_thought":
      return compact ? (
        <Markdown
          className="italic text-muted-foreground"
          resolveFilePath={resolveFilePath}
          onOpenFile={onOpenFile}
        >
          {update.text}
        </Markdown>
      ) : (
        <ThinkingBlock
          text={update.text}
          streaming={Boolean(thinkingActive)}
          resolveFilePath={resolveFilePath}
          onOpenFile={onOpenFile}
        />
      );
    case "tool_call": {
      const title = toolDisplayTitle(update);
      const dot =
        update.status === "completed"
          ? "text-ok"
          : update.status === "failed"
            ? "text-destructive"
            : "text-warn";
      if (compact) {
        return (
          <p className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <Wrench className={cn("size-3.5 shrink-0", dot)} />
            <span className="min-w-0 truncate text-foreground" title={title}>
              {title}
            </span>
          </p>
        );
      }
      return <ToolCallLine update={update} dot={dot} />;
    }
    case "file_edit":
      const filePath = resolveFilePath?.(update.path) ?? null;
      const displayPath = filePath
        ? project && filePath !== project && !filePath.startsWith(`${project}/`)
          ? `${project}/${filePath}`
          : filePath
        : update.path;
      const hasLineCounts = update.additions !== undefined || update.deletions !== undefined;
      return (
        <p className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
          <FilePen className="size-3.5 shrink-0 text-primary" />
          {filePath && onOpenFile ? (
            <button
              type="button"
              onClick={() => onOpenFile(filePath)}
              className="min-w-0 flex-1 truncate text-left text-primary hover:underline"
              title={`Open ${filePath}`}
            >
              {displayPath}
            </button>
          ) : (
            <span className="min-w-0 flex-1 truncate" title={displayPath}>
              {displayPath}
            </span>
          )}
          {hasLineCounts && filePath && onOpenFileDiff ? (
            <button
              type="button"
              onClick={() => onOpenFileDiff(filePath, update.hunks)}
              className="ml-auto inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 tabular-nums hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label={`Open diff for ${filePath}: ${update.additions ?? 0} lines added, ${update.deletions ?? 0} lines deleted`}
              title={`Open diff for ${filePath}`}
            >
              <span className="text-ok">+{update.additions ?? 0}</span>
              <span className="text-destructive">−{update.deletions ?? 0}</span>
            </button>
          ) : hasLineCounts ? (
            <span
              className="ml-auto inline-flex shrink-0 items-center gap-1 tabular-nums"
              aria-label={`${update.additions ?? 0} lines added, ${update.deletions ?? 0} lines deleted`}
            >
              <span className="text-ok">+{update.additions ?? 0}</span>
              <span className="text-destructive">−{update.deletions ?? 0}</span>
            </span>
          ) : null}
        </p>
      );
    case "permission_request":
      return (
        <PermissionLine
          update={update}
          taskId={taskId}
          resolvedOutcome={resolved?.[update.request_id]}
        />
      );
    case "permission_resolved":
      // Metadata only — folded into the permission_request row above.
      return null;
    case "plan":
      if (compact) {
        const done = update.entries.filter((e) => e.status === "completed").length;
        return (
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <ListTodo className="size-3.5 shrink-0" />
            plan · {done}/{update.entries.length}
          </p>
        );
      }
      return (
        <div className="rounded-md border bg-secondary/30 p-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <ListTodo className="size-3.5" /> Plan
          </div>
          <ul className="space-y-1 text-sm">
            {update.entries.map((e) => (
              <li
                key={`${e.status}:${e.priority ?? ""}:${e.content}`}
                className="flex items-start gap-2"
              >
                <span
                  className={cn(
                    "mt-0.5",
                    e.status === "completed"
                      ? "text-ok"
                      : e.status === "in_progress"
                        ? "text-warn"
                        : "text-muted-foreground",
                  )}
                >
                  {e.status === "completed" ? "✓" : e.status === "in_progress" ? "◐" : "○"}
                </span>
                <span
                  className={cn(e.status === "completed" && "text-muted-foreground line-through")}
                >
                  {e.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      );
    case "available_commands":
    case "prompt_capabilities":
    case "usage":
      // Metadata for the composer's slash menu — not shown inline.
      return null;
    case "turn_ended":
      if (compact) {
        return null;
      }
      return (
        <p className="text-center text-xs text-muted-foreground">
          Agent is waiting for the next instruction.
        </p>
      );
  }
}
