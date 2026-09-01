import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Play } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { AgentLogo } from "@/components/AgentLogo";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { daemon } from "@/daemon";
import { automationRunsKey, automationsKey, useTicker } from "@/hooks/useAutomations";
import { agentDisplayName } from "@/lib/agentNames";
import { cn } from "@/lib/utils";
import type { Automation, Snapshot } from "@/protocol";

import {
  type AutomationForm,
  createInput,
  emptyForm,
  formFromAutomation,
  hasProblems,
  patchFrom,
  validateForm,
} from "./form";
import { modelOptionOf } from "./labels";
import { ScheduleFields } from "./ScheduleFields";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: Snapshot;
  /** The automation being edited, or null to create one. */
  automation: Automation | null;
  defaultProject: string | null;
}

/**
 * Create or edit one automation, in three passes: what to run, who runs it,
 * when and where. The order matters — the prompt is the thing the user came to
 * write, and asking for a schedule first made the dialog feel like a form.
 */
export function AutomationDialog({
  automation,
  defaultProject,
  onOpenChange,
  open,
  snapshot,
}: Props) {
  const queryClient = useQueryClient();
  const now = useTicker(30_000);
  const agents = useMemo(
    () => (snapshot.agents ?? []).filter((agent) => agent.enabled),
    [snapshot.agents],
  );
  const [form, setForm] = useState<AutomationForm>(() =>
    automation
      ? formFromAutomation(automation)
      : emptyForm(
          defaultProject ?? snapshot.projects[0]?.name ?? "",
          agents[0]?.id ?? snapshot.agents?.[0]?.id ?? "claude",
        ),
  );
  const [busy, setBusy] = useState<"save" | "run" | null>(null);
  const patch = (change: Partial<AutomationForm>) =>
    setForm((previous) => ({ ...previous, ...change }));

  const problems = validateForm(form);
  const blocked = hasProblems(problems);
  const modelOption = modelOptionOf(snapshot.agents ?? [], form.agent);
  // The daemon cannot express "clear the model override" (an absent field means
  // "leave alone"), so an automation that already has one may only swap it.
  const modelLocked = !!automation?.model;

  const save = async (runAfter: boolean) => {
    if (blocked) return;
    setBusy(runAfter ? "run" : "save");
    try {
      const saved = automation
        ? await daemon.updateAutomation(automation.id, patchFrom(form))
        : await daemon.createAutomation(createInput(form));
      await queryClient.invalidateQueries({ queryKey: automationsKey });
      if (runAfter) {
        await daemon.runAutomationNow(saved.id);
        await queryClient.invalidateQueries({ queryKey: automationRunsKey(saved.id) });
      }
      toast.success(
        runAfter
          ? `${saved.name} is running now`
          : automation
            ? `${saved.name} updated`
            : `${saved.name} scheduled`,
        {
          description: runAfter
            ? "A task is picking up the prompt; the run lands in its history."
            : undefined,
        },
      );
      onOpenChange(false);
    } catch (error) {
      toast.error(
        automation ? "Could not save the automation" : "Could not create the automation",
        {
          description: error instanceof Error ? error.message : String(error),
        },
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[min(46rem,calc(100vw-3rem))] max-w-none overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{automation ? "Edit automation" : "New automation"}</DialogTitle>
          <DialogDescription>
            A named prompt the daemon runs on a schedule. Every run becomes a real task, with its
            own transcript and diff.
          </DialogDescription>
        </DialogHeader>

        <Section title="What" hint="The prompt each run sends, and what to call it.">
          <Input
            aria-label="Automation name"
            value={form.name}
            placeholder="PR triage"
            onChange={(event) => patch({ name: event.target.value })}
            className={cn("h-8 text-sm", problems.name && "border-destructive/60")}
          />
          <Textarea
            aria-label="Prompt"
            value={form.prompt}
            rows={5}
            placeholder="Review open pull requests and summarise anything that needs a human."
            onChange={(event) => patch({ prompt: event.target.value })}
            className={cn("resize-y text-sm", problems.prompt && "border-destructive/60")}
          />
        </Section>

        <Section title="Who" hint="Which harness runs it, and on which model.">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">Agent</span>
              <div className="flex items-center gap-2">
                <AgentLogo
                  agentId={form.agent}
                  displayName={agentDisplayName(form.agent)}
                  className="size-4 shrink-0"
                />
                <select
                  value={form.agent}
                  onChange={(event) => patch({ agent: event.target.value, model: "" })}
                  className="bg-deep-surface h-8 min-w-0 flex-1 rounded-md border px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
                >
                  {agents.length === 0 && <option value={form.agent}>{form.agent}</option>}
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agentDisplayName(agent.id, agent.displayName)}
                    </option>
                  ))}
                </select>
              </div>
            </label>
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">Model</span>
              <select
                value={form.model}
                disabled={!modelOption}
                onChange={(event) => patch({ model: event.target.value })}
                className="bg-deep-surface h-8 w-full rounded-md border px-2 text-xs outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
              >
                <option
                  value=""
                  disabled={modelLocked}
                  title={
                    modelLocked
                      ? "This automation already pins a model; pick another one instead."
                      : undefined
                  }
                >
                  Agent default
                </option>
                {modelOption?.options.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.name}
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-muted-foreground/70">
                {modelOption
                  ? "Pinned per automation, so a scheduled run never drifts onto another model."
                  : "The model list appears once that agent has run at least once."}
              </span>
            </label>
          </div>
        </Section>

        <Section title="When & where" hint="Schedule, project, and the guards around a run.">
          <ScheduleFields
            form={form}
            patch={patch}
            problems={problems}
            projects={snapshot.projects}
            now={now}
          />
        </Section>

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={blocked || busy !== null}
            title="Save, then run once right now — the schedule is untouched."
            onClick={() => void save(true)}
          >
            {busy === "run" ? (
              <Loader2 aria-hidden className="mr-1 size-3.5 animate-spin" />
            ) : (
              <Play aria-hidden className="mr-1 size-3.5" />
            )}
            {automation ? "Save & run now" : "Create & run now"}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={blocked || busy !== null}
            onClick={() => void save(false)}
          >
            {busy === "save" && <Loader2 aria-hidden className="mr-1 size-3.5 animate-spin" />}
            {automation ? "Save" : "Create automation"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Section({
  children,
  hint,
  title,
}: {
  children: React.ReactNode;
  hint: string;
  title: string;
}) {
  return (
    <section className="space-y-2 border-t border-border/60 pt-3 first-of-type:border-t-0 first-of-type:pt-0">
      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {title}
        </h3>
        <p className="text-[11px] text-muted-foreground/70">{hint}</p>
      </div>
      {children}
    </section>
  );
}
