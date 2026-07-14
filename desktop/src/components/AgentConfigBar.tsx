import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

import { daemon } from "../daemon";
import type { ConfigOption } from "../protocol";

/** Renders the agent's session selectors, keeping at most one menu open. */
export function AgentConfigBar({ taskId, options }: { taskId: string; options: ConfigOption[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <>
      {options.map((opt) => (
        <AgentConfigSelect
          key={opt.id}
          taskId={taskId}
          opt={opt}
          open={openId === opt.id}
          onToggle={() => setOpenId((id) => (id === opt.id ? null : opt.id))}
          onClose={() => setOpenId((id) => (id === opt.id ? null : id))}
        />
      ))}
    </>
  );
}

function AgentConfigSelect({
  taskId,
  opt,
  open,
  onToggle,
  onClose,
}: {
  taskId: string;
  opt: ConfigOption;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const cur = opt.options.find((o) => o.value === opt.currentValue)?.name ?? opt.currentValue;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        onBlur={() => setTimeout(onClose, 120)}
        title={opt.name}
        className="flex items-center gap-0.5 rounded px-1.5 py-0.5 hover:bg-secondary hover:text-foreground"
      >
        {cur}
        <ChevronDown className="size-3 opacity-60" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-1 max-h-[50vh] min-w-[180px] overflow-y-auto rounded-md border bg-popover shadow-md">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            {opt.name}
          </div>
          {opt.options.map((o) => (
            <button
              type="button"
              key={o.value}
              onMouseDown={(e) => {
                e.preventDefault();
                onClose();
                if (o.value !== opt.currentValue) {
                  void daemon.request("session.setConfigOption", {
                    config_id: opt.id,
                    task_id: taskId,
                    value: o.value,
                  });
                }
              }}
              className={cn(
                "flex w-full items-center gap-2 px-2 py-1 text-left text-xs",
                o.value === opt.currentValue ? "bg-accent" : "hover:bg-accent/50",
              )}
            >
              <Check
                className={cn(
                  "size-3 shrink-0",
                  o.value === opt.currentValue ? "opacity-100" : "opacity-0",
                )}
              />
              <span className="truncate">{o.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
