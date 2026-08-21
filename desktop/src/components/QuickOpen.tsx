import { FilePlus2, FileText, Loader2, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useEscapeToClose } from "@/hooks/useEscapeToClose";
import { rankFiles } from "@/lib/composerMentions";
import { getFileIconUrl } from "@/lib/fileIcon";
import { highlightSegments } from "@/lib/searchMatches";
import { cn } from "@/lib/utils";

import type { ProjectFile, SymbolMatch } from "../protocol";

/**
 * Quick-open palette — the "double ‹⇧› Shift" file switcher. Filters the
 * task's project files by the typed query (reusing the composer's file@ ranker)
 * and opens the pick on Enter. When a text search is wired in, matching source
 * lines follow the files and open the file at that line. Remains local: no
 * global store, driven entirely by props from its host.
 */

/** File hits stay a short head above text hits so both fit one arrow-able list. */
const FILE_HITS_WITH_QUERY = 20;
const TEXT_HITS = 30;
const SEARCH_DEBOUNCE_MS = 180;
/** One- or two-letter queries match half the repo — not worth a project walk. */
const MIN_TEXT_QUERY = 3;

type Item =
  | { kind: "file"; key: string; file: ProjectFile }
  | { kind: "text"; key: string; match: SymbolMatch };

export function QuickOpen({
  open,
  files,
  loading,
  error,
  onSearch,
  onPick,
  onClose,
}: {
  open: boolean;
  files: ProjectFile[];
  loading: boolean;
  error: string | null;
  /** Plain-text project search; omitted, the palette stays file-only. */
  onSearch?: (query: string) => Promise<SymbolMatch[]>;
  onPick: (path: string, location?: { line: number; column: number }) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [textMatches, setTextMatches] = useState<SymbolMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    setTextMatches([]);
    setSearching(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const trimmed = query.trim();

  useEscapeToClose(open, onClose);

  useEffect(() => {
    if (!open || !onSearch || trimmed.length < MIN_TEXT_QUERY) {
      setTextMatches([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    // Marked as searching from the keystroke, not from the request: the debounce
    // is part of the wait the user is looking at.
    setSearching(true);
    const timer = setTimeout(() => {
      onSearch(trimmed)
        .then((matches) => {
          if (!cancelled) setTextMatches(matches.slice(0, TEXT_HITS));
        })
        .catch(() => {
          if (!cancelled) setTextMatches([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [onSearch, open, trimmed]);

  const items = useMemo<Item[]>(() => {
    const matched =
      trimmed === ""
        ? files.slice(0, 200)
        : rankFiles(files, trimmed).slice(0, FILE_HITS_WITH_QUERY);
    const fileItems: Item[] = matched.map((file) => ({
      file,
      key: `file:${file.path}`,
      kind: "file",
    }));
    const textItems: Item[] = textMatches.map((match) => ({
      key: `text:${match.path}:${match.line}:${match.column}`,
      kind: "text",
      match,
    }));
    return [...fileItems, ...textItems];
  }, [files, textMatches, trimmed]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>("[data-active='true']");
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, items]);

  if (!open) return null;

  const choose = (item: Item) => {
    if (item.kind === "file") {
      onPick(item.file.path);
    } else {
      onPick(item.match.path, { column: item.match.column, line: item.match.line });
    }
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const count = items.length;
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
      choose(items[Math.min(activeIndex, count - 1)]);
      return;
    }
  };

  const firstTextIndex = items.findIndex((item) => item.kind === "text");

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[15vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-xl overflow-hidden rounded-lg border bg-popover shadow-xl">
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            aria-label="Jump to file"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to file…"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            className="h-11 min-w-0 flex-1 bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none"
          />
          {searching && (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          )}
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1.5">
          {loading && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Loading files…
            </div>
          )}
          {error && <p className="px-3 py-2 text-xs text-destructive">{error}</p>}
          {!loading && !error && items.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              {searching ? "Searching…" : "No matching files"}
            </p>
          )}
          {items.map((item, index) => (
            <div key={item.key}>
              {index === firstTextIndex && (
                <p className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                  Text
                </p>
              )}
              <button
                type="button"
                data-active={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(item);
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs",
                  index === activeIndex ? "bg-accent text-accent-foreground" : "text-foreground",
                )}
              >
                <RowIcon path={item.kind === "file" ? item.file.path : item.match.path} />
                {item.kind === "file" ? (
                  <>
                    <span className="min-w-0 flex-1 truncate">{item.file.path}</span>
                    <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                      {item.file.changed && <span className="text-info">changed</span>}
                      <FilePlus2 className="size-3" />
                    </span>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate">
                      {highlightSegments(item.match.text.trim(), trimmed).map((segment) => (
                        <span
                          key={segment.start}
                          className={segment.hit ? "rounded bg-info/25" : undefined}
                        >
                          {segment.text}
                        </span>
                      ))}
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {item.match.path.split("/").pop()}:{item.match.line}
                    </span>
                  </>
                )}
              </button>
            </div>
          ))}
          {searching && firstTextIndex === -1 && items.length > 0 && (
            <p className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Searching text
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function RowIcon({ path }: { path: string }) {
  const iconUrl = getFileIconUrl(path);
  return iconUrl ? (
    <img src={iconUrl} alt="" aria-hidden className="size-3.5 shrink-0" />
  ) : (
    <FileText className="size-3.5 shrink-0 text-muted-foreground" />
  );
}
