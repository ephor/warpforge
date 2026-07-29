import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";

import type { SessionUpdate } from "../../protocol";
import { useTaskFileEditCacheSync } from "./useTaskQueries";

describe("useTaskFileEditCacheSync", () => {
  it("invalidates task file queries when a file edit arrives", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const fileEdit: SessionUpdate = {
      additions: 3,
      deletions: 1,
      kind: "file_edit",
      path: "src/new-file.ts",
      tool_call_id: "edit-1",
    };
    const initialUpdates: SessionUpdate[] = [];
    const { rerender } = renderHook(
      ({ updates }: { updates: SessionUpdate[] }) => useTaskFileEditCacheSync("task-1", updates),
      { initialProps: { updates: initialUpdates }, wrapper },
    );

    expect(invalidate).not.toHaveBeenCalled();

    rerender({ updates: [fileEdit] });

    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(3));
    expect(invalidate).toHaveBeenNthCalledWith(1, { queryKey: ["diff", "task-1"] });
    expect(invalidate).toHaveBeenNthCalledWith(2, { queryKey: ["fileList", "task-1"] });
    expect(invalidate).toHaveBeenNthCalledWith(3, {
      queryKey: ["fileContents", "task-1"],
    });

    rerender({
      updates: [fileEdit, { kind: "agent_text", text: "Done" }],
    });

    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(3));
  });
});
