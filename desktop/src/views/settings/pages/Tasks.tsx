import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import { daemon } from "@/daemon";
import { configRole } from "@/lib/configRole";
import type { HistorySettings } from "@/protocol";
import { useUi } from "@/store/ui";

import { Section, SettingRow, Toggle } from "../primitives";

export default function TasksPage() {
  const queryClient = useQueryClient();
  const state = useSyncExternalStore(daemon.subscribe, daemon.getState);

  const autoNameTasks = useUi((s) => s.autoNameTasks);
  const setAutoNameTasks = useUi((s) => s.setAutoNameTasks);
  const textGenAgentId = useUi((s) => s.textGenAgentId);
  const setTextGenAgentId = useUi((s) => s.setTextGenAgentId);
  const textGenModel = useUi((s) => s.textGenModel);
  const setTextGenModel = useUi((s) => s.setTextGenModel);

  const enabledAgents = (state.snapshot.agents ?? []).filter((a) => a.enabled);
  // The daemon caches an agent's config options after probing it over ACP; the
  // model list is empty until that probe has happened at least once.
  const modelOption = enabledAgents
    .find((a) => a.id === textGenAgentId)
    ?.models.find((o) => configRole(o) === "model");

  const historySettings = useQuery({
    queryKey: ["history", "settings"],
    queryFn: () => daemon.historySettings(),
  });
  /** Change the retention windows. The daemon sweeps immediately on success;
   *  deletions themselves are announced by the daemon's history.pruned and
   *  history.swept toasts. */
  const applyRetention = useMutation({
    mutationFn: (patch: Partial<HistorySettings>) =>
      daemon.setHistorySettings({
        retentionDays: 30,
        settleIgnoredAfterDays: 14,
        deleteClosedAfterDays: 90,
        ...historySettings.data,
        ...patch,
      }),
    onSuccess: (settings) => queryClient.setQueryData(["history", "settings"], settings),
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const backlogSettings = useQuery({
    queryKey: ["backlog", "settings"],
    queryFn: () => daemon.backlogSettings(),
  });
  const backlogStorage = useMutation({
    mutationFn: (mode: "sqlite" | "yaml") => daemon.setBacklogStorage(mode),
    onSuccess: (settings) => queryClient.setQueryData(["backlog", "settings"], settings),
  });

  return (
    <div className="flex flex-col gap-8">
      <Section title="Text generation">
        <SettingRow
          title="Auto-name tasks"
          description="On task creation, ask the selected agent to generate a short title. Respects your agent and model picks above."
          control={
            <Toggle id="auto-name-tasks" checked={autoNameTasks} onChange={setAutoNameTasks} />
          }
        />
        <SettingRow
          title="Agent for git text"
          description="Drafts commit messages and PR descriptions from the diff, on demand. Used for both."
          control={
            <select
              value={textGenAgentId ?? ""}
              onChange={(e) => setTextGenAgentId(e.target.value || null)}
              className="bg-deep-surface h-7 rounded-md border px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">None</option>
              {enabledAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                </option>
              ))}
            </select>
          }
        />
        {textGenAgentId && (
          <SettingRow
            title="Model"
            description={
              modelOption
                ? "Which model that agent uses for this. Agent default when unset."
                : "Model list appears once the agent has been started at least once, so Warpforge can read its options."
            }
            control={
              <select
                value={textGenModel ?? ""}
                onChange={(e) => setTextGenModel(e.target.value || null)}
                disabled={!modelOption}
                className="bg-deep-surface h-7 max-w-56 rounded-md border px-2 text-xs outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
              >
                <option value="">Agent default</option>
                {modelOption?.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.name}
                  </option>
                ))}
              </select>
            }
          />
        )}
      </Section>

      <Section title="Task history">
        <SettingRow
          title="Keep transcripts for"
          description="How long a closed task keeps its conversation. After this it still shows the title, prompt and diff, but the chat is gone. Pruning runs at daemon start, once a day, and right after you change this — with a notice each time it deletes something."
          control={
            <select
              aria-label="Transcript retention"
              value={historySettings.data?.retentionDays ?? 30}
              disabled={historySettings.isLoading || applyRetention.isPending}
              onChange={(event) =>
                applyRetention.mutate({ retentionDays: Number(event.target.value) })
              }
              className="h-7 rounded-md border bg-background px-2 text-xs"
            >
              <option value={15}>15 days</option>
              <option value={30}>30 days</option>
              <option value={60}>60 days</option>
              <option value={0}>Forever</option>
            </select>
          }
        />
        <SettingRow
          title="Settle ignored tasks after"
          description="A finished turn with no changes that nobody touched for this long moves to Closed on its own. Tasks with changes are never settled automatically. 0 turns this off."
          control={
            <select
              aria-label="Auto-settle ignored tasks"
              value={historySettings.data?.settleIgnoredAfterDays ?? 14}
              disabled={historySettings.isLoading || applyRetention.isPending}
              onChange={(event) =>
                applyRetention.mutate({ settleIgnoredAfterDays: Number(event.target.value) })
              }
              className="h-7 rounded-md border bg-background px-2 text-xs"
            >
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
              <option value={0}>Off</option>
            </select>
          }
        />
        <SettingRow
          title="Delete closed tasks after"
          description="A closed task nobody touched for this long is deleted entirely — row, chat and worktree. Commits stay in git. Tasks with unmerged changes are kept. 0 turns this off."
          control={
            <select
              aria-label="Closed task expiry"
              value={historySettings.data?.deleteClosedAfterDays ?? 90}
              disabled={historySettings.isLoading || applyRetention.isPending}
              onChange={(event) =>
                applyRetention.mutate({ deleteClosedAfterDays: Number(event.target.value) })
              }
              className="h-7 rounded-md border bg-background px-2 text-xs"
            >
              <option value={60}>60 days</option>
              <option value={90}>90 days</option>
              <option value={180}>180 days</option>
              <option value={0}>Forever</option>
            </select>
          }
        />
      </Section>

      <Section title="Backlog storage">
        <SettingRow
          title="Storage format"
          description="Backlog is owned by daemon. YAML lives in .warpforge/backlog; SQLite stays in Warpforge data."
          control={
            <select
              aria-label="Backlog storage format"
              value={backlogSettings.data?.mode ?? "sqlite"}
              disabled={backlogSettings.isLoading || backlogStorage.isPending}
              onChange={(event) => backlogStorage.mutate(event.target.value as "sqlite" | "yaml")}
              className="h-7 rounded-md border bg-background px-2 text-xs"
            >
              <option value="sqlite">SQLite</option>
              <option value="yaml">YAML files</option>
            </select>
          }
        />
      </Section>
    </div>
  );
}
