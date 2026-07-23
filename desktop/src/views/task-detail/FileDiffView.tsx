import { Check, ChevronDown, Send, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { withOccurrenceKeys } from "@/lib/renderKeys";
import { cn } from "@/lib/utils";

import type { FileDiff, HunkResolution } from "../../protocol";

export const fileAnchor = (path: string) => `diff-${path.replace(/[^a-zA-Z0-9]/g, "-")}`;

export function formatFileDiffAsMessage(file: FileDiff): string {
  const header =
    file.oldPath && file.oldPath !== file.path
      ? `diff --git a/${file.oldPath} b/${file.path}`
      : `diff --git a/${file.path} b/${file.path}`;
  const statusLine =
    file.status === "added"
      ? `new file mode 100644`
      : file.status === "deleted"
        ? `deleted file mode 100644`
        : file.status === "renamed"
          ? `rename from ${file.oldPath}\nrename to ${file.path}`
          : `index ---..+++ 100644`;

  const hunkHeaders = file.hunks.map(
    (h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
  );
  const lines = file.hunks.flatMap((h) => h.lines);

  return `${header}\n${statusLine}\n${hunkHeaders.join("\n")}\n${lines.join("\n")}`;
}

export function FileDiffView({
  id,
  file,
  localRes,
  onResolve,
  onSendToChat,
}: {
  id?: string;
  file: FileDiff;
  localRes: Record<string, HunkResolution>;
  onResolve: (file: string, hunkIndex: number, r: HunkResolution) => void;
  onSendToChat?: (file: FileDiff) => void;
}) {
  const [open, setOpen] = useState(true);
  const statusColor =
    file.status === "added"
      ? "text-ok"
      : file.status === "deleted"
        ? "text-destructive"
        : "text-warn";

  return (
    <div id={id} className="mb-3 scroll-mt-2 overflow-hidden rounded-md border">
      <button
        type="button"
        className="flex w-full items-center gap-2 bg-secondary/50 px-3 py-2 text-left font-mono text-xs hover:bg-secondary"
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
        <span className={cn("uppercase", statusColor)}>{file.status}</span>
        <span>
          {file.status === "renamed" && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        {onSendToChat && (
          <span className="ml-auto flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground"
              title="Send this file's diff to chat"
              onClick={(e) => {
                e.stopPropagation();
                onSendToChat(file);
              }}
            >
              <Send className="size-3" />
              send
            </Button>
          </span>
        )}
      </button>
      {open &&
        file.hunks.map((hunk, i) => {
          const resolution = hunk.resolution ?? localRes[`${file.path}#${i}`] ?? null;
          return (
            <div
              key={`${hunk.oldStart}:${hunk.oldLines}:${hunk.newStart}:${hunk.newLines}`}
              className={cn(
                "border-t",
                resolution === "accept" && "border-l-2 border-l-ok",
                resolution === "reject" && "border-l-2 border-l-destructive opacity-50",
              )}
            >
              <div className="flex items-center justify-between bg-muted/40 px-3 py-1">
                <code className="tnum text-xs text-muted-foreground">
                  @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
                </code>
                <div className="flex gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant={resolution === "accept" ? "default" : "outline"}
                    className="h-6"
                    onClick={() => onResolve(file.path, i, "accept")}
                  >
                    <Check className="size-3" />
                    accept
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={resolution === "reject" ? "destructive" : "outline"}
                    className="h-6"
                    onClick={() => onResolve(file.path, i, "reject")}
                  >
                    <X className="size-3" />
                    reject
                  </Button>
                </div>
              </div>
              <pre className="overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed">
                {withOccurrenceKeys(hunk.lines, (line) => line).map(({ item: line, key }) => (
                  <div
                    key={`${hunk.oldStart}:${hunk.newStart}:${key}`}
                    className={cn(
                      "px-1",
                      line.startsWith("+") && "bg-ok/10 text-ok",
                      line.startsWith("-") && "bg-destructive/10 text-destructive",
                    )}
                  >
                    {line || " "}
                  </div>
                ))}
              </pre>
            </div>
          );
        })}
    </div>
  );
}
