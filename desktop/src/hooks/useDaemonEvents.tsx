import { useEffect, useRef } from "react";
import { toast } from "sonner";

import AttentionToast from "@/components/AttentionToast";
import PermissionToast from "@/components/PermissionToast";
import { daemon } from "@/daemon";
import { agentDisplayName } from "@/lib/agentNames";
import { attentionToastSummary } from "@/lib/attentionToast";
import { permissionToastApproveOption, permissionToastContext } from "@/lib/permissionToast";
import type { DaemonEvent, TaskInfo, TaskStatus } from "@/protocol";
import { useUi } from "@/store/ui";

const ATTENTION_STATUS = new Set<TaskStatus>(["needs_review", "blocked", "interrupted"]);

function attentionToastTitle(status: TaskStatus): string {
  if (status === "needs_review") return "Ready for review";
  if (status === "blocked") return "Task blocked";
  return "Session interrupted";
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

    const openInRail = (taskId: string) => useUi.getState().focusAttentionTask(taskId);
    const openInChat = (taskId: string) => {
      const ui = useUi.getState();
      ui.openTask(taskId);
      ui.setAttentionOpen(false);
    };
    const notifyTask = (task: TaskInfo) => {
      const toastId = `attention:${task.id}:${task.status}`;
      toast.custom(
        (sonnerId) => (
          <AttentionToast
            title={attentionToastTitle(task.status)}
            identity={`${task.project} · ${agentDisplayName(task.agent)}`}
            summary={attentionToastSummary(task.prompt)}
            onDismiss={() => toast.dismiss(sonnerId)}
            onOpen={() => {
              openInRail(task.id);
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
        } else if (update.kind === "permission_resolved") {
          toast.dismiss(`attention:permission:${update.request_id}`);
        }
        return;
      }

      if (event.event === "task.updated") {
        const previous = daemon
          .getState()
          .snapshot.tasks.find((task) => task.id === event.data.id)?.status;
        if (ATTENTION_STATUS.has(event.data.status) && previous !== event.data.status) {
          if (previous && ATTENTION_STATUS.has(previous)) {
            toast.dismiss(`attention:${event.data.id}:${previous}`);
          }
          notifyTask(event.data);
        } else if (!ATTENTION_STATUS.has(event.data.status) && previous) {
          toast.dismiss(`attention:${event.data.id}:${previous}`);
        }
      } else if (event.event === "task.created" && ATTENTION_STATUS.has(event.data.status)) {
        notifyTask(event.data);
      } else if (event.event === "task.removed") {
        for (const status of ATTENTION_STATUS) {
          toast.dismiss(`attention:${event.data.id}:${status}`);
        }
      }
    });
  }, []);
}
