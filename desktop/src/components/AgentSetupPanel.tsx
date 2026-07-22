import { Download, Loader2 } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { daemon } from "../daemon";
import type { AgentConfig, DetectedAgent } from "../protocol";

interface Props {
  /** Pre-loaded agents (dialog path: pendingAgentSetup already resolved). */
  detected?: DetectedAgent[];
  /** Fired after a successful save — the onboarding dialog uses it to close. */
  onSaved?: () => void;
}

/** Last non-empty line of command output, for a compact error hint. */
function lastLine(output: string): string {
  const lines = output.trim().split("\n");
  return lines[lines.length - 1]?.trim() ?? "";
}

/**
 * Already-configured agents render instantly as rows; detection only adds
 * version/update badges on top. Detection shells out to the npm registry and
 * takes seconds, so it must never gate the list.
 */
function fromConfig(agent: AgentConfig): DetectedAgent {
  return {
    canManage: false,
    defaultAcpCommand: agent.acpCommand,
    displayName: agent.displayName,
    id: agent.id,
    installHint: "",
    installed: true,
    status: "unknown",
  };
}

export default function AgentSetupPanel({ detected, onSaved }: Props) {
  const state = useSyncExternalStore(daemon.subscribe, daemon.getState);
  const configured = state.snapshot.agents;

  const [agents, setAgents] = useState<DetectedAgent[]>(
    () => detected ?? (configured ?? []).map(fromConfig),
  );
  const [enabled, setEnabled] = useState<Set<string>>(
    () =>
      new Set(
        configured?.length
          ? configured.filter((a) => a.enabled).map((a) => a.id)
          : (detected ?? []).filter((a) => a.installed).map((a) => a.id),
      ),
  );
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = useState(!detected);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Detection must not stomp on toggles the user has already made.
  const touched = useRef(false);

  useEffect(() => {
    if (detected) return;
    let cancelled = false;
    setRefreshing(true);
    daemon
      .detectAgents()
      .then((list) => {
        if (cancelled) return;
        setAgents(list);
        if (!touched.current && !configured?.length) {
          setEnabled(new Set(list.filter((a) => a.installed).map((a) => a.id)));
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
    // Detection runs once per mount; `configured` is only read for the seed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detected]);

  const toggle = (id: string) => {
    // The selection no longer matches what was written — offer the save again.
    touched.current = true;
    setSaved(false);
    setSaveError(null);
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const manage = async (id: string) => {
    setBusy((prev) => new Set(prev).add(id));
    setErrors((prev) => {
      const { [id]: _cleared, ...rest } = prev;
      return rest;
    });
    try {
      const result = await daemon.installAgent(id);
      if (!result.ok) {
        setErrors((prev) => ({ ...prev, [id]: lastLine(result.output) || "install failed" }));
      }
      const refreshed = await daemon.detectAgents();
      setAgents(refreshed);
      if (result.ok) {
        const nowInstalled = refreshed.find((a) => a.id === id)?.installed;
        if (nowInstalled) setEnabled((prev) => new Set(prev).add(id));
      }
    } catch (e) {
      setErrors((prev) => ({ ...prev, [id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const save = async () => {
    // Write every known agent, not just the enabled ones: dropping the rest
    // would erase the record that the user deliberately turned them off. Cached
    // models and the last picked model belong to the stored config, so carry
    // them over rather than resetting the agent on every save.
    const configs: AgentConfig[] = agents.map((a) => {
      const existing = configured?.find((c) => c.id === a.id);
      return {
        acpCommand: existing?.acpCommand ?? a.defaultAcpCommand,
        displayName: a.displayName,
        enabled: enabled.has(a.id),
        id: a.id,
        lastModel: existing?.lastModel,
        models: existing?.models ?? [],
      };
    });
    setSaveError(null);
    try {
      await daemon.saveAgents(configs);
      setSaved(true);
      onSaved?.();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };

  if (agents.length === 0 && refreshing) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Detecting agents…
      </div>
    );
  }

  if (agents.length === 0 && loadError) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to detect agents: {loadError}
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        {agents.map((agent) => {
          const on = enabled.has(agent.id);
          const isBusy = busy.has(agent.id);
          const behind = agent.status === "behind";
          return (
            <div
              key={agent.id}
              role="button"
              tabIndex={0}
              onClick={() => toggle(agent.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle(agent.id);
                }
              }}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-md border p-3 text-left transition-colors",
                on ? "border-primary/40 bg-primary/5" : "border-border",
              )}
            >
              <div
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border",
                  on ? "border-primary bg-primary" : "border-muted-foreground",
                )}
              >
                {on && <div className="size-2 rounded-sm bg-primary-foreground" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {agent.displayName}
                  {agent.installed ? (
                    behind ? (
                      <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                        update available
                      </span>
                    ) : (
                      <span className="rounded-full bg-green-500/15 px-1.5 py-0.5 text-[10px] font-medium text-green-600 dark:text-green-400">
                        {agent.version ? `v${agent.version}` : "installed"}
                      </span>
                    )
                  ) : (
                    <span className="flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      <Download className="size-2.5" />
                      not found
                    </span>
                  )}
                </div>
                <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                  {agent.defaultAcpCommand}
                </p>
                {behind && agent.latestVersion && (
                  <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                    v{agent.version} → v{agent.latestVersion}
                  </p>
                )}
                {!agent.installed && !agent.canManage && (
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    Install: <span className="font-mono">{agent.installHint}</span>
                  </p>
                )}
                {errors[agent.id] && (
                  <p className="mt-0.5 font-mono text-[11px] text-destructive">{errors[agent.id]}</p>
                )}
              </div>
              {agent.canManage && (!agent.installed || behind) && (
                <Button
                  size="sm"
                  variant={behind ? "default" : "secondary"}
                  disabled={isBusy}
                  onClick={(e) => {
                    e.stopPropagation();
                    void manage(agent.id);
                  }}
                >
                  {isBusy && <Loader2 className="size-3 animate-spin" />}
                  {isBusy ? "Working…" : agent.installed ? "Update" : "Install"}
                </Button>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-end gap-3 pt-3">
        {refreshing && (
          <span className="mr-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Checking versions…
          </span>
        )}
        {loadError && !refreshing && (
          <span className="mr-auto text-[11px] text-muted-foreground">
            Version check failed: {loadError}
          </span>
        )}
        {saveError && <span className="text-[11px] text-destructive">{saveError}</span>}
        <Button onClick={() => void save()} disabled={saved}>
          {saved ? "Saved" : "Save"}
        </Button>
      </div>
    </>
  );
}
