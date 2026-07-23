import { Search } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
    <div className="space-y-1.5 border-y border-border/80 bg-secondary/10 p-2">
      <label className="flex h-7 items-center gap-2 rounded border border-border/80 bg-deep-surface px-2 text-muted-foreground focus-within:ring-1 focus-within:ring-ring">
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

      <div className="grid grid-cols-2 gap-1.5">
        <Select value={sort} onValueChange={(value) => setSort(value as SortMode)}>
          <SelectTrigger aria-label="Sort sessions" className="h-7 rounded px-2 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="updated">Recently updated</SelectItem>
            <SelectItem value="created">Recently created</SelectItem>
            <SelectItem value="status">Status (grouped)</SelectItem>
            <SelectItem value="project">Project (grouped)</SelectItem>
          </SelectContent>
        </Select>
        <Select value={effectiveGroup} onValueChange={handleGroupChange}>
          <SelectTrigger aria-label="Group sessions" className="h-7 rounded px-2 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No grouping</SelectItem>
            <SelectItem value="project">By project</SelectItem>
            <SelectItem value="agent">By agent</SelectItem>
            <SelectItem value="status">By status</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-3 rounded border border-border/50 bg-deep-surface p-0.5">
        {(["attention", "running", "all"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={cn(
              "rounded px-1.5 py-1 text-[11px] capitalize text-muted-foreground transition-colors",
              filter === value && "bg-secondary text-foreground",
            )}
            onClick={() => setFilter(value)}
          >
            {value === "attention" ? "Needs you" : value}
          </button>
        ))}
      </div>
    </div>
  );
}
