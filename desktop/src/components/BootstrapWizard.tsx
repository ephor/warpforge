import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, Check, FolderOpen, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

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

interface Issue {
  severity: string;
  message: string;
}

type Phase = "form" | "sending" | "review" | "error";

const inputClass =
  "w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";

/** A labelled row with a segmented single-choice control. */
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

/** A folder/file path input with a Browse button. */
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

const TERMINAL_STATUSES = new Set(["idle", "done", "needs_review", "blocked", "interrupted"]);

export default function BootstrapWizard({ project, open, onOpenChange }: Props) {
  const [answers, setAnswers] = useState<Answers>(EMPTY_ANSWERS);
  const [stepIndex, setStepIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("form");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [yaml, setYaml] = useState("");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const finalizedRef = useRef(false);

  const patch = (p: Partial<Answers>) => setAnswers((a) => ({ ...a, ...p }));

  // Steps depend on the chosen runtime: the conditional step only appears when
  // services aren't purely local.
  const steps = useMemo(() => {
    const base = ["agent", "runtime"];
    if (answers.runtimeKind !== "local") base.push("conditional");
    return [...base, "commands", "notes"];
  }, [answers.runtimeKind]);
  const currentStep = steps[Math.min(stepIndex, steps.length - 1)];

  const tasks = useSyncExternalStore(daemon.subscribe, () => daemon.getState().snapshot.tasks);
  const sessionUpdates = useSyncExternalStore(
    daemon.subscribe,
    () => daemon.getState().sessionUpdates,
  );

  const task = taskId ? tasks.find((t) => t.id === taskId) : undefined;
  const response = useMemo(() => {
    if (!taskId) return "";
    return (sessionUpdates[taskId] ?? [])
      .filter((u) => u.kind === "agent_text")
      .map((u) => (u as { text: string }).text)
      .join("");
  }, [taskId, sessionUpdates]);

  // Once the agent finishes its turn, read back the .warpforge.yaml it wrote
  // and validate it for the review step.
  useEffect(() => {
    if (phase !== "sending" || finalizedRef.current) return;
    if (!task || !TERMINAL_STATUSES.has(task.status)) return;
    finalizedRef.current = true;
    (async () => {
      try {
        const res = (await daemon.request("bootstrap.readConfig", { project })) as {
          yaml: string;
          issues: Issue[];
        };
        setYaml(res.yaml);
        setIssues(res.issues ?? []);
        setPhase("review");
      } catch (e) {
        setError(String(e));
        setPhase("error");
      }
    })();
  }, [phase, task, project]);

  const reset = () => {
    setAnswers(EMPTY_ANSWERS);
    setStepIndex(0);
    setPhase("form");
    setTaskId(null);
    setYaml("");
    setIssues([]);
    setError(null);
    setBusy(false);
    finalizedRef.current = false;
  };

  const close = () => {
    reset();
    onOpenChange(false);
  };

  const generate = async () => {
    setBusy(true);
    setError(null);
    setPhase("sending");
    finalizedRef.current = false;
    try {
      const res = (await daemon.request("bootstrap.start", { project, answers })) as {
        taskId: string;
      };
      if (!res.taskId) throw new Error("The daemon could not start a bootstrap task for this agent.");
      setTaskId(res.taskId);
    } catch (e) {
      setError(String(e));
      setPhase("error");
    } finally {
      setBusy(false);
    }
  };

  const revalidate = async () => {
    try {
      const res = (await daemon.request("bootstrap.finalize", { response: yaml })) as {
        yaml: string;
        issues: Issue[];
      };
      setYaml(res.yaml);
      setIssues(res.issues ?? []);
    } catch (e) {
      setError(String(e));
    }
  };

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await daemon.request("bootstrap.writeConfig", { project, yaml });
      close();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const discard = () => {
    if (taskId) void daemon.request("task.cancel", { task_id: taskId });
    close();
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

        {phase === "form" && (
          <>
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
          </>
        )}

        {phase === "sending" && (
          <div className="flex flex-col items-center gap-3 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            <p>{answers.agent} is inspecting the repo and drafting a config…</p>
            {response.trim() && (
              <pre className="max-h-40 w-full overflow-auto rounded-md border bg-muted/40 p-2 text-xs">
                {response.slice(-1200)}
              </pre>
            )}
          </div>
        )}

        {phase === "review" && (
          <>
            <div className="flex flex-col gap-2 py-1">
              <label className="text-xs font-medium text-muted-foreground">
                Proposed .warpforge.yaml — edit before accepting if needed
              </label>
              <Textarea
                value={yaml}
                onChange={(e) => setYaml(e.target.value)}
                className="min-h-[240px] font-mono text-xs"
                spellCheck={false}
              />
              {issues.length > 0 && (
                <div className="flex flex-col gap-1">
                  {issues.map((issue) => (
                    <div
                      key={`${issue.severity}:${issue.message}`}
                      className={`flex items-center gap-1 text-xs ${
                        issue.severity === "error" ? "text-red-400" : "text-amber-400"
                      }`}
                    >
                      <AlertTriangle className="size-3.5" />
                      {issue.message}
                    </div>
                  ))}
                </div>
              )}
              {error && <p className="text-xs text-red-400">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={discard}>
                Discard
              </Button>
              <Button variant="outline" onClick={revalidate}>
                Re-validate
              </Button>
              <Button onClick={accept} disabled={busy || !yaml.trim()}>
                {busy ? (
                  <Loader2 className="mr-1 size-4 animate-spin" />
                ) : (
                  <Check className="mr-1 size-4" />
                )}
                Accept &amp; write
              </Button>
            </DialogFooter>
          </>
        )}

        {phase === "error" && (
          <>
            <div className="py-4 text-sm text-red-400">{error ?? "Something went wrong."}</div>
            <DialogFooter>
              <Button variant="outline" onClick={close}>
                Close
              </Button>
              <Button onClick={() => setPhase("form")}>Back to start</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
