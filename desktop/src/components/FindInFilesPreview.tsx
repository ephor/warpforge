import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { highlightSegments, previewWindow, splitPath } from "@/lib/searchMatches";
import { cn } from "@/lib/utils";

import type { SymbolMatch } from "../protocol";

/**
 * Read-only peek at the active Find-in-Files hit: the matched line plus a few
 * lines of context, fetched through `loadFile` and cached per path so arrowing
 * within one file never refetches.
 */
export function FindInFilesPreview({
  match,
  query,
  loadFile,
}: {
  match: SymbolMatch | null;
  query: string;
  loadFile: (path: string) => Promise<string>;
}) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const cacheRef = useRef(new Map<string, string>());
  const path = match?.path ?? null;

  useEffect(() => {
    if (!path) {
      setText(null);
      return;
    }
    const cached = cacheRef.current.get(path);
    if (cached !== undefined) {
      setText(cached);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    loadFile(path)
      .then((content) => {
        cacheRef.current.set(path, content);
        if (!cancelled) setText(content);
      })
      .catch(() => {
        if (!cancelled) setText(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadFile, path]);

  if (!match) return null;

  const { dir, name } = splitPath(match.path);
  const window = text === null ? null : previewWindow(text, match.line);

  return (
    <div className="flex min-h-0 flex-col border-t bg-muted/20">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <span className="font-medium">{name}</span>
        <span className="truncate text-muted-foreground">{dir}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-2 font-mono text-xs">
        {loading && !window && (
          <div className="flex items-center gap-2 px-2 py-2 text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Loading preview…
          </div>
        )}
        {!loading && !window && <p className="px-2 py-2 text-muted-foreground">No preview</p>}
        {window?.lines.map((line, index) => {
          const lineNumber = window.firstLine + index;
          const isMatch = lineNumber === match.line;
          return (
            <div
              key={lineNumber}
              className={cn("flex gap-3 px-2", isMatch && "rounded bg-accent/60")}
            >
              <span className="w-10 shrink-0 select-none text-right text-muted-foreground">
                {lineNumber}
              </span>
              <span className="whitespace-pre">
                {isMatch
                  ? highlightSegments(line, query).map((segment) => (
                      <span
                        key={segment.start}
                        className={segment.hit ? "rounded bg-info/30" : undefined}
                      >
                        {segment.text}
                      </span>
                    ))
                  : line}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
