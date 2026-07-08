import { useEffect, useState } from "react";
import { GitCommitVertical } from "lucide-react";
import { daemon } from "../daemon";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Inline commit box (JetBrains-style): per-file staging checkboxes, a message,
 * amend toggle, and Commit. Sits under the changed-files tree.
 */
export function CommitBox({
  taskId,
  files,
  onCommitted,
}: {
  taskId: string;
  files: string[];
  onCommitted: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(files));
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep the selection in step as the diff's file set changes.
  useEffect(() => {
    setSelected((prev) => new Set(files.filter((f) => prev.has(f) || !prev.size)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files.join("\n")]);

  const toggle = (f: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(f) ? next.delete(f) : next.add(f);
      return next;
    });

  const canCommit = !busy && selected.size > 0 && (message.trim().length > 0 || amend);

  const commit = async () => {
    setBusy(true);
    setError(null);
    try {
      const all = selected.size === files.length;
      await daemon.request("git.commit", {
        task_id: taskId,
        message: message.trim(),
        files: all ? null : [...selected],
        amend,
      });
      setMessage("");
      setAmend(false);
      onCommitted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 border-t p-2">
      <div className="max-h-32 overflow-auto">
        {files.map((f) => {
          const name = f.split("/").pop() ?? f;
          return (
            <label
              key={f}
              className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-xs hover:bg-secondary/50"
              title={f}
            >
              <input
                type="checkbox"
                checked={selected.has(f)}
                onChange={() => toggle(f)}
                className="size-3 shrink-0"
              />
              <span className="truncate font-mono">{name}</span>
            </label>
          );
        })}
      </div>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Commit message"
        rows={3}
        className="w-full resize-none rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-2">
        <label className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={amend}
            onChange={(e) => setAmend(e.target.checked)}
            className="size-3"
          />
          amend
        </label>
        <Button
          size="sm"
          className={cn("ml-auto h-7", !canCommit && "opacity-50")}
          disabled={!canCommit}
          onClick={commit}
        >
          <GitCommitVertical className="size-3.5" />
          {busy ? "…" : amend ? "Amend" : "Commit"}
        </Button>
      </div>
    </div>
  );
}
