import { beforeEach, describe, expect, it } from "vitest";

import { useUi } from "./ui";

describe("task-detail UI state", () => {
  beforeEach(() => {
    localStorage.clear();
    useUi.setState({
      openTaskId: null,
      repositoryOperation: null,
      rightPanel: "changes",
      runtimeOpenByProject: { warpforge: true },
      showChat: true,
      showDiff: true,
    });
  });

  it("resets contextual tools without changing project Runtime visibility", () => {
    useUi.getState().openTask("next-task");

    expect(useUi.getState().openTaskId).toBe("next-task");
    expect(useUi.getState().rightPanel).toBeNull();
    expect(useUi.getState().runtimeOpenByProject).toEqual({ warpforge: true });
    expect(useUi.getState().showChat).toBe(true);
    expect(useUi.getState().showDiff).toBe(true);
  });

  it("tracks Runtime visibility independently by project", () => {
    useUi.getState().setRuntimeOpen("warpforge", false);
    useUi.getState().setRuntimeOpen("other-project", true);

    expect(useUi.getState().runtimeOpenByProject).toEqual({
      "other-project": true,
      warpforge: false,
    });

    useUi.getState().toggleRuntime("warpforge");
    expect(useUi.getState().runtimeOpenByProject.warpforge).toBe(true);
    expect(useUi.getState().runtimeOpenByProject["other-project"]).toBe(true);
  });

  it("clears only the removed project's persisted Runtime visibility", () => {
    useUi.setState({ runtimeOpenByProject: { alpha: true, beta: false } });

    useUi.getState().clearRuntimeOpen("alpha");

    expect(useUi.getState().runtimeOpenByProject).toEqual({ beta: false });
  });

  it("persists and hydrates project Runtime visibility", async () => {
    useUi.getState().setRuntimeOpen("other-project", true);

    const persistedValue = localStorage.getItem("wf-ui");
    const persisted = JSON.parse(persistedValue ?? "{}") as {
      state?: { runtimeOpenByProject?: Record<string, boolean> };
    };
    expect(persisted.state?.runtimeOpenByProject).toEqual({
      "other-project": true,
      warpforge: true,
    });

    useUi.setState({ runtimeOpenByProject: {} });
    if (persistedValue) localStorage.setItem("wf-ui", persistedValue);
    await useUi.persist.rehydrate();

    expect(useUi.getState().runtimeOpenByProject).toEqual({
      "other-project": true,
      warpforge: true,
    });
  });

  it("tracks transient repository activity for the task footer", () => {
    useUi.getState().setRepositoryOperation({ kind: "pull", taskId: "task-1" });

    expect(useUi.getState().repositoryOperation).toEqual({ kind: "pull", taskId: "task-1" });

    useUi.getState().setRepositoryOperation(null);
    expect(useUi.getState().repositoryOperation).toBeNull();
  });
});
