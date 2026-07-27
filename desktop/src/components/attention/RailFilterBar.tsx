import { ArrowUpDown, Group, Search } from "lucide-react";

import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type SortMode = "updated" | "created" | "status" | "project";
export type GroupMode = "none" | "project" | "agent" | "status";
export type FilterMode = "attention" | "running" | "all";

interface RailFilterBarProps {
  query: string;
  setQuery: (v: string) => void;
  sort: SortMode;
  setSort: (v: SortMode) => void;
  effectiveGroup: GroupMode;
  handleGroupChange: (value: string) => void;
  filter: FilterMode;
  setFilter: (v: FilterMode) => void;
}

export function RailFilterBar({
  query,
  setQuery,
  sort,
  setSort,
  effectiveGroup,
  handleGroupChange,
  filter,
  setFilter,
}: RailFilterBarProps) {
  return (
    <div className="space-y-1.5 border-y border-border/70 bg-background px-2 py-1.5">
      <label className="flex h-8 items-center gap-2 rounded-md bg-secondary/35 px-2.5 text-muted-foreground transition-colors focus-within:bg-secondary/55 focus-within:ring-1 focus-within:ring-ring">
        <Search className="size-3.5 shrink-0" />
        <input
          aria-label="Search sessions"
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search task or project"
          type="search"
          value={query}
        />
      </label>

      <div className="flex items-center gap-1.5">
        <div className="grid min-w-0 flex-1 grid-cols-3 rounded-md bg-secondary/20 p-0.5">
          {(["running", "attention", "all"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={cn(
                "rounded px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground",
                filter === value && "bg-secondary text-foreground shadow-sm",
              )}
              onClick={() => setFilter(value)}
            >
              {value === "attention" ? "Needs you" : value === "running" ? "Working" : "All"}
            </button>
          ))}
        </div>
        <Select value={sort} onValueChange={(value) => setSort(value as SortMode)}>
          <SelectTrigger
            aria-label="Sort sessions"
            className="size-7 shrink-0 justify-center rounded-md border-0 bg-secondary/30 p-0 text-muted-foreground hover:bg-secondary/60 hover:text-foreground [&>svg:last-child]:hidden"
            title="Sort sessions"
          >
            <ArrowUpDown className="size-3.5" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="updated">Recently updated</SelectItem>
            <SelectItem value="created">Recently created</SelectItem>
            <SelectItem value="status">Status (grouped)</SelectItem>
            <SelectItem value="project">Project (grouped)</SelectItem>
          </SelectContent>
        </Select>
        <Select value={effectiveGroup} onValueChange={handleGroupChange}>
          <SelectTrigger
            aria-label="Group sessions"
            className="size-7 shrink-0 justify-center rounded-md border-0 bg-secondary/30 p-0 text-muted-foreground hover:bg-secondary/60 hover:text-foreground [&>svg:last-child]:hidden"
            title="Group sessions"
          >
            <Group className="size-3.5" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No grouping</SelectItem>
            <SelectItem value="project">By project</SelectItem>
            <SelectItem value="agent">By agent</SelectItem>
            <SelectItem value="status">By status</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
