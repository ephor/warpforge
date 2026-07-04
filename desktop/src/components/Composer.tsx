import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { CommandInfo } from "../protocol";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Chat composer: an auto-growing textarea with ⌘↵ to send and a slash-command
 * menu fed by the agent's advertised commands (ACP available_commands). Styled
 * to feel like the composers in Claude Code / Codex / t3code.
 */
export function Composer({
  onSend,
  commands = [],
  placeholder = "Message or steer the agent…",
  disabled = false,
}: {
  onSend: (text: string) => void;
  commands?: CommandInfo[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const [value, setValue] = useState("");
  const [menuIndex, setMenuIndex] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const activeItem = useRef<HTMLButtonElement>(null);

  // Auto-size to content, capped.
  useLayoutEffect(() => {
    const el = ref.current;
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
    if (!text || disabled) return;
    onSend(text);
    setValue("");
  };

  const pickCommand = (c: CommandInfo) => {
    setValue(`/${c.name} `);
    ref.current?.focus();
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
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="relative border-t p-2">
      {menuOpen && (
        <div className="absolute bottom-full left-2 right-2 z-20 mb-1 max-h-[50vh] overflow-y-auto rounded-md border bg-popover shadow-md">
          {matches.map((c, i) => (
            <button
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
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className="max-h-[220px] min-h-[38px] flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        />
        <Button size="icon" onClick={send} disabled={!value.trim() || disabled}>
          <Send className="size-4" />
        </Button>
      </div>
      <div className="mt-1 flex items-center gap-3 px-1 text-[11px] text-muted-foreground">
        <span>⌘↵ send</span>
        {commands.length > 0 && <span>/ for commands</span>}
      </div>
    </div>
  );
}
