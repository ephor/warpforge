import { cn } from "@/lib/utils";

import type { CommandInfo } from "../../protocol";

interface SlashCommandMenuProps {
  commands: CommandInfo[];
  menuIndex: number;
  onPick: (command: CommandInfo) => void;
  onHover: (index: number) => void;
}

export function SlashCommandMenu({ commands, menuIndex, onPick, onHover }: SlashCommandMenuProps) {
  return (
    <div className="absolute bottom-full left-2 right-2 z-20 mb-1 max-h-[50vh] overflow-y-auto rounded-md border bg-popover shadow-md">
      {commands.map((command, index) => (
        <button
          type="button"
          key={command.name}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(command);
          }}
          onMouseEnter={() => onHover(index)}
          className={cn(
            "flex w-full flex-col items-start px-3 py-1.5 text-left text-sm",
            index === menuIndex ? "bg-accent" : "hover:bg-accent/50",
          )}
        >
          <span className="font-mono text-primary">/{command.name}</span>
          {command.description && (
            <span className="text-xs text-muted-foreground">{command.description}</span>
          )}
        </button>
      ))}
    </div>
  );
}
