import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { Send, X, FileDiff, FilePlus, FilePen, FileMinus } from "lucide-react";
import { CommandInfo, FileDiff as FileDiffType } from "../protocol";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ComposerAttachment {
  id: string;
  filePath: string;
  status: FileDiffType["status"];
  content: string;
  addedLines: number;
  removedLines: number;
}

export interface ComposerHandle {
  attachDiff: (file: FileDiffType, formattedContent: string) => void;
}

const statusIcon = (s: FileDiffType["status"]) => {
  switch (s) {
    case "added": return <FilePlus className="size-3.5 text-emerald-400" />;
    case "deleted": return <FileMinus className="size-3.5 text-destructive" />;
    case "renamed": return <FilePen className="size-3.5 text-sky-400" />;
    default: return <FileDiff className="size-3.5 text-amber-400" />;
  }
};

/**
 * Chat composer: an auto-growing textarea with ↵ to send (⇧↵ for a newline) and a slash-command
 * menu fed by the agent's advertised commands (ACP available_commands). Supports
 * file diff attachments rendered as styled pills above the textarea.
 */
export const Composer = forwardRef<ComposerHandle, {
  onSend: (text: string) => void;
  commands?: CommandInfo[];
  placeholder?: string;
  disabled?: boolean;
  toolbar?: React.ReactNode;
}>(function Composer(
  { onSend, commands = [], placeholder = "Message or steer the agent…", disabled = false, toolbar },
  ref,
) {
  const [value, setValue] = useState("");
  const [menuIndex, setMenuIndex] = useState(0);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const activeItem = useRef<HTMLButtonElement>(null);

  useImperativeHandle(ref, () => ({
    attachDiff(file: FileDiffType, formattedContent: string) {
      const addedLines = file.hunks.reduce(
        (sum, h) => sum + h.lines.filter((l) => l.startsWith("+")).length, 0,
      );
      const removedLines = file.hunks.reduce(
        (sum, h) => sum + h.lines.filter((l) => l.startsWith("-")).length, 0,
      );
      setAttachments((prev) => [
        ...prev,
        {
          id: `${file.path}#${Date.now()}`,
          filePath: file.status === "renamed" && file.oldPath
            ? `${file.oldPath} → ${file.path}`
            : file.path,
          status: file.status,
          content: formattedContent,
          addedLines,
          removedLines,
        },
      ]);
      textRef.current?.focus();
    },
  }));

  // Auto-size to content, capped.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  // Slash menu: active when the whole input is a "/command" being typed.
  const slash = value.startsWith("/") && !value.includes(" ") ? value.slice(1).toLowerCase() : null;
  const matches =
    slash !== null ? commands.filter((c) => c.name.toLowerCase().startsWith(slash)) : [];
  const menuOpen = matches.length > 0;

  useEffect(() => setMenuIndex(0), [value]);

  // Keep the highlighted command visible as you arrow through the menu.
  useEffect(() => {
    activeItem.current?.scrollIntoView({ block: "nearest" });
  }, [menuIndex, menuOpen]);

  const send = () => {
    const text = value.trim();
    if ((!text && attachments.length === 0) || disabled) return;

    // Build message: user text + all attached diffs.
    const parts: string[] = [];
    if (text) parts.push(text);
    for (const a of attachments) {
      parts.push(`\`\`\`diff\n${a.content}\n\`\`\``);
    }
    onSend(parts.join("\n\n"));
    setValue("");
    setAttachments([]);
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const pickCommand = (c: CommandInfo) => {
    setValue(`/${c.name} `);
    textRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (menuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenuIndex((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenuIndex((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault();
        pickCommand(matches[menuIndex]);
        return;
      }
    }
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      send();
    }
  };

  const canSend = (value.trim() || attachments.length > 0) && !disabled;

  return (
    <div className="relative p-2">
      {menuOpen && (
        <div className="absolute bottom-full left-2 right-2 z-20 mb-1 max-h-[50vh] overflow-y-auto rounded-md border bg-popover shadow-md">
          {matches.map((c, i) => (
            <button
              type="button"
              key={c.name}
              ref={i === menuIndex ? activeItem : undefined}
              className={cn(
                "flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left text-sm",
                i === menuIndex ? "bg-accent" : "hover:bg-accent/50",
              )}
              onMouseEnter={() => setMenuIndex(i)}
              onClick={() => pickCommand(c)}
            >
              <span className="font-mono text-primary">/{c.name}</span>
              {c.description && (
                <span className="text-xs text-muted-foreground">{c.description}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {/* Zed-style: textarea + a controls row (model/mode selectors, send) in one box. */}
      <div className="flex flex-col rounded-lg border border-input bg-background focus-within:ring-2 focus-within:ring-ring">
        {/* Attachment pills */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-b border-input/50 px-2.5 pt-2 pb-2">
            {attachments.map((a) => (
              <div
                key={a.id}
                className="group flex items-center gap-1.5 rounded-md border border-border/80 bg-secondary/60 px-2 py-1 font-mono text-xs transition-colors hover:bg-secondary"
              >
                {statusIcon(a.status)}
                <span className="max-w-[180px] truncate text-foreground/80">{a.filePath}</span>
                <span className="text-muted-foreground">
                  <span className="text-emerald-400">+{a.addedLines}</span>
                  {" "}
                  <span className="text-destructive">-{a.removedLines}</span>
                </span>
                <button
                  type="button"
                  onClick={() => removeAttachment(a.id)}
                  className="ml-0.5 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                  title="Remove"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textRef}
          rows={2}
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={attachments.length > 0 ? "Add a message (optional)…" : placeholder}
          className="max-h-[220px] min-h-[76px] resize-none bg-transparent px-3 py-2.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none disabled:opacity-50"
        />
        <div className="flex items-center gap-1.5 px-2 pb-2 text-[11px] text-muted-foreground">
          {toolbar && <div className="flex flex-wrap items-center gap-1">{toolbar}</div>}
          <span className="ml-auto shrink-0">⇧↵ newline</span>
          <Button
            type="button"
            size="icon"
            className="size-7 shrink-0"
            onClick={send}
            disabled={!canSend}
          >
            <Send className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
});
