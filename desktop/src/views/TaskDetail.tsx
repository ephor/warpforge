import { useEffect, useState } from "react";
import { daemon } from "../daemon";
import { FileDiff, SessionUpdate, TaskDiff, TaskInfo } from "../protocol";

interface Props {
  task: TaskInfo;
  updates: SessionUpdate[];
  onClose: () => void;
}

/**
 * Task detail: live ACP stream on the left, multi-file diff with per-hunk
 * accept/reject on the right. The diff pane is the desktop app's reason to
 * exist — target UX is Zed's agent-panel review (unified multi-buffer diff).
 */
export default function TaskDetail({ task, updates, onClose }: Props) {
  const [diff, setDiff] = useState<TaskDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);

  useEffect(() => {
    setDiff(null);
    setDiffError(null);
    daemon
      .request("diff.get", { task_id: task.id })
      .then((d) => setDiff(d as TaskDiff))
      .catch((e: Error) => setDiffError(e.message));
  }, [task.id, task.updatedAt]);

  const resolveHunk = (file: string, hunkIndex: number, resolution: "accept" | "reject") => {
    daemon
      .request("diff.resolveHunk", {
        task_id: task.id,
        file,
        hunk_index: hunkIndex,
        resolution,
      })
      .catch((e: Error) => setDiffError(e.message));
  };

  return (
    <div className="task-detail">
      <header>
        <button onClick={onClose}>← board</button>
        <h1>{task.prompt}</h1>
        <span className={`status status-${task.status}`}>{task.status}</span>
        <span className="meta">
          {task.project} · {task.agent}
        </span>
        {(task.status === "running" || task.status === "queued") && (
          <button
            className="danger"
            onClick={() => void daemon.request("task.cancel", { task_id: task.id })}
          >
            cancel
          </button>
        )}
      </header>

      <div className="panes">
        <section className="stream">
          <h2>Session</h2>
          {updates.length === 0 && <p className="empty">No session activity yet.</p>}
          <ol>
            {updates.map((u, i) => (
              <li key={i} className={`update update-${u.kind}`}>
                <UpdateRow update={u} taskId={task.id} />
              </li>
            ))}
          </ol>
        </section>

        <section className="diff">
          <h2>Changes</h2>
          {diffError && <p className="error">{diffError}</p>}
          {!diff && !diffError && <p className="empty">Loading diff…</p>}
          {diff && diff.files.length === 0 && <p className="empty">No changes yet.</p>}
          {diff?.files.map((file) => (
            <FileDiffView key={file.path} file={file} onResolve={resolveHunk} />
          ))}
        </section>
      </div>
    </div>
  );
}

function UpdateRow({ update, taskId }: { update: SessionUpdate; taskId: string }) {
  switch (update.kind) {
    case "agent_text":
      return <p>{update.text}</p>;
    case "agent_thought":
      return <p className="thought">{update.text}</p>;
    case "tool_call":
      return (
        <p>
          <span className={`tool tool-${update.status}`}>{update.status}</span> {update.title}
        </p>
      );
    case "file_edit":
      return <p>✎ {update.path}</p>;
    case "permission_request":
      return (
        <div className="permission">
          <p>⚠ {update.title}</p>
          {update.options.map((opt) => (
            <button
              key={opt}
              onClick={() =>
                void daemon.request("session.permission", {
                  task_id: taskId,
                  request_id: update.request_id,
                  outcome: opt,
                })
              }
            >
              {opt}
            </button>
          ))}
        </div>
      );
    case "turn_ended":
      return <p className="turn-end">— turn ended ({update.stop_reason}) —</p>;
  }
}

function FileDiffView({
  file,
  onResolve,
}: {
  file: FileDiff;
  onResolve: (file: string, hunkIndex: number, r: "accept" | "reject") => void;
}) {
  return (
    <details className="file-diff" open>
      <summary>
        <span className={`file-status file-${file.status}`}>{file.status}</span>{" "}
        {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      </summary>
      {file.hunks.map((hunk, i) => (
        <div key={i} className={`hunk ${hunk.resolution ? `hunk-${hunk.resolution}ed` : ""}`}>
          <div className="hunk-bar">
            <code>
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
            </code>
            <span>
              <button onClick={() => onResolve(file.path, i, "accept")}>accept</button>
              <button onClick={() => onResolve(file.path, i, "reject")}>reject</button>
            </span>
          </div>
          <pre>
            {hunk.lines.map((line, j) => (
              <div
                key={j}
                className={
                  line.startsWith("+") ? "line-add" : line.startsWith("-") ? "line-del" : ""
                }
              >
                {line}
              </div>
            ))}
          </pre>
        </div>
      ))}
    </details>
  );
}
