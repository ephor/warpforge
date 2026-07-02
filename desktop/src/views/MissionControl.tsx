import { useState } from "react";
import { daemon, DaemonState } from "../daemon";
import { SessionUpdate, TaskInfo } from "../protocol";

/**
 * Mission Control — the default, attention-driven operating view.
 *
 * Left: attention rail — everything blocked on a human decision, triaged and
 * actionable inline. Right: the session wall — every live task as a
 * glanceable tile with its current activity line. Pinned tiles expand into a
 * focus row of side-by-side live streams. See docs/UI_CONCEPT.md.
 */

interface Props {
  state: DaemonState;
  onOpenTask: (id: string) => void;
}

interface AttentionItem {
  task: TaskInfo;
  reason: string;
  /** Lower = more urgent. */
  priority: number;
  permission?: Extract<SessionUpdate, { kind: "permission_request" }>;
}

function pendingPermission(updates: SessionUpdate[]) {
  const last = updates[updates.length - 1];
  return last?.kind === "permission_request" ? last : undefined;
}

function attentionQueue(state: DaemonState): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const task of state.snapshot.tasks) {
    const permission = pendingPermission(state.sessionUpdates[task.id] ?? []);
    if (permission) {
      items.push({ task, reason: permission.title, priority: 0, permission });
    } else if (task.status === "needs_review") {
      items.push({ task, reason: "finished — review changes", priority: 1 });
    } else if (task.status === "blocked") {
      items.push({ task, reason: task.blockedReason ?? "blocked", priority: 2 });
    } else if (task.status === "interrupted") {
      items.push({ task, reason: "session lost on daemon restart", priority: 3 });
    }
  }
  return items.sort((a, b) => a.priority - b.priority || a.task.updatedAt - b.task.updatedAt);
}

function activityLine(updates: SessionUpdate[]): string {
  for (let i = updates.length - 1; i >= 0; i--) {
    const u = updates[i];
    switch (u.kind) {
      case "tool_call":
        return `⚙ ${u.title}`;
      case "file_edit":
        return `✎ ${u.path}`;
      case "agent_text":
        return u.text;
      case "permission_request":
        return `⚠ ${u.title}`;
      case "turn_ended":
        return `— turn ended (${u.stop_reason})`;
      case "agent_thought":
        continue;
    }
  }
  return "waiting for agent…";
}

export default function MissionControl({ state, onOpenTask }: Props) {
  const [pinned, setPinned] = useState<string[]>([]);

  const live = state.snapshot.tasks.filter((t) => t.status !== "done");
  const queue = attentionQueue(state);
  const working = live.filter((t) => t.status === "running").length;

  const togglePin = (id: string) =>
    setPinned((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-3), id]));

  const pinnedTasks = pinned
    .map((id) => live.find((t) => t.id === id))
    .filter((t): t is TaskInfo => !!t);

  return (
    <div className="mission">
      <aside className="attention-rail">
        <h2>Needs you {queue.length > 0 && <span className="count hot">{queue.length}</span>}</h2>
        {queue.length === 0 ? (
          <p className="all-quiet">
            All quiet — {working} agent{working === 1 ? "" : "s"} working.
            <br />
            Nothing needs you.
          </p>
        ) : (
          queue.map((item) => (
            <div key={item.task.id} className="attention-item">
              <div className="attn-head" onClick={() => onOpenTask(item.task.id)}>
                <span className="project">{item.task.project}</span>
                <span className={`status status-${item.task.status}`}>{item.task.status}</span>
              </div>
              <p className="reason">{item.reason}</p>
              {item.permission && (
                <div className="attn-actions">
                  {item.permission.options.map((opt) => (
                    <button
                      key={opt}
                      onClick={() =>
                        void daemon.request("session.permission", {
                          task_id: item.task.id,
                          request_id: item.permission!.request_id,
                          outcome: opt,
                        })
                      }
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              )}
              {item.task.status === "needs_review" && (
                <div className="attn-actions">
                  <button onClick={() => onOpenTask(item.task.id)}>review diff</button>
                </div>
              )}
            </div>
          ))
        )}
      </aside>

      <div className="wall-area">
        {pinnedTasks.length > 0 && (
          <div className="focus-row">
            {pinnedTasks.map((task) => (
              <FocusPane
                key={task.id}
                task={task}
                updates={state.sessionUpdates[task.id] ?? []}
                onUnpin={() => togglePin(task.id)}
                onOpen={() => onOpenTask(task.id)}
              />
            ))}
          </div>
        )}

        <div className="wall">
          {live.length === 0 && (
            <p className="empty big">
              No live sessions. Spawn one from a project, or via <code>wf</code>.
            </p>
          )}
          {live.map((task) => (
            <SessionTile
              key={task.id}
              task={task}
              updates={state.sessionUpdates[task.id] ?? []}
              pinned={pinned.includes(task.id)}
              onPin={() => togglePin(task.id)}
              onOpen={() => onOpenTask(task.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function SessionTile({
  task,
  updates,
  pinned,
  onPin,
  onOpen,
}: {
  task: TaskInfo;
  updates: SessionUpdate[];
  pinned: boolean;
  onPin: () => void;
  onOpen: () => void;
}) {
  return (
    <article className={`tile tile-${task.status} ${pinned ? "pinned" : ""}`} onClick={onPin}>
      <div className="tile-head">
        <span className="project">{task.project}</span>
        <span className="agent">{task.agent}</span>
        <button
          className="tile-open"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          title="Open full detail"
        >
          ⤢
        </button>
      </div>
      <p className="prompt">{task.prompt}</p>
      <p className="activity">{activityLine(updates)}</p>
      <div className="tile-foot">
        <span className={`status status-${task.status}`}>{task.status.replace("_", " ")}</span>
        {task.filesChanged > 0 && <span className="badge">{task.filesChanged} files</span>}
      </div>
    </article>
  );
}

function FocusPane({
  task,
  updates,
  onUnpin,
  onOpen,
}: {
  task: TaskInfo;
  updates: SessionUpdate[];
  onUnpin: () => void;
  onOpen: () => void;
}) {
  const recent = updates.slice(-12);
  return (
    <section className={`focus-pane tile-${task.status}`}>
      <header>
        <span className="project">{task.project}</span>
        <span className="prompt">{task.prompt}</span>
        <button onClick={onOpen} title="Full detail">
          ⤢
        </button>
        <button onClick={onUnpin} title="Unpin">
          ✕
        </button>
      </header>
      <div className="focus-stream">
        {recent.length === 0 && <p className="empty">waiting for agent…</p>}
        {recent.map((u, i) => (
          <p key={i} className={`fs-${u.kind}`}>
            {u.kind === "tool_call" && `⚙ ${u.title} (${u.status})`}
            {u.kind === "file_edit" && `✎ ${u.path}`}
            {u.kind === "agent_text" && u.text}
            {u.kind === "agent_thought" && <i>{u.text}</i>}
            {u.kind === "permission_request" && `⚠ ${u.title}`}
            {u.kind === "turn_ended" && `— turn ended (${u.stop_reason})`}
          </p>
        ))}
      </div>
    </section>
  );
}
