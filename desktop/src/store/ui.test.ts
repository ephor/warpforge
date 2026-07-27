import { beforeEach, describe, expect, it } from "vitest";

import {
  clampSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  useUi,
} from "./ui";

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

describe("sidebar width state", () => {
  beforeEach(() => {
    localStorage.clear();
    useUi.setState({
      sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
    });
  });

  it("uses a conservative default width", () => {
    expect(useUi.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT);
  });

  it("clamps sidebar width to min/max", () => {
    useUi.getState().setSidebarWidth(100);
    expect(useUi.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_MIN);

    useUi.getState().setSidebarWidth(999);
    expect(useUi.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_MAX);

    useUi.getState().setSidebarWidth(350);
    expect(useUi.getState().sidebarWidth).toBe(350);
  });

  it("handles malformed width values", () => {
    useUi.getState().setSidebarWidth(NaN);
    expect(useUi.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT);

    useUi.getState().setSidebarWidth(Infinity);
    expect(useUi.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT);
  });

  it("clampSidebarWidth handles non-number inputs", () => {
    expect(clampSidebarWidth(undefined)).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(clampSidebarWidth("300")).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(clampSidebarWidth(null)).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(clampSidebarWidth(300)).toBe(300);
  });

  it("rehydrates persisted sidebar width", async () => {
    useUi.getState().setSidebarWidth(400);

    const stored = localStorage.getItem("wf-ui");
    useUi.setState({ sidebarWidth: SIDEBAR_WIDTH_DEFAULT });
    if (stored) localStorage.setItem("wf-ui", stored);
    await useUi.persist.rehydrate();

    expect(useUi.getState().sidebarWidth).toBe(400);
  });
});
