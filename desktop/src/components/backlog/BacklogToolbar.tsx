import { ArrowDownNarrowWide, ArrowUpNarrowWide, RefreshCw, X } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

import { PRIORITY_LABEL, SOURCE_LABEL, STATUS_META } from "./labels";
import { LinearTeamPicker } from "./LinearTeamPicker";
import {
  BACKLOG_SORT_LABEL,
  type BacklogParams,
  type BacklogSortKey,
  hasActiveFilters,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_SOURCES,
  WORK_ITEM_STATUSES,
} from "./types";

/** Radix Select forbids an empty item value, so "no filter" needs a sentinel. */
const ALL = "__all__";

const SEARCH_DEBOUNCE_MS = 250;

interface BacklogToolbarProps {
  project: string;
  params: BacklogParams;
  onChange: (patch: Partial<BacklogParams>) => void;
  onReset: () => void;
  onSync: () => void;
  isSyncing: boolean;
}

export function BacklogToolbar({
  project,
  params,
  onChange,
  onReset,
  onSync,
  isSyncing,
}: BacklogToolbarProps) {
  return (
    <div className="flex w-full shrink-0 flex-wrap items-center gap-2 border-b border-border/50 px-3 py-1.5">
      <SearchInput value={params.search} onChange={(search) => onChange({ search })} />
      <FilterSelect
        label="Status"
        value={params.status}
        options={WORK_ITEM_STATUSES.map((value) => ({
          value,
          label: STATUS_META[value].label,
        }))}
        onChange={(status) => onChange({ status })}
      />
      <FilterSelect
        label="Priority"
        value={params.priority}
        options={WORK_ITEM_PRIORITIES.map((value) => ({ value, label: PRIORITY_LABEL[value] }))}
        onChange={(priority) => onChange({ priority })}
      />
      <FilterSelect
        label="Source"
        value={params.source}
        options={WORK_ITEM_SOURCES.map((value) => ({ value, label: SOURCE_LABEL[value] }))}
        onChange={(source) => onChange({ source })}
      />
      {hasActiveFilters(params) && (
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={onReset}>
          <X className="size-3.5" />
          Reset
        </Button>
      )}

      <div className="ml-auto flex items-center gap-2">
        <SortControl
          sortBy={params.sortBy}
          sortDesc={params.sortDesc}
          onChange={(next) => onChange(next)}
        />
        <LinearTeamPicker project={project} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5"
          onClick={onSync}
          disabled={isSyncing}
        >
          <RefreshCw className={cn("size-3.5", isSyncing && "animate-spin")} />
          Sync
        </Button>
      </div>
    </div>
  );
}

/** The list has no column headers to click, so ordering lives here instead. */
function SortControl({
  sortBy,
  sortDesc,
  onChange,
}: {
  sortBy: BacklogSortKey;
  sortDesc: boolean;
  onChange: (next: Partial<BacklogParams>) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <Select value={sortBy} onValueChange={(next) => onChange({ sortBy: next as BacklogSortKey })}>
        <SelectTrigger aria-label="Sort by" className="h-7 w-auto gap-1.5 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(BACKLOG_SORT_LABEL) as BacklogSortKey[]).map((key) => (
            <SelectItem key={key} value={key}>
              {BACKLOG_SORT_LABEL[key]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-7"
        aria-label={sortDesc ? "Sort ascending" : "Sort descending"}
        title={sortDesc ? "Descending" : "Ascending"}
        onClick={() => onChange({ sortDesc: !sortDesc })}
      >
        {sortDesc ? (
          <ArrowDownNarrowWide className="size-3.5" />
        ) : (
          <ArrowUpNarrowWide className="size-3.5" />
        )}
      </Button>
    </div>
  );
}

/**
 * Typing is local and only reaches the query params on a pause, so a search
 * term costs one request instead of one per keystroke.
 */
function SearchInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = React.useState(value);
  // A reset (or a project switch) clears `value` behind the input's back.
  React.useEffect(() => setDraft(value), [value]);
  React.useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => onChange(draft), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, onChange, value]);

  return (
    <Input
      aria-label="Search backlog"
      placeholder="Search title or body..."
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      className="h-7 w-44 lg:w-64"
    />
  );
}

function FilterSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | null;
  options: { value: T; label: string }[];
  onChange: (value: T | null) => void;
}) {
  return (
    <Select
      value={value ?? ALL}
      onValueChange={(next) => onChange(next === ALL ? null : (next as T))}
    >
      <SelectTrigger
        aria-label={label}
        className={cn("h-7 w-auto gap-1.5 text-xs", value === null && "text-muted-foreground")}
      >
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{`All ${label.toLowerCase()}`}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
