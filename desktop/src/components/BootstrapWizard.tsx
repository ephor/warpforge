import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";

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

interface Props {
  /** Registered project name. */
  project: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Called after the bootstrap task is successfully started. */
  onStarted?: (taskId: string) => void;
}

const AGENTS = ["claude", "codex", "opencode", "qwen", "goose"];
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
  agent: "claude",
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
  options: readonly string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              value === opt
                ? "border-primary bg-primary/10 text-foreground"
                : "text-muted-foreground hover:bg-accent"
            }`}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
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
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      <div className="flex gap-2">
        <input
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

export default function BootstrapWizard({ project, open, onOpenChange, onStarted }: Props) {
  const [answers, setAnswers] = useState<Answers>(EMPTY_ANSWERS);
  const [stepIndex, setStepIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const patch = (p: Partial<Answers>) => setAnswers((a) => ({ ...a, ...p }));

  const steps = useMemo(() => {
    const base = ["agent", "runtime"];
    if (answers.runtimeKind !== "local") base.push("conditional");
    return [...base, "commands", "notes"];
  }, [answers.runtimeKind]);
  const currentStep = steps[Math.min(stepIndex, steps.length - 1)];

  const reset = () => {
    setAnswers(EMPTY_ANSWERS);
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
            options={AGENTS}
            value={answers.agent}
            onChange={(v) => patch({ agent: v })}
          />
        );
      case "runtime":
        return (
          <RadioRow
            label="How do services run?"
            options={RUNTIME_KINDS}
            value={answers.runtimeKind}
            onChange={(v) => patch({ runtimeKind: v as RuntimeKind })}
          />
        );
      case "conditional":
        return answers.runtimeKind === "docker-compose" ? (
          <PathRow
            label="Docker Compose file"
            value={answers.composePath}
            onChange={(v) => patch({ composePath: v })}
            placeholder="docker-compose.yml"
          />
        ) : (
          <div className="flex flex-col gap-3">
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
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Release / service names (optional, comma-separated)
              </label>
              <input
                type="text"
                value={answers.k8sReleaseNames}
                onChange={(e) => patch({ k8sReleaseNames: e.target.value })}
                placeholder="api, worker"
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Namespace (optional)
              </label>
              <input
                type="text"
                value={answers.k8sNamespace}
                onChange={(e) => patch({ k8sNamespace: e.target.value })}
                placeholder="default"
                className={inputClass}
              />
            </div>
          </div>
        );
      case "commands":
        return (
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Dev commands (comma-separated)
            </label>
            <input
              type="text"
              value={answers.devCommands}
              onChange={(e) => patch({ devCommands: e.target.value })}
              placeholder="npm run dev, npm run api"
              className={inputClass}
            />
          </div>
        );
      case "notes":
        return (
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Notes for the agent (optional)
            </label>
            <Textarea
              value={answers.notes}
              onChange={(e) => patch({ notes: e.target.value })}
              placeholder="Anything special about ports, dependencies, env vars…"
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
