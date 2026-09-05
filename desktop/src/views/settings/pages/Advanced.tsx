import { useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { daemon } from "@/daemon";

import { Section, SettingRow } from "../primitives";

export default function AdvancedPage() {
  const state = useSyncExternalStore(daemon.subscribe, daemon.getState);
  const [dreamProject, setDreamProject] = useState<string>("");
  const effectiveDreamProject = dreamProject || state.snapshot.projects[0]?.name || "";

  return (
    <Section title="Maintenance">
      <SettingRow
        title="Dream now"
        description="Run compaction: duplicates, contradictions, stale facts → pending proposals."
        control={
          <div className="flex items-center gap-2">
            <select
              aria-label="Dream project"
              value={dreamProject}
              onChange={(e) => setDreamProject(e.target.value)}
              className="h-7 rounded-md border bg-background px-2 text-xs"
            >
              <option value="">global</option>
              {(state.snapshot.projects ?? []).map((p: any) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={async () => {
                  const pid = effectiveDreamProject || state.snapshot.projects[0]?.name || "global";
                  const agent =
                    (state.snapshot.agents ?? []).find((a) => a.enabled)?.id || "opencode";
                  toast.info("Dreaming…", { description: "Running LLM+heuristic sweep" });
                  const res: any = await (daemon as any).request("memory.dream", {
                    dry_run: false,
                    project_id: pid,
                  });
                  const inserted = res?.inserted ?? 0;
                  const pending = res?.pending ?? 0;
                  const prompt = `Dreaming just ran for '${pid}' (same background path as cron): ${JSON.stringify(res).slice(0, 3000)}\n\nYour job: verify each proposal against the codebase (grep/read files). Summarize what was actually stale/duplicate/contradiction vs false positive. Write a short human summary. Proposals stay pending in memory_compaction_log — don't apply without user approval.`;
                  const r: any = await (daemon as any).request("task.create", {
                    project: pid,
                    prompt,
                    agent,
                    tags: ["dreaming"],
                    worktree: false,
                  });
                  const tid = r?.taskId || r?.id;
                  toast.success(
                    `Dreaming done — ${inserted} new, ${pending} pending — task ${tid ?? pid}`,
                    { description: "Agent verifies against code" },
                  );
                }}
              >
                Dream
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={async () => {
                  const pid = effectiveDreamProject || state.snapshot.projects[0]?.name || "global";
                  const res: any = await (daemon as any).request("memory.dream", {
                    dry_run: true,
                    project_id: pid,
                  });
                  toast.info(`Dry run: ${res?.inserted ?? 0} would propose`, {
                    description: JSON.stringify(res?.proposals ?? res).slice(0, 200),
                  });
                }}
              >
                Dry run
              </Button>
            </div>
          </div>
        }
      />
    </Section>
  );
}
