import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useSessionHistory } from "./useSessionHistory";

const loadSessionHistory = vi.fn<(taskId: string) => Promise<void>>(async () => {});

vi.mock("@/daemon", () => ({
  daemon: {
    loadSessionHistory: (taskId: string) => loadSessionHistory(taskId),
  },
}));

describe("useSessionHistory", () => {
  beforeEach(() => {
    loadSessionHistory.mockClear();
  });

  it("holds the transcript until the fetch resolves", async () => {
    let settle = () => {};
    loadSessionHistory.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );

    const { result } = renderHook(() => useSessionHistory("t1"));
    expect(result.current).toBe(false);

    await act(async () => settle());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("resolves even when the fetch fails, so the chat does not spin forever", async () => {
    loadSessionHistory.mockImplementationOnce(async () => {
      throw new Error("daemon unreachable");
    });

    const { result } = renderHook(() => useSessionHistory("t1"));
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("re-arms for the next task so its own transcript mounts in one piece", async () => {
    const { result, rerender } = renderHook(({ id }) => useSessionHistory(id), {
      initialProps: { id: "t1" },
    });
    await waitFor(() => expect(result.current).toBe(true));

    rerender({ id: "t2" });
    expect(result.current).toBe(false);
    await waitFor(() => expect(result.current).toBe(true));
    expect(loadSessionHistory.mock.calls).toEqual([["t1"], ["t2"]]);
  });
});
