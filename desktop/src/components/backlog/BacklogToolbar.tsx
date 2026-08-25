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
import { sourceAvailable, useMe, useProjectSources } from "./use-tracker";

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
  /** Assignees seen in the rows loaded so far, for the assignee filter. */
  assignees: string[];
}

export function BacklogToolbar({
  project,
  params,
  onChange,
  onReset,
  onSync,
  isSyncing,
  assignees,
}: BacklogToolbarProps) {
  // What this project can actually reach. A project without Linear or a repo
  // gets no source options for them — the filter never offers what would
  // always come back empty.
  const sources = useProjectSources(project);
  const sourceOptions = WORK_ITEM_SOURCES.filter((value) => sourceAvailable(sources.data, value));
  return (
    <div className="flex w-full shrink-0 flex-wrap items-center gap-2 border-b border-border/50 px-1 py-1.5">
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
      <AssigneeFilter
        value={params.assignee}
        assignees={assignees}
        onChange={(assignee) => onChange({ assignee })}
      />
      {sourceOptions.length > 1 && (
        <FilterSelect
          label="Source"
          value={params.source}
          options={sourceOptions.map((value) => ({ value, label: SOURCE_LABEL[value] }))}
          onChange={(source) => onChange({ source })}
        />
      )}
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

/**
 * Who the work is on. The common case by far is "mine", so the signed-in
 * identity is pinned to the top of the list instead of being one name among
 * many — and it is offered even before any row assigned to you has loaded.
 *
 * Items created here are stamped with the same identity ([`useMe`]), so a
 * local note lands in this filter next to the tracker issues assigned to you
 * rather than falling out of the view entirely.
 */
function AssigneeFilter({
  value,
  assignees,
  onChange,
}: {
  value: string | null;
  assignees: string[];
  onChange: (value: string | null) => void;
}) {
  const me = useMe();
  const others = assignees.filter((name) => name !== me);
  // Nothing to choose from: no identity, and no assignee on any row so far.
  if (!me && others.length === 0) return null;

  return (
    <Select value={value ?? ALL} onValueChange={(next) => onChange(next === ALL ? null : next)}>
      <SelectTrigger
        aria-label="Assignee"
        className={cn("h-7 w-auto gap-1.5 text-xs", value === null && "text-muted-foreground")}
      >
        <SelectValue placeholder="Assignee" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>Anyone</SelectItem>
        {me && (
          <SelectItem value={me}>
            <span className="flex items-center gap-1.5">
              {me}
              <span className="text-[10px] text-muted-foreground/70">you</span>
            </span>
          </SelectItem>
        )}
        {others.map((name) => (
          <SelectItem key={name} value={name}>
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
