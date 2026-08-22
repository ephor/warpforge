import { useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, Loader2 } from "lucide-react";
import { useSyncExternalStore, useState } from "react";
import { toast } from "sonner";

import { ProjectLinearTeamSelect } from "@/components/backlog/LinearTeamPicker";
import {
  TRACKER_PROJECT_SOURCES_KEY,
  TRACKER_STATUS_KEY,
  useTrackerStatus,
} from "@/components/backlog/use-tracker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { daemon } from "@/daemon";
import { openExternalLink } from "@/lib/externalLinks";

/**
 * Connect the issue trackers the backlog can mirror into.
 *
 * Neither credential lives in the renderer: the Linear key goes straight to the
 * daemon, which stores it in the OS keychain, and GitHub reuses the `gh` CLI
 * session that PR creation already depends on.
 */
export default function TrackersPanel() {
  const status = useTrackerStatus();
  const queryClient = useQueryClient();
  const snapshot = useSyncExternalStore(
    daemon.subscribe,
    () => daemon.getState().snapshot,
    () => daemon.getState().snapshot,
  );
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"linear" | "github" | null>(null);

  const linear = status.data?.linear;
  const github = status.data?.github;

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: TRACKER_STATUS_KEY });
    // Availability is derived from the connection state, so every project's
    // probe goes stale with it.
    await queryClient.invalidateQueries({ queryKey: [...TRACKER_PROJECT_SOURCES_KEY] });
  };

  const run = async (which: "linear" | "github", action: () => Promise<unknown>, ok: string) => {
    setBusy(which);
    try {
      await action();
      await refresh();
      toast(ok);
    } catch (error) {
      toast.error("Tracker action failed", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* ── Linear ── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-[13px] font-semibold text-foreground">Linear</h3>
            {linear?.connected && (
              <span className="flex items-center gap-1 text-[11px] text-emerald-500">
                <Check className="size-3" />
                {linear.email ?? "connected"}
              </span>
            )}
          </div>
          {linear?.connected && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy === "linear"}
              onClick={() =>
                void run("linear", () => daemon.disconnectLinear(), "Linear disconnected")
              }
            >
              Disconnect
            </Button>
          )}
        </div>
        {!linear?.connected && (
          <div className="flex items-center gap-2">
            <Input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="lin_api_…"
              className="h-7 flex-1 text-xs"
              aria-label="Linear API key"
            />
            <Button
              type="button"
              size="sm"
              disabled={!apiKey.trim() || busy === "linear"}
              onClick={() =>
                void run(
                  "linear",
                  async () => {
                    await daemon.connectLinear(apiKey.trim());
                    setApiKey("");
                  },
                  "Linear connected",
                )
              }
            >
              {busy === "linear" ? <Loader2 className="size-3.5 animate-spin" /> : "Connect"}
            </Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground/80">
          A personal API key, stored in your keychain by the daemon.{" "}
          <button
            type="button"
            className="inline-flex items-center gap-0.5 underline underline-offset-2"
            onClick={() => void openExternalLink("https://linear.app/settings/api")}
          >
            Create one
            <ExternalLink className="size-3" />
          </button>
        </p>
        {linear?.connected && snapshot.projects.length > 0 && (
          <div className="space-y-1.5 rounded-md border border-border/60 p-2.5">
            <p className="text-[11px] font-medium text-muted-foreground">
              Which team each project imports from
            </p>
            {snapshot.projects.map((project) => (
              <div key={project.name} className="flex items-center justify-between gap-3">
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                  {project.name}
                </span>
                <ProjectLinearTeamSelect project={project.name} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── GitHub ── */}
      <div className="space-y-2 border-t border-border/60 pt-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-[13px] font-semibold text-foreground">GitHub</h3>
            {github?.connected && (
              <span className="flex items-center gap-1 text-[11px] text-emerald-500">
                <Check className="size-3" />
                {github.login ?? "connected"}
              </span>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy === "github"}
            onClick={() =>
              github?.connected
                ? void run("github", () => daemon.disconnectGithub(), "GitHub disconnected")
                : void run("github", () => daemon.connectGithub(), "GitHub connected")
            }
          >
            {busy === "github" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : github?.connected ? (
              "Disconnect"
            ) : (
              "Connect"
            )}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground/80">
          Uses your <code className="rounded bg-secondary px-1">gh</code> CLI session — run{" "}
          <code className="rounded bg-secondary px-1">gh auth login</code> first. Issue status is
          read-only: GitHub's columns are project-specific, so warpforge never writes them back.
        </p>
      </div>
    </div>
  );
}
