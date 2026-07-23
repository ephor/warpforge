import { useEffect } from "react";
import { toast } from "sonner";

import { daemon } from "@/daemon";
import type { GitOpResult, TaskInfo } from "@/protocol";
import { useUi } from "@/store/ui";

export function usePullShortcut(tasks: TaskInfo[]) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "t") {
        return;
      }
      const id = useUi.getState().openTaskId;
      if (!id) {
        return;
      }
      e.preventDefault();
      const task = tasks.find((t) => t.id === id);
      if (!task) {
        return;
      }
      if (useUi.getState().repositoryOperation) {
        return;
      }
      useUi.getState().setRepositoryOperation({ kind: "pull", taskId: id });
      daemon
        .request("git.update", { task_id: id })
        .then((r) => {
          const res = r as GitOpResult;
          switch (res.status) {
            case "up_to_date":
              toast.info(res.message);
              break;
            case "ok":
              toast.success(res.message);
              break;
            case "conflict":
              toast.error(res.message, {
                description: res.conflicts.length > 0 ? res.conflicts.join(", ") : undefined,
              });
              break;
            case "error":
              toast.error(res.message);
              break;
          }
        })
        .catch((error: Error) => toast.error(error.message))
        .finally(() => {
          const operation = useUi.getState().repositoryOperation;
          if (operation?.taskId === id && operation.kind === "pull") {
            useUi.getState().setRepositoryOperation(null);
          }
        });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [tasks]);
}
