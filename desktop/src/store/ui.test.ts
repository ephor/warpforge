import { beforeEach, describe, expect, it } from "vitest";

import { useUi } from "./ui";

describe("task-detail UI state", () => {
  beforeEach(() => {
    useUi.setState({
      openTaskId: null,
      rightPanel: "changes",
      runtimeOpen: true,
      showChat: true,
      showDiff: true,
    });
  });

  it("resets contextual tools when opening another task", () => {
    useUi.getState().openTask("next-task");

    expect(useUi.getState().openTaskId).toBe("next-task");
    expect(useUi.getState().rightPanel).toBeNull();
    expect(useUi.getState().runtimeOpen).toBe(false);
    expect(useUi.getState().showChat).toBe(true);
    expect(useUi.getState().showDiff).toBe(true);
  });
});
