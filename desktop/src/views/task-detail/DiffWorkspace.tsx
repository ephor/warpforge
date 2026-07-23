import { useVirtualizer } from "@tanstack/react-virtual";
import { FileText } from "lucide-react";
import {
  forwardRef,
  lazy,
  Suspense,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";

import { daemon } from "../../daemon";
import type { FileDiff, HunkResolution, TaskDiff } from "../../protocol";
import { FileDiffView, fileAnchor } from "./FileDiffView";
import { useSplitFileQueries } from "./useTaskQueries";

const MergeDiff = lazy(async () => ({
  default: (await import("../../components/MergeDiff")).MergeDiff,
}));
const EMPTY_DIFF_FILES: FileDiff[] = [];

function EditorLoading() {
  return (
    <div className="flex h-full items-center px-4 text-sm text-muted-foreground">
      Loading editor…
    </div>
  );
}

function EmptyChangesState({ onOpenFiles }: { onOpenFiles: () => void }) {
  return (
    <div className="flex h-full min-h-56 flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="rounded-full border border-border/70 bg-secondary/40 p-3 text-muted-foreground">
        <FileText className="size-5" />
      </div>
      <div>
        <p className="text-sm font-medium text-foreground">No file changes yet</p>
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
          Continue the conversation, or open a project file while the agent is working.
        </p>
      </div>
      <Button type="button" size="sm" variant="outline" onClick={onOpenFiles}>
        <FileText className="size-3.5" />
        Open files
      </Button>
    </div>
  );
}

export interface DiffWorkspaceHandle {
  scrollToFile: (path: string) => void;
}

interface Props {
  diff: TaskDiff | null;
  diffError: string | null;
  diffView: "unified" | "split";
  editable: boolean;
  localRes: Record<string, HunkResolution>;
  onOpenFiles: () => void;
  onResolve: (file: string, hunkIndex: number, resolution: HunkResolution) => void;
  onSendToChat: (file: FileDiff) => void;
  taskId: string;
}

export const DiffWorkspace = forwardRef<DiffWorkspaceHandle, Props>(function DiffWorkspace(
  { diff, diffError, diffView, editable, localRes, onOpenFiles, onResolve, onSendToChat, taskId },
  ref,
) {
  const unifiedScrollParent = useRef<HTMLDivElement>(null);
  const splitScrollParent = useRef<HTMLDivElement>(null);
  const [splitRange, setSplitRange] = useState({ start: 0, end: -1 });
  const files = diff?.files ?? EMPTY_DIFF_FILES;

  const unifiedVirtualizer = useVirtualizer({
    count: files.length,
    estimateSize: () => 200,
    getScrollElement: () => unifiedScrollParent.current,
    overscan: 5,
  });
  const splitVirtualizer = useVirtualizer({
    count: files.length,
    estimateSize: () => 384,
    getScrollElement: () => splitScrollParent.current,
    overscan: 1,
  });
  const splitItems = splitVirtualizer.getVirtualItems();
  const splitVisibleStart = splitItems[0]?.index;
  const splitVisibleEnd = splitItems[splitItems.length - 1]?.index;

  useEffect(() => {
    if (splitVisibleStart === undefined || splitVisibleEnd === undefined) return;
    setSplitRange((current) =>
      current.start === splitVisibleStart && current.end === splitVisibleEnd
        ? current
        : { end: splitVisibleEnd, start: splitVisibleStart },
    );
  }, [splitVisibleEnd, splitVisibleStart]);

  const splitFileQueries = useSplitFileQueries(taskId, files, diffView === "split", splitRange);

  useImperativeHandle(
    ref,
    () => ({
      scrollToFile(path) {
        const index = files.findIndex((file) => file.path === path);
        if (index < 0) return;
        const virtualizer = diffView === "unified" ? unifiedVirtualizer : splitVirtualizer;
        virtualizer.scrollToIndex(index, { align: "start" });
        requestAnimationFrame(() => {
          document.getElementById(fileAnchor(path))?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        });
      },
    }),
    [diffView, files, splitVirtualizer, unifiedVirtualizer],
  );

  if (diffView === "unified") {
    return (
      <div ref={unifiedScrollParent} className="min-h-0 flex-1 overflow-auto p-3">
        {diffError && <p className="text-sm text-destructive">{diffError}</p>}
        {!diff && !diffError && <p className="text-sm text-muted-foreground">Loading diff…</p>}
        {diff && files.length === 0 && <EmptyChangesState onOpenFiles={onOpenFiles} />}
        {diff && files.length > 0 && (
          <div className="relative w-full" style={{ height: unifiedVirtualizer.getTotalSize() }}>
            {unifiedVirtualizer.getVirtualItems().map((item) => {
              const file = files[item.index];
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={unifiedVirtualizer.measureElement}
                  className="absolute left-0 top-0 w-full pb-3"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <FileDiffView
                    id={fileAnchor(file.path)}
                    file={file}
                    localRes={localRes}
                    onResolve={onResolve}
                    onSendToChat={onSendToChat}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={splitScrollParent} className="min-h-0 flex-1 overflow-auto">
      {!diff ? (
        <p className="p-3 text-sm text-muted-foreground">Loading diff…</p>
      ) : files.length === 0 ? (
        <EmptyChangesState onOpenFiles={onOpenFiles} />
      ) : (
        <div className="relative w-full" style={{ height: splitVirtualizer.getTotalSize() }}>
          {splitItems.map((item) => {
            const file = files[item.index];
            const query = splitFileQueries[item.index];
            const doc = query?.data;
            return (
              <div
                key={item.key}
                id={fileAnchor(file.path)}
                data-index={item.index}
                ref={splitVirtualizer.measureElement}
                className="absolute left-0 top-0 w-full border-b"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {doc ? (
                  <Suspense fallback={<EditorLoading />}>
                    <MergeDiff
                      key={`${doc.path}:${editable}`}
                      doc={doc}
                      editable={editable}
                      onSave={(content) =>
                        void daemon.request("file.save", {
                          content,
                          path: doc.path,
                          task_id: taskId,
                        })
                      }
                    />
                  </Suspense>
                ) : query?.error ? (
                  <p className="p-3 text-sm text-destructive">
                    Failed to load {file.path}: {query.error.message}
                  </p>
                ) : (
                  <p className="p-3 text-sm text-muted-foreground">Loading {file.path}…</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
