import { ChevronDown, ClipboardCopy, MessageSquarePlus, RefreshCw } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { withOccurrenceKeys } from "@/lib/renderKeys";
import { cn } from "@/lib/utils";

import { daemon } from "../../daemon";
import { EMPTY_LOGS, FOLLOW_THRESHOLD_PX, LOG_DISPLAY_CAP } from "./constants";

interface SelectionState {
  text: string;
  top: number;
  left: number;
}

const LogViewer = memo(function LogViewer({
  logKey,
  kind,
  project,
  name,
  onAppendToChat,
}: {
  logKey: string;
  kind: "service" | "portforward";
  project: string;
  name: string;
  onAppendToChat?: (formattedLogs: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const prevScrollTopRef = useRef(0);
  const [showJumpButton, setShowJumpButton] = useState(false);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<"ok" | "error" | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);

  const liveLogs = useSyncExternalStore(daemon.subscribe, () => {
    const store =
      kind === "service" ? daemon.getState().serviceLogs : daemon.getState().portforwardLogs;
    return store[logKey] ?? EMPTY_LOGS;
  });

  const [fetchedLogs, setFetchedLogs] = useState<string[]>(EMPTY_LOGS);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const didInitialFetch = useRef(false);

  useEffect(() => {
    if (didInitialFetch.current) return;
    didInitialFetch.current = true;
    const fetcher =
      kind === "service"
        ? daemon.fetchServiceLogs(project, name, { after: 0, limit: 300 })
        : daemon.fetchPortForwardLogs(project, name, { after: 0, limit: 300 });
    fetcher.then(setFetchedLogs).catch((e: Error) => setFetchError(e.message));
  }, [kind, project, name]);

  const displayLogs = liveLogs.length > 0 ? liveLogs : fetchedLogs;
  const cappedLogs =
    displayLogs.length > LOG_DISPLAY_CAP ? displayLogs.slice(-LOG_DISPLAY_CAP) : displayLogs;

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    prevScrollTopRef.current = el.scrollTop;
  }, []);

  useEffect(() => {
    if (followingRef.current) {
      requestAnimationFrame(scrollToBottom);
    } else if (displayLogs.length > 0) {
      setShowJumpButton(true);
    }
  }, [displayLogs.length, scrollToBottom]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    prevScrollTopRef.current = el.scrollTop;
    const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
    const atBottom = distance <= FOLLOW_THRESHOLD_PX;

    if (atBottom) {
      followingRef.current = true;
      setShowJumpButton(false);
    } else {
      followingRef.current = false;
      setShowJumpButton(true);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current !== null) {
        clearTimeout(feedbackTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const handleSelectionChange = () => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        setSelection(null);
        return;
      }
      const container = scrollRef.current;
      if (!container) return;
      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        setSelection(null);
        return;
      }
      const text = sel.toString();
      if (!text.trim()) {
        setSelection(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const top = rect.bottom - containerRect.top + 8;
      const maxLeft = Math.max(containerRect.width - 180, 0);
      const left = Math.min(Math.max(rect.left - containerRect.left, 0), maxLeft);
      const clampedTop = Math.max(Math.min(top, containerRect.height - 32), 0);
      setSelection({ text, top: clampedTop, left });
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, []);

  const showCopyFeedback = useCallback((status: "ok" | "error") => {
    setCopyFeedback(status);
    if (feedbackTimerRef.current !== null) {
      clearTimeout(feedbackTimerRef.current);
    }
    feedbackTimerRef.current = window.setTimeout(() => setCopyFeedback(null), 1500);
  }, []);

  const handleCopy = useCallback(async () => {
    if (!selection) return;
    try {
      await navigator.clipboard.writeText(selection.text);
      showCopyFeedback("ok");
    } catch {
      showCopyFeedback("error");
    }
    setSelection(null);
    document.getSelection()?.removeAllRanges();
  }, [selection, showCopyFeedback]);

  const handleAddToChat = useCallback(() => {
    if (!selection || !onAppendToChat) return;
    const label = kind === "service" ? `service:${name}` : `portforward:${name}`;
    const formatted = `${label}\n\`\`\`\n${selection.text}\n\`\`\``;
    onAppendToChat(formatted);
    setSelection(null);
    document.getSelection()?.removeAllRanges();
  }, [selection, onAppendToChat, kind, name]);

  const handleRefresh = useCallback(() => {
    setFetchError(null);
    const fetcher =
      kind === "service"
        ? daemon.fetchServiceLogs(project, name, { after: 0, limit: 300 })
        : daemon.fetchPortForwardLogs(project, name, { after: 0, limit: 300 });
    fetcher.then(setFetchedLogs).catch((e: Error) => setFetchError(e.message));
  }, [kind, project, name]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto overflow-x-hidden px-3 py-2 font-mono text-xs leading-relaxed"
      >
        {fetchError ? (
          <pre className="whitespace-pre-wrap text-destructive">{fetchError}</pre>
        ) : cappedLogs.length === 0 ? (
          <pre className="text-muted-foreground">[{name}] no logs yet</pre>
        ) : (
          withOccurrenceKeys(cappedLogs, (line) => line).map(({ item: line, key }) => (
            <pre key={key} className="whitespace-pre-wrap break-all">
              <span className="select-none text-muted-foreground/50">$ </span>
              {line}
            </pre>
          ))
        )}
      </div>
      {selection && (
        <SelectionToolbar
          top={selection.top}
          left={selection.left}
          onCopy={handleCopy}
          onAddToChat={handleAddToChat}
          canAddToChat={!!onAppendToChat}
        />
      )}
      {copyFeedback && (
        <span
          className={cn(
            "absolute left-2 top-2 rounded border px-1.5 py-0.5 text-[10px]",
            copyFeedback === "ok"
              ? "border-ok/30 bg-ok/10 text-ok"
              : "border-destructive/30 bg-destructive/10 text-destructive",
          )}
          role="status"
          aria-live="polite"
        >
          {copyFeedback === "ok" ? "Copied" : "Copy failed"}
        </span>
      )}
      {showJumpButton && (
        <button
          type="button"
          onClick={() => {
            followingRef.current = true;
            setShowJumpButton(false);
            scrollToBottom();
          }}
          className="absolute bottom-2 right-3 flex items-center gap-1 rounded-md border bg-card px-2 py-1 text-[10px] text-muted-foreground shadow-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Jump to latest log line"
        >
          <ChevronDown className="size-3" />
          Jump to latest
        </button>
      )}
      <button
        type="button"
        onClick={handleRefresh}
        className="absolute right-2 top-2 rounded p-1 text-muted-foreground/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title="Refresh logs"
        aria-label="Refresh logs"
      >
        <RefreshCw className="size-3" />
      </button>
    </div>
  );
});

const SelectionToolbar = memo(function SelectionToolbar({
  top,
  left,
  onCopy,
  onAddToChat,
  canAddToChat,
}: {
  top: number;
  left: number;
  onCopy: () => void;
  onAddToChat: () => void;
  canAddToChat: boolean;
}) {
  return (
    <div
      className="pointer-events-auto absolute z-30 flex items-center gap-0.5 rounded-md border bg-card px-1 py-0.5 shadow-md"
      style={{ top, left }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        onClick={onCopy}
        className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title="Copy selected text"
        aria-label="Copy selected log text"
      >
        <ClipboardCopy className="size-3" />
        Copy
      </button>
      {canAddToChat && (
        <button
          type="button"
          onClick={onAddToChat}
          className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title="Add selection to chat composer"
          aria-label="Add selected log text to chat"
        >
          <MessageSquarePlus className="size-3" />
          Add to chat
        </button>
      )}
    </div>
  );
});

export { LogViewer };
