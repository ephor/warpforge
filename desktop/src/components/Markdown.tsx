import { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { isExternalLink, openExternalLink } from "@/lib/externalLinks";
import { cn } from "@/lib/utils";

export type FileLinkResolver = (text: string) => string | null;

/** Agent/user messages rendered as GitHub-flavored markdown, tailwind-styled. */
export function Markdown({
  children,
  className,
  resolveFilePath,
  onOpenFile,
}: {
  children: string;
  className?: string;
  resolveFilePath?: FileLinkResolver;
  onOpenFile?: (path: string) => void;
}) {
  return (
    <div
      className={cn(
        "min-w-0 space-y-1 break-words text-sm leading-relaxed [overflow-wrap:anywhere] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => {
            const external = Boolean(href && isExternalLink(href));
            return (
              <a
                href={href}
                target={external ? "_blank" : undefined}
                rel={external ? "noreferrer" : undefined}
                className="text-primary underline"
                onClick={(event) => {
                  if (!href || !external) return;
                  event.preventDefault();
                  void openExternalLink(href);
                }}
              >
                {children}
              </a>
            );
          },
          blockquote: ({ children }) => (
            <blockquote className="my-1 border-l-2 border-border pl-3 text-muted-foreground">
              {children}
            </blockquote>
          ),
          code: ({ className, children, ...rest }) => {
            const inline = !className;
            const text = String(children ?? "");
            const filePath = inline ? resolveFilePath?.(text) : null;
            if (filePath && onOpenFile) {
              return (
                <button
                  type="button"
                  className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-primary underline decoration-primary/40 underline-offset-2 hover:bg-secondary hover:decoration-primary"
                  title={`Open ${filePath}`}
                  onClick={() => onOpenFile(filePath)}
                >
                  {children}
                </button>
              );
            }
            return inline ? (
              <code
                className="break-words rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] [overflow-wrap:anywhere]"
                {...rest}
              >
                {children}
              </code>
            ) : (
              <code className={cn("font-mono", className)} {...rest}>
                {children}
              </code>
            );
          },
          h1: ({ children }) => <h1 className="mb-1 mt-2 text-base font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-1 mt-2 text-sm font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1 mt-2 text-sm font-semibold">{children}</h3>,
          ol: ({ children }) => <ol className="my-1 list-decimal space-y-0.5 pl-5">{children}</ol>,
          p: ({ children }) => <p className="my-1">{children}</p>,
          pre: ({ children }) => (
            <pre className="my-2 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/50 p-2.5 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
          th: ({ children }) => (
            <th className="border border-border px-2 py-1 text-left">{children}</th>
          ),
          ul: ({ children }) => <ul className="my-1 list-disc space-y-0.5 pl-5">{children}</ul>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

const STREAM_MARKDOWN_INTERVAL_MS = 80;

/**
 * Markdown for actively-streaming assistant text. ACP emits sub-word deltas;
 * re-parsing GFM on every one starves the main thread (composer input, scroll).
 * This renders the first value immediately, then coalesces later changes to at
 * most one re-parse per interval, always converging on the latest text — the
 * final delta of a turn flushes within one interval.
 */
export const BufferedMarkdown = memo(function BufferedMarkdown({
  children,
  intervalMs = STREAM_MARKDOWN_INTERVAL_MS,
  ...rest
}: {
  children: string;
  className?: string;
  resolveFilePath?: FileLinkResolver;
  onOpenFile?: (path: string) => void;
  intervalMs?: number;
}) {
  const [display, setDisplay] = useState(children);
  const latest = useRef(children);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    latest.current = children;
    // Already showing the latest, or a flush is already scheduled that will
    // pick it up: nothing to schedule.
    if (children === display || timer.current) {
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      setDisplay(latest.current);
    }, intervalMs);
  }, [children, display, intervalMs]);

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  return <Markdown {...rest}>{display}</Markdown>;
});
