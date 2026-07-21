import { Check, ChevronDown, Loader2, Settings2 } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

import { daemon } from "../daemon";
import type { ConfigOption } from "../protocol";

/**
 * Renders the agent's session selectors (model / effort / ...), keeping at
 * most one menu open. Used in two modes:
 *
 *  - **Post-start** (MissionControl composer toolbar): pass `taskId` and omit
 *    `onSelect`. Each pick sends `session.setConfigOption` to the live session
 *    and the highlight follows `opt.currentValue` returned by the agent.
 *  - **Pre-start** (New Task view): pass `onSelect` together with `picks`
 *    (optId → chosen value, `undefined` = agent default). Selections are
 *    captured into the caller's state and rolled into the subsequent
 *    `task.create.default_model` payload — no live session yet, so no RPC.
 *    `loading` swaps the row for a spinner while the daemon probes the agent
 *    for its cached selectors.
 */
export function AgentConfigBar({
  taskId,
  options,
  onSelect,
  picks,
  loading,
}: {
  taskId?: string;
  options: ConfigOption[];
  /** Intercept a pick (pre-start). When omitted, a post-start pick is sent to
   *  the live session via `session.setConfigOption`. */
  onSelect?: (opt: ConfigOption, value: string | undefined) => void;
  /** Pre-start only: caller's currently picked value per option id, overriding
   *  the agent's cached `currentValue` for the trigger label + highlight. */
  picks?: Record<string, string | undefined>;
  /** Show a spinner instead of pickers while the daemon probes the agent. */
  loading?: boolean;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const valueFor = (opt: ConfigOption): string | undefined =>
    picks ? picks[opt.id] : opt.currentValue;

  if (loading) {
    return (
      <span className="flex items-center gap-1 px-1 py-0.5 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Probe…
      </span>
    );
  }

  const model = options.find((option) => configRole(option) === "model");
  const effort = options.find((option) => configRole(option) === "effort");
  const primary = [model, effort].filter((option): option is ConfigOption => Boolean(option));
  const primaryIds = new Set(primary.map((option) => option.id));

  if (primary.length === 0) return null;

  const overflow = options.filter((option) => !primaryIds.has(option.id));
  return (
    <>
      {primary.map((opt) => (
        <AgentConfigSelect
          key={opt.id}
          taskId={taskId}
          opt={opt}
          currentValue={valueFor(opt)}
          onSelect={onSelect}
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
                    currentValue={valueFor(opt)}
                    onSelect={onSelect}
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
  currentValue,
  onSelect,
  open,
  onToggle,
  onClose,
}: {
  taskId?: string;
  opt: ConfigOption;
  /** Currently selected value: post-start this comes from `opt.currentValue`
   *  (live session); pre-start the caller supplies its own pick. */
  currentValue: string | undefined;
  onSelect?: (opt: ConfigOption, value: string | undefined) => void;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const cur =
    currentValue !== undefined
      ? opt.options.find((o) => o.value === currentValue)?.name ?? currentValue
      : "Default";

  const pick = (value: string | undefined) => {
    if (onSelect) {
      onSelect(opt, value);
      return;
    }
    if (value !== undefined && taskId) {
      void daemon.request("session.setConfigOption", {
        config_id: opt.id,
        task_id: taskId,
        value,
      });
    }
  };

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
        <div className="absolute bottom-full left-0 z-30 mb-1 max-h-60 min-w-[180px] overflow-y-auto rounded-md border bg-popover shadow-md">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            {opt.name}
          </div>
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              onClose();
              pick(undefined);
            }}
            className={cn(
              "flex w-full items-center gap-2 px-2 py-1 text-left text-xs",
              currentValue === undefined ? "bg-accent" : "hover:bg-accent/50",
            )}
          >
            <Check
              className={cn(
                "size-3 shrink-0",
                currentValue === undefined ? "opacity-100" : "opacity-0",
              )}
            />
            <span className="truncate">Default (agent&apos;s own)</span>
          </button>
          {opt.options.map((o) => (
            <button
              type="button"
              key={o.value}
              onMouseDown={(e) => {
                e.preventDefault();
                onClose();
                if (o.value !== currentValue) pick(o.value);
              }}
              className={cn(
                "flex w-full items-center gap-2 px-2 py-1 text-left text-xs",
                o.value === currentValue ? "bg-accent" : "hover:bg-accent/50",
              )}
            >
              <Check
                className={cn(
                  "size-3 shrink-0",
                  o.value === currentValue ? "opacity-100" : "opacity-0",
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