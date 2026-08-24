import { Download, Loader2, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { daemon } from "../daemon";
import type { DetectedLanguageServer } from "../protocol";

/** Last meaningful line of command output, skipping npm's log-file boilerplate
 * so a failed install surfaces the actual error ("404 Not Found", etc.). */
function lastLine(output: string): string {
  const lines = (output ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/A complete log of this run/.test(l));
  return lines[lines.length - 1] ?? "install failed";
}

/**
 * Install/update panel for the language servers behind editor IntelliSense.
 * Detects every supported language's server and lets the user install or update
 * the missing/outdated ones — no manual command needed.
 */
export default function LanguageServersPanel() {
  const [servers, setServers] = useState<DetectedLanguageServer[]>([]);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = async () => {
    setRefreshing(true);
    setLoadError(null);
    try {
      setServers(await daemon.detectLanguageServers());
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const manage = async (id: string) => {
    setBusy((prev) => new Set(prev).add(id));
    setErrors((prev) => {
      const { [id]: _cleared, ...rest } = prev;
      return rest;
    });
    try {
      const result = await daemon.installLanguageServer(id);
      if (!result.ok) {
        setErrors((prev) => ({
          ...prev,
          [id]: lastLine(result.output) || "install failed",
        }));
      }
      setServers(await daemon.detectLanguageServers());
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

  if (servers.length === 0 && refreshing) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Detecting language servers…
      </div>
    );
  }

  if (servers.length === 0 && loadError) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to detect language servers: {loadError}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {servers.map((server) => {
        const isBusy = busy.has(server.id);
        const behind = server.status === "behind";
        return (
          <div
            key={server.id}
            className="flex items-center justify-between gap-4 rounded-md border border-border p-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                {server.language}
                {server.installed ? (
                  behind ? (
                    <span className="rounded-full bg-warn/15 px-1.5 py-0.5 text-[10px] font-medium text-warn">
                      update available
                    </span>
                  ) : (
                    <span className="rounded-full bg-ok/15 px-1.5 py-0.5 text-[10px] font-medium text-ok">
                      {server.version ? `v${server.version}` : "installed"}
                    </span>
                  )
                ) : (
                  <span className="flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    <Download className="size-2.5" />
                    not found
                  </span>
                )}
              </div>
              {behind && server.latestVersion && server.version && (
                <p className="mt-0.5 text-[11px] text-warn">
                  v{server.version} → v{server.latestVersion}
                </p>
              )}
              {!server.installed && !server.canManage && (
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Install: <span className="font-mono">{server.installHint}</span>
                </p>
              )}
              {errors[server.id] && (
                <p className="mt-0.5 font-mono text-[11px] text-destructive">{errors[server.id]}</p>
              )}
            </div>
            {server.canManage && (!server.installed || behind) && (
              <Button
                size="sm"
                variant={behind ? "default" : "secondary"}
                disabled={isBusy}
                onClick={() => void manage(server.id)}
              >
                {isBusy && <Loader2 className="size-3 animate-spin" />}
                {isBusy ? "Working…" : server.installed ? "Update" : "Install"}
              </Button>
            )}
          </div>
        );
      })}
      <div className="flex items-center gap-2 pt-2">
        {refreshing && (
          <span className="mr-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Checking versions…
          </span>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-xs"
          onClick={() => void refresh()}
          disabled={refreshing}
        >
          <RotateCw className={cn("size-3", refreshing && "animate-spin")} />
          Refresh
        </Button>
      </div>
    </div>
  );
}
