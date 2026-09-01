import {
  DEFAULT_PRESET_TIME,
  isValidTimezone,
  parseCron,
  presetCron,
  presetTimeFromCron,
  runtimeTimezone,
} from "@/lib/automationSchedule";
import type {
  Automation,
  AutomationInput,
  AutomationPatch,
  AutomationPreset,
  AutomationTrigger,
} from "@/protocol";
import { DEFAULT_MISSED_RUN_GRACE_MINUTES } from "@/protocol";

/** Editing state for one automation. Times are kept apart from the cron so
 *  switching preset → custom → preset does not lose the hour you picked. */
export interface AutomationForm {
  name: string;
  prompt: string;
  project: string;
  agent: string;
  /** "" means "inherit the agent's last-used model". */
  model: string;
  preset: AutomationPreset;
  /** Only used when `preset` is "custom". */
  cron: string;
  hour: number;
  minute: number;
  /** 1 = Sunday … 7 = Saturday. */
  weekday: number;
  timezone: string;
  precheck: string;
  /** Kept as text so the field can be emptied while typing. */
  graceMinutes: string;
  reuseSession: boolean;
  worktree: boolean;
  enabled: boolean;
}

export function emptyForm(project: string, agent: string): AutomationForm {
  return {
    agent,
    cron: "0 9 * * *",
    enabled: true,
    graceMinutes: String(DEFAULT_MISSED_RUN_GRACE_MINUTES),
    hour: DEFAULT_PRESET_TIME.hour,
    minute: DEFAULT_PRESET_TIME.minute,
    model: "",
    name: "",
    preset: "daily",
    precheck: "",
    project,
    prompt: "",
    reuseSession: false,
    timezone: runtimeTimezone(),
    weekday: DEFAULT_PRESET_TIME.weekday,
    worktree: false,
  };
}

export function formFromAutomation(automation: Automation): AutomationForm {
  const time = presetTimeFromCron(automation.trigger.cron);
  return {
    agent: automation.agent,
    cron: automation.trigger.cron,
    enabled: automation.enabled,
    graceMinutes: String(automation.missedRunGraceMinutes),
    hour: time.hour,
    minute: time.minute,
    model: automation.model ?? "",
    name: automation.name,
    preset: automation.trigger.preset,
    precheck: automation.precheck ?? "",
    project: automation.project,
    prompt: automation.prompt,
    reuseSession: automation.reuseSession,
    timezone: automation.timezone || runtimeTimezone(),
    weekday: time.weekday,
    worktree: automation.worktree,
  };
}

/** The trigger the daemon will store for this form. */
export function effectiveTrigger(form: AutomationForm): AutomationTrigger {
  return {
    cron:
      form.preset === "custom"
        ? form.cron.trim()
        : presetCron(form.preset, {
            hour: form.hour,
            minute: form.minute,
            weekday: form.weekday,
          }),
    preset: form.preset,
  };
}

export interface FormProblems {
  name?: string;
  prompt?: string;
  project?: string;
  cron?: string;
  timezone?: string;
  graceMinutes?: string;
}

export function validateForm(form: AutomationForm): FormProblems {
  const problems: FormProblems = {};
  if (!form.name.trim()) problems.name = "Give the automation a name.";
  if (!form.prompt.trim()) problems.prompt = "Write the prompt the agent will receive.";
  if (!form.project) problems.project = "Pick a project.";
  const parsed = parseCron(effectiveTrigger(form).cron);
  if (!parsed.ok) problems.cron = parsed.error;
  if (!isValidTimezone(form.timezone)) {
    problems.timezone = "Not an IANA zone name, e.g. Europe/Kyiv.";
  }
  const grace = Number(form.graceMinutes);
  if (!/^\d+$/.test(form.graceMinutes.trim()) || !Number.isFinite(grace)) {
    problems.graceMinutes = "Minutes, as a whole number.";
  }
  return problems;
}

export function hasProblems(problems: FormProblems): boolean {
  return Object.keys(problems).length > 0;
}

export function createInput(form: AutomationForm): AutomationInput {
  return {
    agent: form.agent,
    enabled: form.enabled,
    missedRunGraceMinutes: Number(form.graceMinutes),
    model: form.model || null,
    name: form.name.trim(),
    precheck: form.precheck.trim() || null,
    project: form.project,
    prompt: form.prompt.trim(),
    reuseSession: form.reuseSession,
    timezone: form.timezone.trim(),
    trigger: effectiveTrigger(form),
    worktree: form.worktree,
  };
}

/**
 * Patch for an edit. `model` is omitted when the form says "agent default":
 * the daemon reads an absent field as "leave alone" and cannot express
 * "clear it", so sending anything here would either lie or store an empty
 * model id. The dialog therefore refuses to offer that transition (see
 * `AutomationDialog`). `precheck` clears with `""`, which the daemon treats as
 * "no precheck".
 */
export function patchFrom(form: AutomationForm): AutomationPatch {
  const patch: AutomationPatch = {
    agent: form.agent,
    enabled: form.enabled,
    missedRunGraceMinutes: Number(form.graceMinutes),
    name: form.name.trim(),
    precheck: form.precheck.trim(),
    project: form.project,
    prompt: form.prompt.trim(),
    reuseSession: form.reuseSession,
    timezone: form.timezone.trim(),
    trigger: effectiveTrigger(form),
    worktree: form.worktree,
  };
  if (form.model) patch.model = form.model;
  return patch;
}
