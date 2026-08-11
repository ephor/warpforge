import { ListTodo } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { AgentBadge } from "@/components/AgentBadge";
import { ChatTranscript } from "@/components/ChatTranscript";
import type { ComposerHandle } from "@/components/Composer";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useTaskSessionUpdates } from "@/hooks/useTaskSessionUpdates";
import { sessionActivity } from "@/lib/sessionActivity";
import type { TaskTree } from "@/lib/taskGroups";
import { taskLabel } from "@/lib/taskLabel";
import { cn } from "@/lib/utils";
import { workflowStageLabel } from "@/lib/workflow";

import type { AgentConfig, OrchNodeInfo, TaskInfo } from "../../protocol";

/**
 * One row of the pipeline, from either source it can come from.
 *
 * A workflow parent reports `orchestrationGraph`, whose nodes are stage
 * records. A plain orchestrator has no graph at all — it spawns children over
 * MCP, and they exist only as tasks pointing back with `parentTaskId`. Both
 * are "the work this task farmed out", so both render here rather than only
 * the workflow case having a view.
 */
interface PipelineStep {
  key: string;
  /** What to call the step: a stage label, or the child task's title. */
  label: string;
  agent: string;
  /** `null` for a stage whose task has not been created yet. */
  taskId: string | null;
  /** Present only for graph nodes — plain children have a task status instead. */
  node: OrchNodeInfo | null;
  task: TaskInfo | null;
}

/** Labels repeat when a stage re-runs, so index-qualify the key. */
function stepKey(taskId: string | null, label: string, index: number): string {
  return `${taskId ?? "pending"}:${label}:${index}`;
}

function graphSteps(nodes: readonly OrchNodeInfo[], byTaskId: Map<string, TaskInfo>) {
  return nodes.map<PipelineStep>((node, index) => ({
    agent: node.agent,
    key: stepKey(node.taskId ?? null, node.id || node.kind, index),
    label: node.id || node.kind,
    node,
    task: node.taskId ? (byTaskId.get(node.taskId) ?? null) : null,
    taskId: node.taskId ?? null,
  }));
}

function childSteps(children: readonly TaskTree[]) {
  return children.map<PipelineStep>((child, index) => ({
    agent: child.task.agent,
    key: stepKey(child.task.id, child.task.id, index),
    label: taskLabel(child.task),
    node: null,
    task: child.task,
    taskId: child.task.id,
  }));
}

function StepRow({
  step,
  selected,
  onSelect,
}: {
  step: PipelineStep;
  selected: boolean;
  onSelect: (step: PipelineStep) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(step)}
      className={cn(
        "flex w-full items-center gap-2 rounded border-l-2 border-transparent bg-secondary/30 px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary/60",
        selected && "border-primary bg-secondary/70 text-foreground",
      )}
    >
      {step.node ? (
        <StatusBadge kind="node" status={step.node.status} size="xs" />
      ) : step.task ? (
        <StatusBadge status={step.task.status} size="xs" />
      ) : null}
      <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={step.label}>
        {step.label}
      </span>
      <AgentBadge agentId={step.agent} size="xs" className="shrink-0 text-muted-foreground" />
    </button>
  );
}

/**
 * A child's live transcript, read-only. The point of the surface: seeing what
 * a sub-agent is doing right now without leaving the parent conversation.
 * Steering it is a deliberate second step — "Open task" — because replying
 * here would mean typing into a session the header says you are not in.
 */
function StepTranscript({
  task,
  agents,
  onOpenTask,
}: {
  task: TaskInfo;
  agents: AgentConfig[];
  onOpenTask: (id: string) => void;
}) {
  const updates = useTaskSessionUpdates(task.id);
  const activity = useMemo(() => sessionActivity(task, updates), [task, updates]);
  // The composer is not rendered in read-only mode, but ChatTranscript still
  // requires the ref — nothing ever reads this one.
  const composerRef = useRef<ComposerHandle>(null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3 py-2">
        <StatusBadge status={task.status} size="xs" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {taskLabel(task)}
        </span>
        <Button type="button" size="sm" variant="secondary" onClick={() => onOpenTask(task.id)}>
          Open task
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <ChatTranscript
          key={task.id}
          readOnly
          active
          activity={activity}
          agents={agents}
          commands={[]}
          composerRef={composerRef}
          files={[]}
          filesLoading={false}
          imageSupported={false}
          onOpenFile={() => {}}
          onOpenFileDiff={() => {}}
          onOpenTask={onOpenTask}
          resolveFilePath={() => null}
          task={task}
          updates={updates}
        />
      </div>
    </div>
  );
}

/**
 * Pipeline surface: the stages a task farmed out, and the live transcript of
 * whichever one you select.
 *
 * Named for what it shows. It used to be "Plan", which collided with the
 * `plan` stage kind that is only *one* of the rows inside it — the tab was
 * named after one of its own list items.
 */
export function PipelineSurface({
  task,
  childTasks,
  agents,
  onOpenTask,
}: {
  task: TaskInfo;
  /** Child tasks from `parentTaskId`, for orchestrators with no graph. */
  childTasks: readonly TaskTree[];
  agents: AgentConfig[];
  onOpenTask: (id: string) => void;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const graph = task.orchestrationGraph;
  const run = task.workflowRun;

  const byTaskId = useMemo(() => {
    const map = new Map<string, TaskInfo>();
    for (const child of childTasks) map.set(child.task.id, child.task);
    return map;
  }, [childTasks]);

  const steps = useMemo(
    () => (graph ? graphSteps(graph.nodes, byTaskId) : childSteps(childTasks)),
    [byTaskId, childTasks, graph],
  );

  const selected = steps.find((step) => step.key === selectedKey) ?? null;
  const completed = graph
    ? graph.nodes.filter((node) => node.status === "complete").length
    : childTasks.filter((child) => child.task.status === "done").length;

  if (steps.length === 0) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6 text-center">
        <div>
          <ListTodo className="mx-auto size-5 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium text-foreground">Nothing farmed out yet</p>
          <p className="mt-1 max-w-xs text-xs text-muted-foreground">
            Stages appear here once this task delegates to child agents.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-64 shrink-0 flex-col border-r border-border/70">
        <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3 py-2">
          <ListTodo className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Stages</span>
          <span className="tnum ml-auto text-xs text-muted-foreground">
            {completed}/{steps.length}
          </span>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1 p-2">
            {steps.map((step) => (
              <StepRow
                key={step.key}
                step={step}
                selected={step.key === selectedKey}
                onSelect={() => setSelectedKey(step.key)}
              />
            ))}
          </div>
        </ScrollArea>
      </div>

      <div className="min-w-0 flex-1">
        {selected?.task ? (
          <StepTranscript task={selected.task} agents={agents} onOpenTask={onOpenTask} />
        ) : selected ? (
          <div className="p-4 text-xs text-muted-foreground">
            This stage has not started — no session to show yet.
          </div>
        ) : (
          <div className="overflow-auto p-4">
            <div className="text-xs font-semibold text-foreground">
              {run ? run.workflowName : "Orchestration"}
            </div>
            {run && (
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
                <dt className="text-muted-foreground">Stage</dt>
                <dd className="text-foreground">{workflowStageLabel(run.stage)}</dd>
                {run.round > 0 && run.stage !== "done" && run.stage !== "failed" && (
                  <>
                    <dt className="text-muted-foreground">Round</dt>
                    <dd className="tnum text-foreground">
                      {run.round}/{run.maxRounds}
                    </dd>
                  </>
                )}
                {run.verdict && (
                  <>
                    <dt className="text-muted-foreground">Verdict</dt>
                    <dd className="text-foreground">
                      {run.verdict === "approve" ? "Approved" : "Changes requested"}
                    </dd>
                  </>
                )}
              </dl>
            )}
            <p className="mt-4 text-xs text-muted-foreground">
              Select a stage to watch what its agent is doing.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
