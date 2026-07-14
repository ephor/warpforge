import type { ProjectFile } from "../../protocol";
import { cn } from "@/lib/utils";

export function FileMentionMenu({ files, activeIndex, loading, onActive, onPick }: {
  files: ProjectFile[]; activeIndex: number; loading: boolean;
  onActive: (index: number) => void; onPick: (file: ProjectFile) => void;
}) {
  return (
    <div className="absolute bottom-full left-2 right-2 z-30 mb-1 max-h-64 overflow-y-auto rounded-md border bg-popover shadow-md">
      {loading && <div className="px-3 py-2 text-xs text-muted-foreground">Loading files…</div>}
      {!loading && files.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">No matching files</div>}
      {files.map((file, index) => (
        <button key={file.path} type="button" onMouseEnter={() => onActive(index)}
          onMouseDown={(event) => { event.preventDefault(); onPick(file); }}
          className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs", index === activeIndex ? "bg-accent" : "hover:bg-accent/50")}
        >
          <span className="min-w-0 flex-1 truncate">{file.path}</span>
          {file.changed && <span className="text-amber-400">changed</span>}
        </button>
      ))}
    </div>
  );
}
