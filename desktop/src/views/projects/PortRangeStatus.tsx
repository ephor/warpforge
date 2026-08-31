import { Loader2, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { daemon } from "../../daemon";
import type { ProjectInfo } from "../../protocol";
import { normalizePortRange, portRangeInputError } from "./portRange";

/** Compact label for where a project's port range came from. */
const SOURCE_LABELS: Record<NonNullable<ProjectInfo["portRangeSource"]>, string> = {
  auto: "auto-assigned",
  sticky: "auto-assigned (kept)",
  declared: "from team config",
  localOverride: "local override",
};

/** Longer explanation, shown on hover. */
const SOURCE_TITLES: Record<NonNullable<ProjectInfo["portRangeSource"]>, string> = {
  auto: "Chosen automatically from free ports on this machine.",
  sticky: "Kept from an earlier automatic assignment on this machine.",
  declared:
    "Declared in the project's shared config — every machine on the team uses this range.",
  localOverride:
    "Overridden on this machine only. The team's shared config is unchanged.",
};

export function PortRangeSourceChip({ project }: { project: ProjectInfo }) {
  const source = project.portRangeSource;
  if (!source) return null;
  const isLocal = source === "localOverride";
  return (
    <span
      className={cn(
        "rounded border px-1 py-px text-[10px] whitespace-nowrap",
        isLocal
          ? "border-amber-500/40 text-amber-600 dark:text-amber-400"
          : "border-border text-muted-foreground",
      )}
      title={SOURCE_TITLES[source]}
    >
      {SOURCE_LABELS[source]}
    </span>
  );
}

/**
 * Conflict banner + machine-local fix. The daemon refuses to start a
 * conflicted project's services until a human picks a different block; this
 * fix writes a local override only — the shared config is never touched.
 */
export function PortRangeConflictCard({ project }: { project: ProjectInfo }) {
  const [range, setRange] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [daemonError, setDaemonError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const hasOverride = project.portRangeSource === "localOverride";

  const apply = async () => {
    const error = portRangeInputError(range);
    setValidationError(error);
    if (error) return;
    setSaving(true);
    setDaemonError(null);
    try {
      await daemon.setProjectPortRange(project.name, normalizePortRange(range));
      setRange("");
    } catch (e) {
      setDaemonError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    setDaemonError(null);
    try {
      await daemon.setProjectPortRange(project.name, null);
    } catch (e) {
      setDaemonError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="alert"
      data-testid="port-range-conflict"
      className="flex flex-col gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm"
    >
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-destructive">
            Port range conflict with {project.portRangeConflict}
          </p>
          <p className="mt-0.5 text-muted-foreground">
            Both projects use ports {project.portRange[0]}–{project.portRange[1]}, so this
            project's services will not start. Set a different range below — this affects only
            this machine and does not change the team's shared config.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={range}
          onChange={(e) => {
            setRange(e.target.value);
            setValidationError(null);
          }}
          placeholder="e.g. 4300-4399"
          aria-label={`New local port range for ${project.name}`}
          className="h-8 w-40 rounded-md border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
          onKeyDown={(e) => {
            if (e.key === "Enter") void apply();
          }}
        />
        <Button type="button" size="sm" disabled={saving} onClick={() => void apply()}>
          {saving && <Loader2 className="mr-1 size-3.5 animate-spin" />}
          Set range on this machine
        </Button>
        {hasOverride && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={() => void clear()}
          >
            Clear override
          </Button>
        )}
      </div>
      {validationError && (
        <p className="text-xs text-destructive" role="status">
          {validationError}
        </p>
      )}
      {daemonError && (
        <p className="text-xs text-destructive" role="status">
          The daemon rejected this range: {daemonError}
        </p>
      )}
    </div>
  );
}
