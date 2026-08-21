import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { daemon } from "@/daemon";

import type { WorkItem } from "./types";
import { WorkItemDrawer } from "./WorkItemDrawer";

const localItem: WorkItem = {
  id: "b-1",
  number: "#1",
  title: "Rework the port allocator",
  source: "local",
  project: "warpforge",
  status: "todo",
  priority: "none",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_500_000,
  body: "It runs out of range at 40 projects.",
  url: null,
  remoteStatus: null,
  taskId: null,
  assignee: null,
};

function renderDrawer(
  item: WorkItem,
  props: Partial<React.ComponentProps<typeof WorkItemDrawer>> = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WorkItemDrawer item={item} onClose={vi.fn<() => void>()} {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(daemon, "updateBacklog").mockResolvedValue({
    id: "b-1",
    number: 1,
    project: "warpforge",
    title: localItem.title,
    body: "",
    status: "in_progress",
    priority: "none",
    source: "local",
    createdAt: 1,
    updatedAt: 2,
  });
});

describe("WorkItemDrawer", () => {
  it("shows the item's details and its description", () => {
    renderDrawer(localItem);

    expect(screen.getByText("Rework the port allocator")).toBeInTheDocument();
    expect(screen.getByText(/runs out of range/)).toBeInTheDocument();
    expect(screen.getByText("Unassigned")).toBeInTheDocument();
  });

  it("saves a status change on a local item", async () => {
    renderDrawer(localItem);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.click(screen.getByRole("combobox", { name: "Status" }));
    await user.click(await screen.findByRole("option", { name: "In progress" }));

    expect(daemon.updateBacklog).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "b-1", project: "warpforge", status: "in_progress" }),
    );
  });

  it("leaves a tracker-owned status read-only", () => {
    renderDrawer({
      ...localItem,
      source: "github",
      remoteStatus: "open",
      url: "https://github.com/o/r/issues/1",
    });

    expect(screen.queryByRole("combobox", { name: "Status" })).not.toBeInTheDocument();
    expect(screen.getByText("open")).toBeInTheDocument();
    // Priority is ours either way — no tracker syncs it back over us.
    expect(screen.getByRole("combobox", { name: "Priority" })).toBeInTheDocument();
  });

  it("starts a task from an item that has none, and opens the one it has", async () => {
    const onStartTask = vi.fn<(item: WorkItem) => void>();
    const { unmount } = renderDrawer(localItem, { onStartTask });
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.click(screen.getByRole("button", { name: /start task/i }));
    expect(onStartTask).toHaveBeenCalledWith(expect.objectContaining({ id: "b-1" }));
    unmount();

    const onOpenTask = vi.fn<(taskId: string) => void>();
    renderDrawer({ ...localItem, taskId: "task-9" }, { onOpenTask });
    await user.click(screen.getByRole("button", { name: "Open task" }));
    expect(onOpenTask).toHaveBeenCalledWith("task-9");
  });

  it("closes from the close button", async () => {
    const onClose = vi.fn<() => void>();
    renderDrawer(localItem, { onClose });

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole("button", { name: "Close work item" }));

    expect(onClose).toHaveBeenCalled();
  });
});
