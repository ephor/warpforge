import { useMemo, useState } from "react";
import { Snapshot, TaskInfo, TaskStatus } from "../protocol";

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: "queued", label: "Queued" },
  { status: "running", label: "Running" },
  { status: "needs_review", label: "Needs review" },
  { status: "blocked", label: "Blocked" },
  { status: "done", label: "Done" },
];

interface Props {
  snapshot: Snapshot;
  onOpenTask: (id: string) => void;
}

export default function Board({ snapshot, onOpenTask }: Props) {
  const [projectFilter, setProjectFilter] = useState<string>("");
  const [agentFilter, setAgentFilter] = useState<string>("");
  const [tagFilter, setTagFilter] = useState<string>("");

  const agents = useMemo(
    () => [...new Set(snapshot.tasks.map((t) => t.agent))].sort(),
    [snapshot.tasks],
  );
  const tags = useMemo(
    () => [...new Set(snapshot.tasks.flatMap((t) => t.tags))].sort(),
    [snapshot.tasks],
  );

  const visible = snapshot.tasks.filter(
    (t) =>
      (!projectFilter || t.project === projectFilter) &&
      (!agentFilter || t.agent === agentFilter) &&
      (!tagFilter || t.tags.includes(tagFilter)),
  );

  // Interrupted tasks (daemon restarted mid-session) surface in Blocked.
  const inColumn = (status: TaskStatus, t: TaskInfo) =>
    t.status === status || (status === "blocked" && t.status === "interrupted");

  return (
    <div className="board-view">
      <div className="filters">
        <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
          <option value="">All projects</option>
          {snapshot.projects.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)}>
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
          <option value="">All tags</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      <div className="board">
        {COLUMNS.map((col) => {
          const cards = visible.filter((t) => inColumn(col.status, t));
          return (
            <section key={col.status} className={`column column-${col.status}`}>
              <h2>
                {col.label} <span className="count">{cards.length}</span>
              </h2>
              {cards.map((task) => (
                <TaskCard key={task.id} task={task} onOpen={() => onOpenTask(task.id)} />
              ))}
              {cards.length === 0 && <div className="empty">—</div>}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function TaskCard({ task, onOpen }: { task: TaskInfo; onOpen: () => void }) {
  return (
    <article className="card" onClick={onOpen}>
      <div className="card-head">
        <span className="project">{task.project}</span>
        <span className="agent">{task.agent}</span>
      </div>
      <p className="prompt">{task.prompt}</p>
      <div className="card-foot">
        {task.filesChanged > 0 && <span className="badge">{task.filesChanged} files</span>}
        {task.tags.map((tag) => (
          <span key={tag} className="tag">
            {tag}
          </span>
        ))}
        {task.status === "interrupted" && <span className="badge warn">interrupted</span>}
        {task.blockedReason && <span className="badge warn">{task.blockedReason}</span>}
      </div>
    </article>
  );
}
