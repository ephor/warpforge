import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { daemon } from "@/daemon";

import { Section, SettingRow } from "../primitives";

export default function MemoryPage() {
  const queryClient = useQueryClient();
  const [confirmingFastembed, setConfirmingFastembed] = useState(false);
  const memoryStats = useQuery({
    queryKey: ["memory", "stats"],
    queryFn: () => daemon.memoryStats(),
  });

  /**
   * Switch the memory embedding mode. Failures and half-applied switches are
   * reported as toasts: `alert` is as invisible in this webview as
   * `window.confirm`, so the news never reached anyone.
   */
  const applyEmbeddingMode = async (mode: string) => {
    try {
      const stats = (await daemon.setMemoryEmbedding(mode)) as typeof memoryStats.data;
      queryClient.setQueryData(["memory", "stats"], stats);
      if (mode === "fastembed" && stats?.embeddingMode !== "hybrid") {
        toast.warning("Still on keyword search (FTS)", {
          description: stats?.embeddingUnavailable
            ? `fastembed is not available: ${stats.embeddingUnavailable}. On macOS: brew install onnxruntime, then re-select fastembed — no restart needed. If it still fails, restart Warpforge so ORT_DYLIB_PATH picks up /opt/homebrew/lib/libonnxruntime.dylib.`
            : "The ~80 MB model downloads on the next search. Offline, it stays on FTS.",
        });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <Section title="Memory">
        <SettingRow
          title="Embedding mode"
          description={
            memoryStats.isLoading
              ? "Loading embedding mode…"
              : memoryStats.data?.embeddingMode === "hybrid"
                ? "Embedding: hybrid (FTS + vector, ~80 MB model). Falls back to FTS when offline."
                : memoryStats.data?.embeddingUnavailable
                  ? `Embedding: fts (keyword) — last fastembed attempt failed: ${memoryStats.data.embeddingUnavailable}. On macOS: brew install onnxruntime, then re-select fastembed (no restart needed; if still fails, restart warpforge so ORT_DYLIB_PATH picks up /opt/homebrew/lib/libonnxruntime.dylib) to download ~80 MB model.`
                  : "Embedding: fts (keyword-only). Selecting fastembed will download ~80 MB model (all-MiniLM-L6-v2) on first use and enable hybrid search (FTS+vector). Requires ONNX Runtime — on macOS: brew install onnxruntime (daemon auto-detects /opt/homebrew/lib/libonnxruntime.dylib; if brew was just installed, simply re-select fastembed — no restart needed). Falls back to FTS if unavailable/offline."
          }
          control={
            <select
              aria-label="Embedding mode"
              value={memoryStats.data?.embeddingMode === "hybrid" ? "fastembed" : "none"}
              disabled={memoryStats.isLoading}
              onChange={(e) => {
                // The select is controlled by the daemon's answer, so a
                // pick that is not applied snaps back on the next render —
                // there is nothing to undo here.
                const mode = e.target.value;
                if (mode === "fastembed") {
                  setConfirmingFastembed(true);
                  return;
                }
                void applyEmbeddingMode(mode);
              }}
              className="h-7 rounded-md border bg-background px-2 text-xs"
            >
              <option value="none">none (FTS)</option>
              <option value="fastembed">fastembed (~80 MB)</option>
            </select>
          }
        />
        <SettingRow
          title="Memories"
          description="Durable cross-session knowledge shared across harnesses."
          control={
            <span className="text-xs tabular-nums text-muted-foreground">
              {memoryStats.isLoading
                ? "…"
                : `${memoryStats.data?.globalCount ?? 0} global · ${
                    memoryStats.data?.projectCount ?? 0
                  } project`}
            </span>
          }
        />
        <SettingRow
          title="Active scopes"
          description="Which scopes agents can store and search. Read-only — edit ~/.warpforge/config.yaml → memory.global / memory.project, then restart daemon."
          control={
            <span
              className="flex items-center gap-2 text-xs tabular-nums"
              title="Read-only: edit config.yaml"
            >
              <span
                className={`rounded-full border px-2 py-0.5 ${memoryStats.data?.scopesEnabled.global ? "border-foreground/30 bg-foreground/10 text-foreground" : "border-border text-muted-foreground/50"}`}
              >
                global
              </span>
              <span
                className={`rounded-full border px-2 py-0.5 ${memoryStats.data?.scopesEnabled.project ? "border-foreground/30 bg-foreground/10 text-foreground" : "border-border text-muted-foreground/50"}`}
              >
                project
              </span>
            </span>
          }
        />
        <SettingRow
          title="Per-project DB"
          description="~/.warpforge/memory.db is global; per-project overlay auto-creates on first project-scoped write (or when memory.per_project: true). You don't create it manually."
          control={
            <span
              className="text-xs tabular-nums text-muted-foreground"
              title="Auto-created overlay, not manual"
            >
              {memoryStats.isLoading
                ? "…"
                : memoryStats.data?.perProjectDbExists
                  ? "exists"
                  : "not found — using global"}
            </span>
          }
        />
      </Section>

      <Section title="Dreaming">
        <SettingRow
          title="Enabled"
          description="Auto dreaming via idle/cron trigger (manual = button only). Configured in ~/.warpforge/config.yaml → memory.dreaming (enabled/trigger) — restart daemon to apply."
          control={
            <span
              className="text-xs text-muted-foreground"
              title="Read-only: edit ~/.warpforge/config.yaml memory.dreaming"
            >
              {(memoryStats.data as any)?.dreaming?.enabled ? "on" : "off"} (
              {(memoryStats.data as any)?.dreaming?.trigger ?? "manual"})
            </span>
          }
        />
      </Section>

      <ConfirmDialog
        open={confirmingFastembed}
        title="Switch to fastembed?"
        description="On first use Warpforge downloads a ~80 MB model (all-MiniLM-L6-v2) and needs ONNX Runtime — on macOS, brew install onnxruntime. Without it, memory search stays on keywords."
        confirmLabel="Switch to fastembed"
        busyLabel="Switching…"
        destructive={false}
        onCancel={() => setConfirmingFastembed(false)}
        onConfirm={async () => {
          await applyEmbeddingMode("fastembed");
          setConfirmingFastembed(false);
        }}
      />
    </div>
  );
}
