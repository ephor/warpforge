import { FilePlus2, FileText, Loader2, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { getFileIconUrl } from "@/lib/fileIcon";
import { rankFiles } from "@/lib/composerMentions";
import { cn } from "@/lib/utils";

import type { ProjectFile } from "../protocol";

/**
 * Quick-open palette — the "double ‹⇧› Shift" file switcher. Filters the
 * task's project files by the typed query (reusing the composer's file@ ranker)
 * and opens the pick on Enter. Remains local: no global store, driven entirely
 * by props from its host.
 */
export function QuickOpen({
  open,
  files,
  loading,
  error,
  onPick,
  onClose,
}: {
  open: boolean;
  files: ProjectFile[];
  loading: boolean;
  error: string | null;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const matches = useMemo(() => {
    if (query.trim() === "") return files.slice(0, 200);
    return rankFiles(files, query.trim()).slice(0, 200);
  }, [files, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  if (!open) return null;

  const choose = (path: string) => {
    onPick(path);
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    const count = matches.length;
    if (event.key === "ArrowDown" && count) {
      event.preventDefault();
      setActiveIndex((i) => (i + 1) % count);
      return;
    }
    if (event.key === "ArrowUp" && count) {
      event.preventDefault();
      setActiveIndex((i) => (i - 1 + count) % count);
      return;
    }
    if (event.key === "Enter" && count) {
      event.preventDefault();
      choose(matches[Math.min(activeIndex, count - 1)].path);
      return;
    }
  };

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>("[data-active='true']");
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[15vh]">
      <div className="w-full max-w-xl overflow-hidden rounded-lg border bg-popover shadow-xl">
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to file…"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            className="h-11 min-w-0 flex-1 bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none"
          />
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1.5">
          {loading && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Loading files…
            </div>
          )}
          {error && <p className="px-3 py-2 text-xs text-destructive">{error}</p>}
          {!loading && !error && matches.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">No matching files</p>
          )}
          {matches.map((file, index) => {
            const iconUrl = getFileIconUrl(file.path);
            return (
              <button
                key={file.path}
                type="button"
                data-active={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(file.path);
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs",
                  index === activeIndex ? "bg-accent text-accent-foreground" : "text-foreground",
                )}
              >
                {iconUrl ? (
                  <img src={iconUrl} alt="" aria-hidden className="size-3.5 shrink-0" />
                ) : (
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate">{file.path}</span>
                <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                  {file.changed && <span className="text-info">changed</span>}
                  <FilePlus2 className="size-3" />
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}