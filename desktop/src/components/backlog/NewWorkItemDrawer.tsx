"use client";

import * as SelectPrimitive from "@radix-ui/react-select";
import { useQueryClient } from "@tanstack/react-query";
import { Flag, Loader2, Maximize2, Minimize2, Paperclip, WandSparkles, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem } from "@/components/ui/select";
import { daemon } from "@/daemon";
import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";

import { priorityTone, SOURCE_DOT, STATUS_META } from "./labels";
import type { WorkItemPriority, WorkItemSource, WorkItemStatus } from "./types";
import { sourceAvailable, useProjectSources } from "./use-tracker";

interface NewWorkItemDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: string;
}

const STATUS_OPTIONS: { value: WorkItemStatus; label: string }[] = [
  { value: "todo", label: "To do" },
  { value: "in_progress", label: "In progress" },
  { value: "waiting", label: "Waiting" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

const PRIORITY_OPTIONS: { value: WorkItemPriority; label: string }[] = [
  { value: "none", label: "No priority" },
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

const SOURCE_LABELS: Record<WorkItemSource, string> = {
  github: "GitHub",
  linear: "Linear",
  local: "Local",
};

/** Chip trigger styled like the matching table cell, opening a Select
 *  dropdown (the project's standard single-select dropdown). */
function FieldChip<T extends string>({
  ariaLabel,
  value,
  options,
  triggerClassName,
  onValueChange,
  children,
}: {
  ariaLabel: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean; hint?: string }[];
  triggerClassName?: string;
  onValueChange: (value: T) => void;
  children: React.ReactNode;
}) {
  return (
    <Select value={value} onValueChange={(next) => onValueChange(next as T)}>
      <SelectPrimitive.Trigger
        type="button"
        aria-label={ariaLabel}
        className={cn(
          "flex h-7 shrink-0 items-center justify-start gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs transition-colors",
          "hover:bg-secondary hover:text-foreground data-[state=open]:bg-secondary data-[state=open]:text-foreground",
          triggerClassName,
        )}
      >
        {children}
      </SelectPrimitive.Trigger>
      <SelectContent className="min-w-[10rem]" align="start" sideOffset={4}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
            <span className="flex items-center gap-1.5">
              {option.label}
              {option.hint && (
                <span className="text-[10px] text-muted-foreground/70">{option.hint}</span>
              )}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function NewWorkItemDrawer({ open, onOpenChange, project }: NewWorkItemDrawerProps) {
  const expanded = useUi((state) => state.newWorkItemExpanded);
  const setExpanded = useUi((state) => state.setNewWorkItemExpanded);
  const queryClient = useQueryClient();
  const projectSources = useProjectSources(project);

  const [source, setSource] = useState<WorkItemSource>("local");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<WorkItemStatus>("todo");
  const [priority, setPriority] = useState<WorkItemPriority>("none");
  const [creating, setCreating] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const textGenAgentId = useUi((state) => state.textGenAgentId);
  const textGenModel = useUi((state) => state.textGenModel);

  const reset = useCallback(() => {
    setSource("local");
    setTitle("");
    setBody("");
    setStatus("todo");
    setPriority("none");
  }, []);

  // Opens with the prompt focused. The drawer stays mounted (Radix keeps the
  // DOM hidden), so the reset runs on each open — and on each project switch,
  // so a draft typed for project A never crosses into project B.
  useEffect(() => {
    if (!open) return;
    reset();
    const frame = requestAnimationFrame(() => titleRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, reset, project]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && title.trim()) {
        const keep = window.confirm("Discard this work item draft?");
        if (keep === false) return;
      }
      onOpenChange(next);
    },
    [onOpenChange, title],
  );

  const handleCreate = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed) return;

    setCreating(true);
    try {
      const item = await daemon.createBacklog({
        body: body.trim(),
        project,
        priority,
        source,
        status,
        title: trimmed,
      });
      if (source !== "local") {
        let externalId: string;
        try {
          const result = await daemon.createExternalWorkItem({
            body: body.trim(),
            itemId: item.id,
            project,
            provider: source,
            title: trimmed,
          });
          await daemon.attachBacklogExternal({
            itemId: item.id,
            project,
            provider: source,
            externalId: result.externalId,
            url: result.url,
          });
          externalId = result.externalId;
        } catch (error) {
          // Compensating cleanup (ADR-0002 invariant 5): drop the local row
          // (and any link) so a failed remote create/attach never leaves an
          // item claiming to live in a tracker it did not reach.
          try {
            await daemon.deleteBacklog(item.id, project);
          } catch {
            // The rollback must not mask the create error.
          }
          throw error;
        }
        toast(`Created ${externalId}`, { description: `Mirrored to ${SOURCE_LABELS[source]}.` });
      } else {
        toast("Work item created", { description: `Saved to ${project}.` });
      }
      await queryClient.invalidateQueries({ queryKey: ["backlog", project] });
      onOpenChange(false);
    } catch (error) {
      toast.error(`Could not create the ${SOURCE_LABELS[source]} issue`, {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCreating(false);
    }
  }, [body, onOpenChange, queryClient, priority, project, source, status, title]);

  // Polish the user's draft through the text-gen agent: first line becomes the
  // title, the rest the body. No task exists yet, so this goes over the raw text.
  const handleEnhance = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed || !textGenAgentId || enhancing) return;
    setEnhancing(true);
    try {
      const text = await daemon.enhancePrompt(
        project,
        textGenAgentId,
        trimmed,
        textGenModel ?? undefined,
      );
      const [first = "", ...rest] = text.split(/\r?\n/);
      setTitle(first.replace(/^#+\s*/, "").trim());
      setBody(rest.join("\n").trim());
    } catch (error) {
      toast.error("Could not enhance the task", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setEnhancing(false);
    }
  }, [enhancing, project, textGenAgentId, textGenModel, title]);

  // ⌘↵ / Ctrl+↵ creates from anywhere in the dialog.
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
      if (title.trim()) {
        event.preventDefault();
        void handleCreate();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleCreate, open, title]);

  const statusMeta = STATUS_META[status];
  const StatusIcon = statusMeta.icon;
  const priorityLabel =
    priority === "none" ? "None" : PRIORITY_OPTIONS.find((o) => o.value === priority)?.label;

  // A tracker the user has not connected — or one this project cannot reach
  // (no mapped Linear team, no resolvable repo) — stays selectable-but-disabled
  // rather than hidden, so the option itself is the hint that it exists.
  const linearReady = sourceAvailable(projectSources.data, "linear");
  const githubReady = sourceAvailable(projectSources.data, "github");
  const linearHint = linearReady ? undefined : "not connected";
  const githubHint = githubReady ? undefined : "not connected";
  const sourceOptions = [
    { value: "local" as const, label: SOURCE_LABELS.local },
    {
      value: "github" as const,
      label: SOURCE_LABELS.github,
      disabled: !githubReady,
      hint: githubHint,
    },
    {
      value: "linear" as const,
      label: SOURCE_LABELS.linear,
      disabled: !linearReady,
      hint: linearHint,
    },
  ];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPortal>
        <DialogOverlay className="bg-black/50 backdrop-blur-[2px]" />
        <DialogContent
          hideClose
          className={cn(
            "flex max-w-none flex-col gap-0 overflow-hidden rounded-lg border border-border/60 bg-popover p-0 shadow-2xl",
            "transition-[max-width,height] duration-200",
            expanded
              ? "h-[88vh] w-[min(1000px,calc(100vw-2rem))]"
              : "w-[min(720px,calc(100vw-2rem))]",
          )}
        >
          <DialogDescription className="sr-only">Create a task in {project}</DialogDescription>
          {/* Header: breadcrumb on the left, dialog actions on the right. */}
          <header className="flex h-11 shrink-0 items-center justify-between gap-2 px-4">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex max-w-40 shrink-0 items-center gap-1.5 truncate rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-foreground">
                <span
                  className="size-1.5 shrink-0 rounded-full bg-muted-foreground/60"
                  aria-hidden
                />
                <span className="truncate">{project}</span>
              </span>
              <span aria-hidden className="shrink-0 text-muted-foreground/50">
                ›
              </span>
              <DialogTitle className="truncate text-sm font-medium text-foreground">
                New work item
              </DialogTitle>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-foreground"
                onClick={() => setExpanded(!expanded)}
                aria-label={expanded ? "Collapse" : "Expand"}
                title={expanded ? "Collapse (reset height)" : "Expand (draft long notes)"}
                type="button"
              >
                {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-foreground"
                onClick={() => handleOpenChange(false)}
                aria-label="Close new work item"
                title="Close (Esc)"
                type="button"
              >
                <X className="size-4" />
              </Button>
            </div>
          </header>

          <div className="flex min-h-0 flex-1 flex-col px-4">
            {/* Prompt: one borderless title. Focus is implied — autofocused on open. */}
            <div
              className={cn(
                "flex shrink-0 flex-col pt-3",
                expanded && "min-h-0 flex-1 overflow-y-auto",
              )}
            >
              <textarea
                ref={titleRef}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void handleCreate();
                  }
                }}
                placeholder="What needs to happen?"
                rows={1}
                aria-label="Title"
                className={cn(
                  "resize-none overflow-y-auto bg-transparent text-lg font-medium text-foreground outline-none placeholder:text-muted-foreground/60",
                  expanded ? "min-h-[10vh] flex-1" : "min-h-[7rem] max-h-[40vh]",
                )}
              />
            </div>

            {/* Chip row: every option, one line, styled like the table cells. */}
            <div className="flex flex-wrap items-center gap-1.5 pt-3">
              <FieldChip
                ariaLabel="Status"
                value={status}
                options={STATUS_OPTIONS}
                onValueChange={setStatus}
                triggerClassName={cn(
                  "font-medium transition-opacity hover:opacity-80",
                  statusMeta.className,
                )}
              >
                <StatusIcon className="size-3.5 shrink-0" />
                <span className="truncate">{statusMeta.label}</span>
              </FieldChip>

              <FieldChip
                ariaLabel="Priority"
                value={priority}
                options={PRIORITY_OPTIONS}
                onValueChange={setPriority}
                triggerClassName={cn(
                  "border-transparent bg-transparent text-muted-foreground transition-colors hover:bg-secondary",
                  priority !== "none" && priorityTone(priority),
                )}
              >
                <Flag className="size-3.5 shrink-0" />
                <span className="truncate">{priorityLabel}</span>
              </FieldChip>

              <FieldChip
                ariaLabel="Source"
                value={source}
                options={sourceOptions}
                onValueChange={setSource}
                triggerClassName="border-transparent bg-transparent text-muted-foreground transition-colors hover:bg-secondary"
              >
                <span
                  className={cn("size-1.5 shrink-0 rounded-full", SOURCE_DOT[source])}
                  aria-hidden
                />
                <span className="truncate">{SOURCE_LABELS[source]}</span>
              </FieldChip>

              <div className="ml-auto flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => void handleEnhance()}
                  disabled={!title.trim() || !textGenAgentId || enhancing}
                  title={
                    textGenAgentId
                      ? "Polish the task with the configured agent"
                      : "Set up an agent in Settings to enhance tasks"
                  }
                >
                  {enhancing ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <WandSparkles className="size-3.5" />
                  )}
                  {enhancing ? "Enhancing…" : "Enhance"}
                </Button>
              </div>
            </div>

            {/* Run line: one dim line. Nothing re-centres while typing. */}
            <div className="flex min-h-7 shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="truncate">
                {source === "local"
                  ? "Saved to backend backlog"
                  : `Creates an issue in ${SOURCE_LABELS[source]} and mirrors it in backend backlog`}
              </span>
            </div>
          </div>

          {/* Footer: draft affordance left, the one action right. */}
          <footer className="flex h-14 shrink-0 items-center justify-between gap-2 border-t border-border/60 px-4">
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
              type="button"
              disabled
              title="Attach a file (coming soon)"
              aria-label="Attach a file"
            >
              <Paperclip className="size-4" />
            </Button>
            <div className="flex items-center gap-3">
              <span className="hidden items-center gap-1 text-[11px] text-muted-foreground sm:flex">
                <kbd className="rounded border border-border/60 px-1 font-sans">⌘</kbd>
                <kbd className="rounded border border-border/60 px-1 font-sans">↵</kbd>
              </span>
              <Button
                type="button"
                size="sm"
                onClick={() => void handleCreate()}
                disabled={!title.trim() || creating}
                className="h-8"
              >
                {creating ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    Creating…
                  </>
                ) : (
                  "Create"
                )}
              </Button>
            </div>
          </footer>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
