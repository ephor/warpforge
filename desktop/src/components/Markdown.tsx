import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { isExternalLink, openExternalLink } from "@/lib/externalLinks";
import { cn } from "@/lib/utils";

export type FileLinkResolver = (text: string) => string | null;

interface MarkdownContextValue {
  resolveFilePath?: FileLinkResolver;
  onOpenFile?: (path: string) => void;
}

const MarkdownContext = createContext<MarkdownContextValue>({});

const MarkdownAnchor: NonNullable<Components["a"]> = ({ children: content, href }) => {
  const { resolveFilePath, onOpenFile } = useContext(MarkdownContext);
  const external = Boolean(href && isExternalLink(href));

  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!href) return;
    if (external) {
      event.preventDefault();
      void openExternalLink(href);
      return;
    }
    const filePath = resolveFilePath?.(href);
    if (filePath && onOpenFile) {
      event.preventDefault();
      onOpenFile(filePath);
    }
  };

  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      className="text-primary underline"
      onClick={handleClick}
    >
      {content}
    </a>
  );
};

const MarkdownCode: NonNullable<Components["code"]> = ({
  className: codeClassName,
  children: content,
  ...rest
}) => {
  const { resolveFilePath, onOpenFile } = useContext(MarkdownContext);
  const inline = !codeClassName;
  const text = String(content ?? "");
  const filePath = inline ? resolveFilePath?.(text) : null;
  if (filePath && onOpenFile) {
    return (
      <button
        type="button"
        className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-primary underline decoration-primary/40 underline-offset-2 hover:bg-secondary hover:decoration-primary"
        title={`Open ${filePath}`}
        onClick={() => onOpenFile(filePath)}
      >
        {content}
      </button>
    );
  }
  return inline ? (
    <code
      className="break-words rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] [overflow-wrap:anywhere]"
      {...rest}
    >
      {content}
    </code>
  ) : (
    <code className={cn("font-mono", codeClassName)} {...rest}>
      {content}
    </code>
  );
};

const MARKDOWN_COMPONENTS: Components = {
  a: MarkdownAnchor,
  blockquote: ({ children: content }) => (
    <blockquote className="my-1 border-l-2 border-border pl-3 text-muted-foreground">
      {content}
    </blockquote>
  ),
  code: MarkdownCode,
  h1: ({ children: content }) => <h1 className="mb-1 mt-2 text-base font-semibold">{content}</h1>,
  h2: ({ children: content }) => <h2 className="mb-1 mt-2 text-sm font-semibold">{content}</h2>,
  h3: ({ children: content }) => <h3 className="mb-1 mt-2 text-sm font-semibold">{content}</h3>,
  ol: ({ children: content }) => <ol className="my-1 list-decimal space-y-0.5 pl-5">{content}</ol>,
  p: ({ children: content }) => <p className="my-1">{content}</p>,
  pre: ({ children: content }) => (
    <pre className="my-2 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/50 p-2.5 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
      {content}
    </pre>
  ),
  table: ({ children: content }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full table-fixed border-collapse text-xs">{content}</table>
    </div>
  ),
  td: ({ children: content }) => <td className="border border-border px-2 py-1">{content}</td>,
  th: ({ children: content }) => (
    <th className="border border-border px-2 py-1 text-left">{content}</th>
  ),
  ul: ({ children: content }) => <ul className="my-1 list-disc space-y-0.5 pl-5">{content}</ul>,
};

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
  const context = useMemo(() => ({ onOpenFile, resolveFilePath }), [onOpenFile, resolveFilePath]);

  return (
    <div
      className={cn(
        "min-w-0 space-y-1 break-words text-sm leading-relaxed [overflow-wrap:anywhere] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
    >
      <MarkdownContext.Provider value={context}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
          {children}
        </ReactMarkdown>
      </MarkdownContext.Provider>
    </div>
  );
}

const STREAM_MARKDOWN_INTERVAL_MS = 80;
const MAX_COLLAPSED_MESSAGE_LENGTH = 600;
const MAX_COLLAPSED_MESSAGE_LINES = 8;
const COLLAPSED_MESSAGE_MASK =
  "linear-gradient(to bottom, black calc(100% - 1.75rem), transparent)";

/** Bounds historical message geometry while keeping the full text one click away. */
export function CollapsibleMarkdown({
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
  const [expanded, setExpanded] = useState(false);
  const collapsible =
    children.length > MAX_COLLAPSED_MESSAGE_LENGTH ||
    children.split("\n").length > MAX_COLLAPSED_MESSAGE_LINES;
  const collapsed = collapsible && !expanded;

  return (
    <div>
      <div
        className={cn("relative", collapsed && "max-h-44 overflow-hidden")}
        style={
          collapsed
            ? {
                WebkitMaskImage: COLLAPSED_MESSAGE_MASK,
                maskImage: COLLAPSED_MESSAGE_MASK,
              }
            : undefined
        }
      >
        <Markdown className={className} resolveFilePath={resolveFilePath} onOpenFile={onOpenFile}>
          {children}
        </Markdown>
      </div>
      {collapsible && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="mt-1.5 h-6 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? "Show less" : "Show full message"}
        </button>
      )}
    </div>
  );
}

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

  useEffect(() => {
    latest.current = children;
  }, [children]);

  useEffect(() => {
    const timer = setInterval(() => {
      setDisplay((current) => (current === latest.current ? current : latest.current));
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return <Markdown {...rest}>{display}</Markdown>;
});
