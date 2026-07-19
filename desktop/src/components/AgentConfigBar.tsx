import { Check, ChevronDown, Settings2 } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

import { daemon } from "../daemon";
import type { ConfigOption } from "../protocol";

/** Renders the agent's session selectors, keeping at most one menu open. */
export function AgentConfigBar({ taskId, options }: { taskId: string; options: ConfigOption[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const model = options.find((option) => configRole(option) === "model");
  const effort = options.find((option) => configRole(option) === "effort");
  const primary = [model, effort].filter((option): option is ConfigOption => Boolean(option));
  const primaryIds = new Set(primary.map((option) => option.id));
  const overflow = options.filter((option) => !primaryIds.has(option.id));
  return (
    <>
      {primary.map((opt) => (
        <AgentConfigSelect
          key={opt.id}
          taskId={taskId}
          opt={opt}
          open={openId === opt.id}
          onToggle={() => setOpenId((id) => (id === opt.id ? null : opt.id))}
          onClose={() => setOpenId((id) => (id === opt.id ? null : id))}
        />
      ))}
      {overflow.length > 0 && (
        <div className="relative">
          <button
            type="button"
            aria-label="More agent settings"
            title="More agent settings"
            onClick={() => setMoreOpen((open) => !open)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-secondary hover:text-foreground"
          >
            <Settings2 className="size-3" />
            <span>More</span>
          </button>
          {moreOpen && (
            <div className="absolute bottom-full left-0 z-20 mb-1 flex min-w-[220px] flex-col gap-1 rounded-md border bg-popover p-1.5 shadow-md">
              {overflow.map((opt) => (
                <div key={opt.id} className="flex items-center justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate px-1 text-muted-foreground">{opt.name}</span>
                  <AgentConfigSelect
                    taskId={taskId}
                    opt={opt}
                    open={openId === opt.id}
                    onToggle={() => setOpenId((id) => (id === opt.id ? null : opt.id))}
                    onClose={() => setOpenId((id) => (id === opt.id ? null : id))}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function configRole(option: ConfigOption): "model" | "effort" | null {
  const identity = `${option.category ?? ""} ${option.id} ${option.name}`.toLowerCase();
  if (identity.includes("model")) return "model";
  if (/effort|reasoning|thought[_ -]?level/.test(identity)) return "effort";
  return null;
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
        aria-label={`${opt.name}: ${cur}`}
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
