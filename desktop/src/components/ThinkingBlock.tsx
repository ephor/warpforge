import { Brain, ChevronRight, Loader2 } from "lucide-react";
import { memo, useEffect, useId, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import type { FileLinkResolver } from "./Markdown";
import { Markdown } from "./Markdown";

interface ThinkingBlockProps {
  text: string;
  streaming: boolean;
  resolveFilePath?: FileLinkResolver;
  onOpenFile?: (path: string) => void;
}

const MemoizedMarkdown = memo(Markdown);

/**
 * Reasoning stays visible while it is arriving, then gets out of the way when
 * the agent moves on. After completion its disclosure state belongs entirely
 * to the user.
 */
export const ThinkingBlock = memo(function ThinkingBlock({
  text,
  streaming,
  resolveFilePath,
  onOpenFile,
}: ThinkingBlockProps) {
  const contentId = useId();
  const [open, setOpen] = useState(streaming);
  const wasStreaming = useRef(streaming);

  // Only stream state transitions control the disclosure. Text deltas do not,
  // so a manual choice is not overwritten on every token. Completion closes
  // once; after that the user's choice remains authoritative.
  useEffect(() => {
    if (streaming !== wasStreaming.current) {
      setOpen(streaming);
    }
    wasStreaming.current = streaming;
  }, [streaming]);

  return (
    <section
      className={cn(
        "min-w-0 overflow-hidden rounded-lg border bg-secondary/20",
        streaming ? "border-border bg-secondary/30" : "border-border/70",
      )}
      aria-label="Agent thinking"
    >
      <button
        type="button"
        aria-controls={contentId}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "group flex min-h-9 w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground outline-none hover:bg-secondary/45 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-inset",
        )}
      >
        <span className="relative size-3.5 shrink-0" aria-hidden="true">
          <Brain className="absolute inset-0 size-3.5 transition-opacity motion-reduce:transition-none group-hover:opacity-0 group-focus-visible:opacity-0" />
          <ChevronRight
            className={cn(
              "absolute inset-0 size-3.5 opacity-0 transition-[transform,opacity] motion-reduce:transition-none group-hover:opacity-100 group-focus-visible:opacity-100",
              open && "rotate-90",
            )}
          />
        </span>
        <span className="flex-1">{streaming ? "Thinking…" : "Thinking"}</span>
        {streaming ? (
          <span className="flex items-center font-normal text-muted-foreground/60">
            <Loader2
              className="size-3 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          </span>
        ) : null}
      </button>
      {open && (
        <div id={contentId} className="border-t border-border/60 px-3 py-2.5">
          <MemoizedMarkdown
            className="text-muted-foreground [&_em]:text-foreground/80 [&_strong]:text-foreground/90"
            resolveFilePath={resolveFilePath}
            onOpenFile={onOpenFile}
          >
            {text}
          </MemoizedMarkdown>
        </div>
      )}
    </section>
  );
}, areThinkingPropsEqual);

function areThinkingPropsEqual(previous: ThinkingBlockProps, next: ThinkingBlockProps) {
  return (
    previous.text === next.text &&
    previous.streaming === next.streaming &&
    previous.resolveFilePath === next.resolveFilePath &&
    previous.onOpenFile === next.onOpenFile
  );
}
