import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Loader2 } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

import { daemon } from "../daemon";
import type { AgentConfig } from "../protocol";

interface Props {
  /** Registered project name. */
  project: string;
  agents: AgentConfig[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Called after the bootstrap task is successfully started. */
  onStarted?: (taskId: string) => void;
}

const RUNTIME_KINDS = ["local", "docker-compose", "kubernetes", "mixed"] as const;
type RuntimeKind = (typeof RUNTIME_KINDS)[number];

interface Answers {
  agent: string;
  runtimeKind: RuntimeKind;
  composePath: string;
  k8sManifestsPath: string;
  k8sHelmFile: string;
  k8sReleaseNames: string;
  k8sNamespace: string;
  devCommands: string;
  notes: string;
}

const EMPTY_ANSWERS: Answers = {
  agent: "",
  runtimeKind: "local",
  composePath: "",
  k8sManifestsPath: "",
  k8sHelmFile: "",
  k8sReleaseNames: "",
  k8sNamespace: "",
  devCommands: "",
  notes: "",
};

const inputClass =
  "w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";

function RadioRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { label: string; value: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-1 block text-xs font-medium text-muted-foreground">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              value === opt.value
                ? "border-primary bg-primary/10 text-foreground"
                : "text-muted-foreground hover:bg-accent"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function PathRow({
  label,
  value,
  onChange,
  directory,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  directory?: boolean;
  placeholder?: string;
}) {
  const inputId = useId();
  const browse = async () => {
    const selected = await openDialog({
      directory: !!directory,
      multiple: false,
      title: label,
    });
    if (typeof selected === "string") onChange(selected);
  };
  return (
    <div>
      <label htmlFor={inputId} className="mb-1 block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={inputId}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={`flex-1 ${inputClass}`}
        />
        <Button variant="outline" size="sm" onClick={browse}>
          <FolderOpen className="mr-1 size-4" />
          Browse
        </Button>
      </div>
    </div>
  );
}

export default function BootstrapWizard({ project, agents, open, onOpenChange, onStarted }: Props) {
  const enabledAgents = useMemo(() => agents.filter((agent) => agent.enabled), [agents]);
  const agentOptions = useMemo(
    () => enabledAgents.map((agent) => ({ label: agent.displayName, value: agent.id })),
    [enabledAgents],
  );
  const runtimeOptions = useMemo(
    () => RUNTIME_KINDS.map((kind) => ({ label: kind, value: kind })),
    [],
  );
  const [answers, setAnswers] = useState<Answers>(() => ({
    ...EMPTY_ANSWERS,
    agent: enabledAgents[0]?.id ?? "",
  }));
  const [stepIndex, setStepIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const patch = (p: Partial<Answers>) => setAnswers((a) => ({ ...a, ...p }));

  useEffect(() => {
    setAnswers((current) => {
      if (enabledAgents.some((agent) => agent.id === current.agent)) return current;
      return { ...current, agent: enabledAgents[0]?.id ?? "" };
    });
  }, [enabledAgents]);

  const steps = useMemo(() => {
    const base = enabledAgents.length === 1 ? ["runtime"] : ["agent", "runtime"];
    if (answers.runtimeKind !== "local") base.push("conditional");
    return [...base, "commands", "notes"];
  }, [answers.runtimeKind, enabledAgents.length]);
  const currentStep = steps[Math.min(stepIndex, steps.length - 1)];

  const reset = () => {
    setAnswers({ ...EMPTY_ANSWERS, agent: enabledAgents[0]?.id ?? "" });
    setStepIndex(0);
    setError(null);
    setBusy(false);
  };

  const close = () => {
    reset();
    onOpenChange(false);
  };

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = (await daemon.request("bootstrap.start", { project, answers })) as {
        taskId: string;
      };
      if (!res.taskId) throw new Error("Daemon could not start a bootstrap task.");
      onStarted?.(res.taskId);
      close();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const isFirst = stepIndex === 0;
  const isLast = stepIndex >= steps.length - 1;

  const renderForm = () => {
    switch (currentStep) {
      case "agent":
        return (
          <RadioRow
            label="Coding agent"
            options={agentOptions}
            value={answers.agent}
            onChange={(v) => patch({ agent: v })}
          />
        );
      case "runtime":
        return (
          <RadioRow
            label="How do services run?"
            options={runtimeOptions}
            value={answers.runtimeKind}
            onChange={(v) => patch({ runtimeKind: v as RuntimeKind })}
          />
        );
      case "conditional":
        return (
          <div className="flex flex-col gap-3">
            {(answers.runtimeKind === "docker-compose" || answers.runtimeKind === "mixed") && (
              <PathRow
                label="Docker Compose file"
                value={answers.composePath}
                onChange={(v) => patch({ composePath: v })}
                placeholder="docker-compose.yml"
              />
            )}
            {(answers.runtimeKind === "kubernetes" || answers.runtimeKind === "mixed") && (
              <>
                <PathRow
                  label="Manifests directory"
                  value={answers.k8sManifestsPath}
                  onChange={(v) => patch({ k8sManifestsPath: v })}
                  directory
                  placeholder="k8s/"
                />
                <PathRow
                  label="Helm chart / values file (optional)"
                  value={answers.k8sHelmFile}
                  onChange={(v) => patch({ k8sHelmFile: v })}
                  placeholder="values.yaml"
                />
                <div>
                  <label
                    htmlFor="bootstrap-k8s-releases"
                    className="mb-1 block text-xs font-medium text-muted-foreground"
                  >
                    Release / service names (optional, comma-separated)
                  </label>
                  <input
                    id="bootstrap-k8s-releases"
                    type="text"
                    value={answers.k8sReleaseNames}
                    onChange={(e) => patch({ k8sReleaseNames: e.target.value })}
                    placeholder="api, worker"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label
                    htmlFor="bootstrap-k8s-namespace"
                    className="mb-1 block text-xs font-medium text-muted-foreground"
                  >
                    Namespace (optional)
                  </label>
                  <input
                    id="bootstrap-k8s-namespace"
                    type="text"
                    value={answers.k8sNamespace}
                    onChange={(e) => patch({ k8sNamespace: e.target.value })}
                    placeholder="default"
                    className={inputClass}
                  />
                </div>
              </>
            )}
          </div>
        );
      case "commands":
        return (
          <div>
            <label
              htmlFor="bootstrap-service-details"
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              Known services, commands, and ports (optional)
            </label>
            <Textarea
              id="bootstrap-service-details"
              value={answers.devCommands}
              onChange={(e) => patch({ devCommands: e.target.value })}
              placeholder={
                "api: pnpm --filter api dev — PORT default 4000, logs ‘API listening’\nworker: pnpm --filter worker dev — Kafka consumer, no HTTP port"
              }
              rows={5}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              The repository is scanned automatically; add facts that are hard to infer.
            </p>
          </div>
        );
      case "notes":
        return (
          <div>
            <label
              htmlFor="bootstrap-notes"
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              Variants and dependency notes (optional)
            </label>
            <Textarea
              id="bootstrap-notes"
              value={answers.notes}
              onChange={(e) => patch({ notes: e.target.value })}
              placeholder="Which variants are mutually exclusive? Which workers use Kafka or Redis? Note any unusual startup behavior."
              rows={4}
            />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) close();
        else onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Configure {project}</DialogTitle>
          <DialogDescription>
            Answer a few questions and an agent will draft a{" "}
            <code className="text-foreground">.warpforge.yaml</code> for this project.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-1">
          <div className="text-xs text-muted-foreground">
            Step {stepIndex + 1} of {steps.length}
          </div>
          {renderForm()}
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={isFirst ? close : () => setStepIndex((i) => i - 1)}>
            {isFirst ? "Cancel" : "Back"}
          </Button>
          {isLast ? (
            <Button onClick={generate} disabled={busy}>
              {busy && <Loader2 className="mr-1 size-4 animate-spin" />}
              Generate config
            </Button>
          ) : (
            <Button onClick={() => setStepIndex((i) => i + 1)}>Next</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
