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

  // GitHub's upload widget pastes a raw <img> tag, which the markdown renderer
  // does not parse — the tag used to print verbatim in the description. The
  // bytes come from the daemon because this WebView has no GitHub session.
  it("shows a screenshot pasted into the description as HTML", async () => {
    const url = "https://github.com/user-attachments/assets/abc";
    vi.spyOn(daemon, "trackerAttachment").mockResolvedValue({
      contentType: "image/png",
      dataBase64: "AAAA",
    });

    renderDrawer({
      ...localItem,
      body: `Steps:\n<img width="800" alt="Broken chart" src="${url}" />`,
    });

    const image = await screen.findByRole("img", { name: "Broken chart" });
    expect(image).toHaveAttribute("src", "data:image/png;base64,AAAA");
    expect(daemon.trackerAttachment).toHaveBeenCalledWith(url);
    expect(screen.queryByText(/<img/)).not.toBeInTheDocument();
  });

  it("falls back to a link when the daemon cannot fetch the screenshot", async () => {
    const url = "https://github.com/user-attachments/assets/private";
    vi.spyOn(daemon, "trackerAttachment").mockRejectedValue(new Error("gh is logged out"));

    renderDrawer({ ...localItem, body: `<img alt="Broken chart" src="${url}" />` });

    expect(await screen.findByRole("link", { name: "Broken chart" })).toHaveAttribute("href", url);
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

  it("assigns a local item to you and unassigns it again", async () => {
    vi.spyOn(daemon, "trackerStatus").mockResolvedValue({
      github: { connected: true, login: "lapa2112" },
      linear: { connected: false },
    });
    renderDrawer(localItem);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.click(await screen.findByRole("combobox", { name: "Assignee" }));
    await user.click(await screen.findByRole("option", { name: "lapa2112" }));
    expect(daemon.updateBacklog).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "b-1", assignee: "lapa2112" }),
    );

    await user.click(screen.getByRole("combobox", { name: "Assignee" }));
    await user.click(await screen.findByRole("option", { name: "Unassigned" }));
    // An absent field means "leave alone", so unassigning has to say `""`.
    expect(daemon.updateBacklog).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemId: "b-1", assignee: "" }),
    );
  });

  it("leaves a tracker-owned assignee read-only", async () => {
    vi.spyOn(daemon, "trackerStatus").mockResolvedValue({
      github: { connected: true, login: "lapa2112" },
      linear: { connected: false },
    });
    renderDrawer({ ...localItem, source: "github", assignee: "someone-else" });

    expect(await screen.findByText("someone-else")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Assignee" })).not.toBeInTheDocument();
  });

  it("renames a local item from its heading", async () => {
    renderDrawer(localItem);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.click(screen.getByRole("button", { name: localItem.title }));
    const field = screen.getByRole("textbox", { name: "Title" });
    await user.clear(field);
    await user.type(field, "Rework the port allocator range{Enter}");

    await vi.waitFor(() =>
      expect(daemon.updateBacklog).toHaveBeenCalledWith(
        expect.objectContaining({ itemId: "b-1", title: "Rework the port allocator range" }),
      ),
    );
    expect(
      await screen.findByRole("button", { name: "Rework the port allocator range" }),
    ).toBeInTheDocument();
  });

  it("cancels a rename on Escape without closing the panel", async () => {
    const onClose = vi.fn<() => void>();
    renderDrawer(localItem, { onClose });
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.click(screen.getByRole("button", { name: localItem.title }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), " and more");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("textbox", { name: "Title" })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(daemon.updateBacklog).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: localItem.title })).toBeInTheDocument();
  });

  // A row with no title is one nobody can read in the list, so an emptied
  // field is treated as a slip rather than an instruction.
  it("keeps the old title when the field is emptied", async () => {
    renderDrawer(localItem);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.click(screen.getByRole("button", { name: localItem.title }));
    await user.clear(screen.getByRole("textbox", { name: "Title" }));
    await user.keyboard("{Enter}");

    expect(daemon.updateBacklog).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: localItem.title })).toBeInTheDocument();
  });

  it("leaves a tracker-owned title read-only", () => {
    renderDrawer({ ...localItem, source: "github" });

    expect(screen.queryByRole("button", { name: localItem.title })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: localItem.title })).toBeInTheDocument();
  });

  it("writes a description on a local item and shows what was saved", async () => {
    renderDrawer({ ...localItem, body: "" });
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.click(screen.getByRole("button", { name: "Add a description…" }));
    await user.type(screen.getByRole("textbox", { name: "Description" }), "It runs out at 40.");
    // Clicking away commits, the way a note-taking field is expected to.
    await user.tab();

    await vi.waitFor(() =>
      expect(daemon.updateBacklog).toHaveBeenCalledWith(
        expect.objectContaining({ itemId: "b-1", body: "It runs out at 40." }),
      ),
    );
    // The drawer holds a snapshot of the row, so the edit has to land here too
    // or the panel keeps showing the text it just replaced.
    expect(await screen.findByText("It runs out at 40.")).toBeInTheDocument();
  });

  // Escape is the editor's while one is open — Radix reads the key before the
  // textarea does, so without holding it the panel closes over the draft.
  it("cancels an edit on Escape without closing the panel", async () => {
    const onClose = vi.fn<() => void>();
    renderDrawer(localItem, { onClose });
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.click(screen.getByRole("button", { name: "Edit description" }));
    await user.type(screen.getByRole("textbox", { name: "Description" }), " and more");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("textbox", { name: "Description" })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(daemon.updateBacklog).not.toHaveBeenCalled();
    expect(screen.getByText(/runs out of range/)).toBeInTheDocument();

    // With no editor open, Escape is the panel's again.
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("leaves a tracker description read-only", () => {
    renderDrawer({ ...localItem, source: "github", body: "Reported upstream." });

    expect(screen.getByText("Reported upstream.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit description" })).not.toBeInTheDocument();
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

  it("summarises the task an item became", () => {
    renderDrawer(
      { ...localItem, taskId: "task-9" },
      {
        linkedTask: {
          agent: "codex",
          blockedReason: null,
          createdAt: 1,
          filesChanged: 3,
          id: "task-9",
          project: "warpforge",
          prompt: "Rework the port allocator",
          status: "running",
          tags: [],
          title: "Reworking the allocator",
          updatedAt: Math.floor(Date.now() / 1000),
        },
      },
    );

    expect(screen.getByText("Reworking the allocator")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("3 files")).toBeInTheDocument();
  });

  it("deletes a local item after a confirmation, and closes with it", async () => {
    const onClose = vi.fn<() => void>();
    const deleteBacklog = vi.spyOn(daemon, "deleteBacklog").mockResolvedValue();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderDrawer(localItem, { onClose });
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.click(screen.getByRole("button", { name: "Delete work item" }));

    await vi.waitFor(() => expect(deleteBacklog).toHaveBeenCalledWith("b-1", "warpforge"));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("keeps the item when the confirmation is declined", async () => {
    const deleteBacklog = vi.spyOn(daemon, "deleteBacklog").mockResolvedValue();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderDrawer(localItem);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.click(screen.getByRole("button", { name: "Delete work item" }));

    expect(deleteBacklog).not.toHaveBeenCalled();
  });

  // A tracker issue is not ours to delete: the row would be imported straight
  // back, while the issue stayed open where it actually lives.
  it("offers no delete on an item a tracker owns", () => {
    renderDrawer({ ...localItem, source: "github" });

    expect(screen.queryByRole("button", { name: "Delete work item" })).not.toBeInTheDocument();
  });

  it("closes from the close button", async () => {
    const onClose = vi.fn<() => void>();
    renderDrawer(localItem, { onClose });

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole("button", { name: "Close work item" }));

    expect(onClose).toHaveBeenCalled();
  });
});
