import { useEffect, useRef } from "react";
import { toast } from "sonner";

import AttentionToast from "@/components/AttentionToast";
import PermissionToast from "@/components/PermissionToast";
import { daemon } from "@/daemon";
import { agentDisplayName } from "@/lib/agentNames";
import { attentionToastSummary } from "@/lib/attentionToast";
import { permissionToastApproveOption, permissionToastContext } from "@/lib/permissionToast";
import { awaitsReview } from "@/lib/taskGroups";
import { taskLabel } from "@/lib/taskLabel";
import type { DaemonEvent, TaskInfo, TaskStatus } from "@/protocol";
import { useUi } from "@/store/ui";

const ATTENTION_STATUS = new Set<TaskStatus>(["waiting", "blocked", "interrupted"]);

/**
 * The state a toast is keyed on, or null when the task wants nothing. `waiting`
 * only earns a toast once the turn actually left changes behind — otherwise
 * every finished conversation would raise one, which is what made the old
 * `needs_review` toast noise.
 */
function attentionStatusOf(task: TaskInfo): TaskStatus | null {
  if (task.status === "blocked" || task.status === "interrupted") return task.status;
  return awaitsReview(task) ? "waiting" : null;
}

function attentionToastTitle(task: TaskInfo): string {
  if (task.status === "blocked") return "Task blocked";
  if (task.status === "interrupted") return "Session interrupted";
  return "Ready for review";
}

/** The barrier a pipeline is parked at, or null when it needs nothing. */
function waitingKind(task: TaskInfo): "question" | "limit" | null {
  const kind = task.workflowRun?.waiting?.kind;
  return kind === "question" || kind === "limit" ? kind : null;
}

function workflowToastTitle(kind: "question" | "limit"): string {
  return kind === "question" ? "Pipeline needs your answer" : "Pipeline is out of review rounds";
}

/** True when the window is minimized or hidden behind other apps — the case a
 *  native macOS notification should take over from the in-house toast.
 *
 *  Reads the AppKit window state rather than `document.hidden`, which only flips
 *  on minimize and stays false when the app merely loses focus to another app
 *  (tauri-apps/tauri#9524), and `document.hasFocus()`, which the webview reports
 *  unreliably. A frontmost window returns false here, so no banner is raised
 *  while the user is looking at the app. */
async function appBackgrounded(): Promise<boolean> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return !(await getCurrentWindow().isFocused());
  } catch {
    return true;
  }
}

/** Raise a native macOS notification with Approve/Reject/Review buttons, but
 *  only when inside Tauri, the app is backgrounded, and the feature is wired. */
async function fireNativeNotification(opts: {
  body: string;
  kind: "permission" | "review";
  request_id?: string;
  subtitle: string;
  task_id: string;
  title: string;
}) {
  if (!("__TAURI_INTERNALS__" in window)) return;
  if (!(await appBackgrounded())) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    // The Rust command takes a single `payload` argument; Tauri matches invoke
    // args by parameter name, so the fields must be nested rather than flat.
    await invoke("notify_attention", { payload: opts });
  } catch (error) {
    // Native notifications are best-effort; the in-house toast already covers this.
    console.warn("native notification failed", error);
  }
}

/** Bring the window back when the user chooses "Review" from a native notification. */
async function focusWindow() {
  if (!("__TAURI_INTERNALS__" in window)) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const appWindow = getCurrentWindow();
    await appWindow.unminimize();
    await appWindow.setFocus();
  } catch {}
}

export function useDaemonEvents() {
  const seenPermissionIds = useRef(new Set<string>());
  const notificationsReady = useRef(false);

  useEffect(() => {
    if (!notificationsReady.current) {
      for (const updates of Object.values(daemon.getState().sessionUpdates)) {
        for (const update of updates) {
          if (update.kind === "permission_request")
            seenPermissionIds.current.add(update.request_id);
        }
      }
      notificationsReady.current = true;
    }

    const openInChat = (taskId: string) => {
      useUi.getState().openTask(taskId);
    };
    const notifyWorkflowWaiting = (task: TaskInfo, kind: "question" | "limit") => {
      const toastId = `attention:workflow:${task.id}:${kind}`;
      const question = task.workflowRun?.waiting?.question;
      toast.custom(
        (sonnerId) => (
          <AttentionToast
            title={workflowToastTitle(kind)}
            identity={`${task.project} · ${task.workflowRun?.workflowName ?? "workflow"}`}
            summary={attentionToastSummary(question || task.prompt)}
            onDismiss={() => toast.dismiss(sonnerId)}
            onOpen={() => {
              openInChat(task.id);
              toast.dismiss(sonnerId);
            }}
          />
        ),
        {
          action: null,
          cancel: null,
          description: null,
          duration: 10_000,
          icon: null,
          id: toastId,
          richColors: false,
          unstyled: true,
        },
      );
      void fireNativeNotification({
        body: attentionToastSummary(question || task.prompt),
        kind: "review",
        subtitle: `${task.project} · ${task.workflowRun?.workflowName ?? "workflow"}`,
        task_id: task.id,
        title: workflowToastTitle(kind),
      });
    };
    const notifyTask = (task: TaskInfo) => {
      const toastId = `attention:${task.id}:${task.status}`;
      toast.custom(
        (sonnerId) => (
          <AttentionToast
            title={taskLabel(task)}
            identity={`${task.project} · ${agentDisplayName(task.agent)}`}
            summary={attentionToastSummary(task.prompt)}
            onDismiss={() => toast.dismiss(sonnerId)}
            onOpen={() => {
              openInChat(task.id);
              toast.dismiss(sonnerId);
            }}
          />
        ),
        {
          action: null,
          cancel: null,
          description: null,
          duration: 10_000,
          icon: null,
          id: toastId,
          richColors: false,
          unstyled: true,
        },
      );
      void fireNativeNotification({
        body: attentionToastSummary(task.prompt),
        kind: "review",
        subtitle: `${task.project} · ${agentDisplayName(task.agent)}`,
        task_id: task.id,
        title: attentionToastTitle(task),
      });
    };

    return daemon.subscribeEvents((event: DaemonEvent) => {
      if (event.event === "state.snapshot") {
        for (const updates of Object.values(event.data.sessionHistory ?? {})) {
          for (const update of updates) {
            if (update.kind === "permission_request") {
              seenPermissionIds.current.add(update.request_id);
            }
          }
        }
        return;
      }
      if (event.event === "session.update") {
        const { task_id: taskId, update } = event.data;
        if (update.kind === "permission_request") {
          if (seenPermissionIds.current.has(update.request_id)) return;
          seenPermissionIds.current.add(update.request_id);
          const task = daemon.getState().snapshot.tasks.find((item) => item.id === taskId);
          const context = permissionToastContext(
            update,
            daemon.getState().sessionUpdates[taskId] ?? [],
          );
          const approveOption = permissionToastApproveOption(update.options);
          const toastId = `attention:permission:${update.request_id}`;
          toast.custom(
            (sonnerId) => (
              <PermissionToast
                context={context}
                identity={task ? `${task.project} · ${agentDisplayName(task.agent)}` : undefined}
                onApprove={
                  approveOption
                    ? async () => {
                        try {
                          await daemon.request("session.permission", {
                            outcome: approveOption,
                            request_id: update.request_id,
                            task_id: taskId,
                          });
                          toast.dismiss(sonnerId);
                        } catch (error) {
                          toast.error(
                            error instanceof Error ? error.message : "Could not approve permission",
                          );
                        }
                      }
                    : undefined
                }
                onDismiss={() => toast.dismiss(sonnerId)}
                onReview={() => {
                  openInChat(taskId);
                  toast.dismiss(sonnerId);
                }}
              />
            ),
            {
              action: null,
              cancel: null,
              description: null,
              id: toastId,
              duration: Number.POSITIVE_INFINITY,
              icon: null,
              richColors: false,
              unstyled: true,
            },
          );
          void fireNativeNotification({
            body: context,
            kind: "permission",
            request_id: update.request_id,
            subtitle: task ? `${task.project} · ${agentDisplayName(task.agent)}` : taskId,
            task_id: taskId,
            title: "Permission needed",
          });
        } else if (update.kind === "permission_resolved") {
          toast.dismiss(`attention:permission:${update.request_id}`);
        }
        return;
      }

      if (event.event === "task.updated") {
        const previousTask = daemon
          .getState()
          .snapshot.tasks.find((task) => task.id === event.data.id);
        const previous = previousTask?.status;
        // A pipeline parking on the user is an attention state the coarse task
        // status cannot express (it stays Waiting), so it needs its own toast.
        const wasWaiting = previousTask ? waitingKind(previousTask) : null;
        const nowWaiting = waitingKind(event.data);
        if (nowWaiting && nowWaiting !== wasWaiting) {
          notifyWorkflowWaiting(event.data, nowWaiting);
        } else if (!nowWaiting && wasWaiting) {
          toast.dismiss(`attention:workflow:${event.data.id}:${wasWaiting}`);
        }
        const wasAttention = previousTask ? attentionStatusOf(previousTask) : null;
        const nowAttention = attentionStatusOf(event.data);
        if (nowAttention && nowAttention !== wasAttention) {
          if (wasAttention) {
            toast.dismiss(`attention:${event.data.id}:${wasAttention}`);
          }
          notifyTask(event.data);
        } else if (!nowAttention && previous) {
          toast.dismiss(`attention:${event.data.id}:${previous}`);
        }
      } else if (event.event === "task.created" && attentionStatusOf(event.data)) {
        notifyTask(event.data);
      } else if (event.event === "task.removed") {
        for (const status of ATTENTION_STATUS) {
          toast.dismiss(`attention:${event.data.id}:${status}`);
        }
      }
    });
  }, []);

  // Resolve actions tapped in native macOS notifications (Approve/Reject/Review).
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        if (disposed) return;
        unlisten = await listen("notification-action", (event) => {
          const payload = event.payload as {
            action: string;
            kind: string;
            request_id?: string | null;
            task_id: string;
          };
          const taskId = payload.task_id;
          if (
            payload.kind === "permission" &&
            (payload.action === "approve" || payload.action === "reject") &&
            payload.request_id
          ) {
            void daemon
              .request("session.permission", {
                outcome: payload.action === "approve" ? "allow" : "deny",
                request_id: payload.request_id,
                task_id: taskId,
              })
              .catch(() => {});
            return;
          }
          if (payload.action === "review") {
            useUi.getState().openTask(taskId);
            void focusWindow();
          }
        });
        if (disposed) {
          unlisten();
          unlisten = undefined;
        }
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
