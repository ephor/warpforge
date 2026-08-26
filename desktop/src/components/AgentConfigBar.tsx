import { Check, ChevronDown, Loader2, Search, Settings2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { configRole } from "@/lib/configRole";
import { cn } from "@/lib/utils";

import { daemon } from "../daemon";
import type { ConfigOption } from "../protocol";

/** Above this many choices a dropdown gets a filter box; below it, none. */
const SEARCH_MIN_OPTIONS = 8;

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
  const moreRef = useRef<HTMLDivElement | null>(null);
  const valueFor = (opt: ConfigOption): string | undefined =>
    picks ? picks[opt.id] : opt.currentValue;

  // Treat the "More" panel like a picker: a press anywhere outside it closes
  // it (and, since its inline selectors live inside the panel, leaves their
  // own state to their pointerdown handler). Uses pointerdown so clicks that
  // don't move focus (textarea, editor) still dismiss it.
  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (moreRef.current?.contains(event.target as Node | null)) return;
      setMoreOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [moreOpen]);

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
        <div className="relative" ref={moreRef}>
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
  // Post-start picks only land once the agent echoes the new `configOptions`
  // back, which takes a round-trip. Show the pick immediately and drop it if
  // the agent refuses, so a click never looks like it did nothing.
  const [pendingValue, setPendingValue] = useState<string | null>(null);
  const shownValue = pendingValue ?? currentValue;
  useEffect(() => {
    if (pendingValue !== null && currentValue === pendingValue) setPendingValue(null);
  }, [currentValue, pendingValue]);

  const cur =
    shownValue !== undefined
      ? (opt.options.find((o) => o.value === shownValue)?.name ?? shownValue)
      : "Default";

  const pick = (value: string | undefined) => {
    if (onSelect) {
      onSelect(opt, value);
      return;
    }
    if (value !== undefined && taskId) {
      setPendingValue(value);
      daemon
        .request("session.setConfigOption", {
          config_id: opt.id,
          task_id: taskId,
          value,
        })
        .catch((e: unknown) => {
          setPendingValue(null);
          const label = opt.options.find((o) => o.value === value)?.name ?? value;
          toast.error(`Could not switch ${opt.name.toLowerCase()} to ${label}`, {
            description: e instanceof Error ? e.message : String(e),
          });
        });
    }
  };

  const [searchQuery, setSearchQuery] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Close the menu on any outside pointerdown — the browser's focus model
  // won't reliably move focus when the click lands in a code editor or the
  // composer textarea, so a blur-only close leaves the menu stuck open. This
  // fires on every press outside the picker (including the textarea) and
  // closes it, restoring the "click elsewhere to dismiss" behavior.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (containerRef.current?.contains(event.target as Node | null)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, onClose]);

  // Clear search query when the dropdown closes.
  useEffect(() => {
    if (!open) {
      setSearchQuery("");
    }
  }, [open]);

  // Short lists (effort, mode, access) are faster to scan than to type into.
  const searchable = opt.options.length > SEARCH_MIN_OPTIONS;
  const query = searchable ? searchQuery.trim().toLowerCase() : "";
  const filteredOptions = query
    ? opt.options.filter((o) => o.name.toLowerCase().includes(query))
    : opt.options;

  // Keep focus in the picker's search box on open instead of letting it fall
  // back to the composer textarea. `autoFocus` fires before the input is
  // mounted in some flows, so re-focus on the next frame once it is.
  useEffect(() => {
    if (!open || !searchable) return;
    const id = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open, searchable]);

  return (
    // Close on focus leaving the whole picker, not the trigger alone: the search
    // box takes focus away from the trigger the moment the menu opens, and a
    // trigger-level blur would shut the menu the user just opened.
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label={`${opt.name}: ${cur}`}
        onClick={onToggle}
        title={opt.name}
        className="flex items-center gap-0.5 rounded px-1.5 py-0.5 hover:bg-secondary hover:text-foreground"
      >
        {cur}
        <ChevronDown className="size-3 opacity-60" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-1 flex max-h-80 min-w-[200px] flex-col overflow-hidden rounded-md border bg-popover shadow-md">
          <div className="shrink-0 border-b p-1.5">
            <div className="px-1 text-[10px] uppercase leading-5 tracking-wider text-muted-foreground">
              {opt.name}
            </div>
            {searchable && (
              <div className="relative mt-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
                <input
                  ref={searchRef}
                  type="text"
                  placeholder={`Search ${opt.name.toLowerCase()}…`}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Escape") onClose();
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  className="h-7 w-full rounded border bg-background pl-7 pr-7 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery("")}
                    onMouseDown={(e) => e.stopPropagation()}
                    className="absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                    aria-label="Clear search"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {!query && (
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onClose();
                  pick(undefined);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs",
                  shownValue === undefined ? "bg-accent" : "hover:bg-accent/50",
                )}
              >
                <Check
                  className={cn(
                    "size-3 shrink-0",
                    shownValue === undefined ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="truncate">Default (agent&apos;s own)</span>
              </button>
            )}
            {filteredOptions.map((o) => (
              <button
                type="button"
                key={o.value}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onClose();
                  if (o.value !== shownValue) pick(o.value);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs",
                  o.value === shownValue ? "bg-accent" : "hover:bg-accent/50",
                )}
              >
                <Check
                  className={cn(
                    "size-3 shrink-0",
                    o.value === shownValue ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="truncate">{o.name}</span>
              </button>
            ))}
            {filteredOptions.length === 0 && (
              <div className="px-2 py-2 text-center text-xs text-muted-foreground">
                No matches for &ldquo;{searchQuery}&rdquo;
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
