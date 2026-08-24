import { FileText, Loader2, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useEscapeToClose } from "@/hooks/useEscapeToClose";
import { getFileIconUrl } from "@/lib/fileIcon";
import { groupMatchesByFile, highlightSegments, splitPath } from "@/lib/searchMatches";
import { cn } from "@/lib/utils";

import type { SymbolMatch } from "../protocol";
import { FindInFilesPreview } from "./FindInFilesPreview";

/**
 * Project-wide text search (⌘/Ctrl ⇧ F). Results are grouped by file the way
 * an IDE's "Find in Files" shows them, arrow keys walk the matches across
 * groups, and Enter opens the file at the match's line. Like {@link QuickOpen}
 * it stays prop-driven: the host owns the search and file-read RPCs.
 */

const SEARCH_DEBOUNCE_MS = 200;
/** Matches the daemon's own `file.search` cap, so hitting it means "truncated". */
export const FIND_LIMIT = 200;

export function FindInFiles({
  open,
  onSearch,
  loadFile,
  onPick,
  onClose,
}: {
  open: boolean;
  onSearch: (query: string) => Promise<SymbolMatch[]>;
  loadFile: (path: string) => Promise<string>;
  onPick: (path: string, line: number, column: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<SymbolMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const trimmed = query.trim();

  useEscapeToClose(open, onClose);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open || trimmed === "") {
      setMatches([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      onSearch(trimmed)
        .then((found) => {
          if (cancelled) return;
          setMatches(found);
          setError(null);
          setActiveIndex(0);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setMatches([]);
          setError(cause instanceof Error ? cause.message : "Search failed");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [onSearch, open, trimmed]);

  const groups = useMemo(() => groupMatchesByFile(matches), [matches]);
  const flat = useMemo(() => groups.flatMap((group) => group.matches), [groups]);
  const active = flat[Math.min(activeIndex, Math.max(flat.length - 1, 0))] ?? null;

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const row = el.querySelector<HTMLElement>("[data-active='true']");
    if (row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, flat]);

  if (!open) return null;

  const choose = (match: SymbolMatch) => {
    onPick(match.path, match.line, match.column);
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const count = flat.length;
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
    if (event.key === "Enter" && active) {
      event.preventDefault();
      choose(active);
    }
  };

  let flatIndex = -1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[10vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex h-[70vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border bg-popover shadow-xl">
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            aria-label="Find in files"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Find in files…"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            className="h-11 min-w-0 flex-1 bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none"
          />
          {loading && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
        </div>
        <div className="border-b px-3 py-1.5 text-xs text-muted-foreground">
          {error ? (
            <span className="text-destructive">{error}</span>
          ) : trimmed === "" ? (
            "Type to search the project"
          ) : (
            <>
              {flat.length === FIND_LIMIT ? `First ${FIND_LIMIT}` : flat.length} result
              {flat.length === 1 ? "" : "s"} in {groups.length} file{groups.length === 1 ? "" : "s"}
            </>
          )}
        </div>
        <div ref={listRef} className="min-h-0 flex-[3] overflow-y-auto py-1">
          {groups.map((group) => {
            const { dir, name } = splitPath(group.path);
            const iconUrl = getFileIconUrl(group.path);
            return (
              <div key={group.path}>
                <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
                  {iconUrl ? (
                    <img src={iconUrl} alt="" aria-hidden className="size-3.5 shrink-0" />
                  ) : (
                    <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="font-medium">{name}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{dir}</span>
                  <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
                    {group.matches.length}
                  </span>
                </div>
                {group.matches.map((match) => {
                  flatIndex += 1;
                  const index = flatIndex;
                  return (
                    <button
                      key={`${match.line}:${match.column}`}
                      type="button"
                      data-active={index === activeIndex}
                      onMouseEnter={() => setActiveIndex(index)}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        choose(match);
                      }}
                      className={cn(
                        "flex w-full items-start gap-3 px-3 py-1 text-left font-mono text-xs",
                        index === activeIndex
                          ? "bg-accent text-accent-foreground"
                          : "text-foreground",
                      )}
                    >
                      <span className="w-10 shrink-0 select-none text-right text-muted-foreground">
                        {match.line}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {highlightSegments(match.text.trim(), trimmed).map((segment) => (
                          <span
                            key={segment.start}
                            className={segment.hit ? "rounded bg-info/25" : undefined}
                          >
                            {segment.text}
                          </span>
                        ))}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
          {!loading && trimmed !== "" && !error && flat.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">No matches</p>
          )}
        </div>
        <div className="flex min-h-0 flex-[2] flex-col">
          <FindInFilesPreview match={active} query={trimmed} loadFile={loadFile} />
        </div>
        <div className="flex shrink-0 items-center gap-3 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
          <span>↑↓ Navigate</span>
          <span>Enter Open file</span>
          <span>Esc Close</span>
        </div>
      </div>
    </div>
  );
}
