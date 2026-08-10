import { Loader2, WandSparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { configRole } from "@/lib/configRole";
import { taskLabel } from "@/lib/taskLabel";
import { cn } from "@/lib/utils";

import { daemon } from "../daemon";
import type { TaskInfo } from "../protocol";

const MAX_TITLE_LENGTH = 80;

function generatedTitle(text: string): string {
  return (
    text
      .replace(/^```(?:text)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .split(/\r?\n/, 1)[0]
      ?.trim()
      .slice(0, MAX_TITLE_LENGTH) ?? ""
  );
}

export function TaskTitleEditor({ task }: { task: TaskInfo }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [regenerating, setRegenerating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const label = taskLabel(task);

  const startEditing = useCallback(() => {
    setDraft(label);
    setEditing(true);
  }, [label]);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const save = useCallback(async () => {
    setEditing(false);
    const nextTitle = draft.trim().slice(0, MAX_TITLE_LENGTH);
    if (nextTitle === label.trim()) return;

    try {
      await daemon.setTaskTitle(task.id, nextTitle);
    } catch (error) {
      toast.error("Could not save task title", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [draft, label, task.id]);

  const regenerate = useCallback(async () => {
    if (regenerating) return;
    setRegenerating(true);

    try {
      const model = task.configOptions?.find(
        (option) => configRole(option) === "model",
      )?.currentValue;
      const text = await daemon.generateText(task.id, task.agent, "task_title", model || undefined);
      const nextTitle = generatedTitle(text);
      if (!nextTitle) throw new Error("The agent returned an empty title");
      await daemon.setTaskTitle(task.id, nextTitle);
    } catch (error) {
      toast.error("Could not regenerate task title", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRegenerating(false);
    }
  }, [regenerating, task.agent, task.configOptions, task.id]);

  return (
    <div className="group/title flex min-w-0 flex-1 items-center gap-1" aria-busy={regenerating}>
      <h1 className={cn("min-w-0 max-w-full text-xs font-medium", editing && "flex-1")}>
        {editing ? (
          <input
            ref={inputRef}
            aria-label="Task title"
            className="w-full min-w-0 border-0 bg-transparent p-0 text-sm font-medium text-foreground outline-none ring-0 focus:outline-none focus:ring-0"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => void save()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void save();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            aria-label={`Edit task title: ${label}`}
            title="Double-click to edit task title"
            className="inline-flex max-w-full cursor-text items-center gap-1 text-left hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onDoubleClick={startEditing}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                startEditing();
              }
            }}
          >
            <span className="min-w-0 truncate">{label}</span>
            {regenerating && <Loader2 aria-hidden className="size-2.5 shrink-0 animate-spin" />}
          </button>
        )}
      </h1>
      {!editing && !regenerating && (
        <button
          type="button"
          aria-label="Regenerate task title"
          title="Regenerate task title"
          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-secondary hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover/title:opacity-100 disabled:cursor-wait disabled:opacity-100"
          onClick={() => void regenerate()}
        >
          <WandSparkles className="size-3" />
        </button>
      )}
    </div>
  );
}
