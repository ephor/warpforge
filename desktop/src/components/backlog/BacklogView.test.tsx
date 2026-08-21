import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { daemon } from "@/daemon";

import { BacklogView } from "./BacklogView";
import type { WorkItem } from "./types";

vi.mock("@legendapp/list/react", () => import("@/test/legendList"));

const PAGE_SIZE = 30;

const allItems = Array.from({ length: 70 }, (_, index) => ({
  id: `b-${index + 1}`,
  number: index + 1,
  project: "warpforge",
  title: `Issue ${String(index + 1).padStart(2, "0")}`,
  body: "",
  status: "todo",
  priority: "none",
  source: "github",
  externalId: `#${index + 1}`,
  url: `https://github.com/o/r/issues/${index + 1}`,
  remoteStatus: "open",
  assignee: null,
  createdAt: 1_000 + index,
  updatedAt: 1_000 + index,
  taskId: null,
}));

function renderBacklog(props: Partial<React.ComponentProps<typeof BacklogView>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BacklogView project="warpforge" {...props} />
    </QueryClientProvider>,
  );
}

function rowTitles(): string[] {
  return screen.queryAllByText(/^Issue \d+$/).map((node) => node.textContent ?? "");
}

async function loadMore() {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await user.click(screen.getByRole("button", { name: "scroll to end" }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(daemon, "listBacklog").mockImplementation(async (input) => {
    const sorted = [...allItems].sort((a, b) => {
      if (input.sortBy === "title") {
        return input.sortDesc ? b.title.localeCompare(a.title) : a.title.localeCompare(b.title);
      }
      return input.sortDesc ? b.updatedAt - a.updatedAt : a.updatedAt - b.updatedAt;
    });
    const start = input.page * input.pageSize;
    return {
      items: sorted.slice(start, start + input.pageSize),
      page: input.page,
      pageSize: input.pageSize,
      total: sorted.length,
      hasNextPage: start + input.pageSize < sorted.length,
    };
  });
  vi.spyOn(daemon, "importExternalWorkItems").mockResolvedValue({ items: [], synced: [] });
});

describe("BacklogView", () => {
  it("loads the first server page", async () => {
    renderBacklog();
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(PAGE_SIZE));
    expect(rowTitles()[0]).toBe("Issue 70");
  });

  it("appends the next page at the end of the list, without repeating rows", async () => {
    renderBacklog();
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(PAGE_SIZE));

    await loadMore();
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(PAGE_SIZE * 2));
    // Earlier rows stay put — the list grows downwards rather than swapping.
    expect(rowTitles()[0]).toBe("Issue 70");
    expect(rowTitles()[PAGE_SIZE]).toBe("Issue 40");
    expect(new Set(rowTitles()).size).toBe(rowTitles().length);
  });

  it("stops asking once every item has been listed", async () => {
    renderBacklog();
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(PAGE_SIZE));

    await loadMore();
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(PAGE_SIZE * 2));
    await loadMore();
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(allItems.length));

    const calls = vi.mocked(daemon.listBacklog).mock.calls.length;
    await loadMore();
    expect(vi.mocked(daemon.listBacklog).mock.calls).toHaveLength(calls);
    expect(screen.getByText("End of backlog")).toBeInTheDocument();
  });

  it("requests server sorting from the toolbar", async () => {
    renderBacklog();
    await vi.waitFor(() => expect(rowTitles()[0]).toBe("Issue 70"));
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.click(screen.getByRole("combobox", { name: "Sort by" }));
    await user.click(await screen.findByRole("option", { name: "Title" }));
    await vi.waitFor(() => expect(rowTitles()[0]).toBe("Issue 70"));

    await user.click(screen.getByRole("button", { name: "Sort ascending" }));
    await vi.waitFor(() => expect(rowTitles()[0]).toBe("Issue 01"));
  });

  it("restarts the listing from the top when a filter changes", async () => {
    const listSpy = vi.spyOn(daemon, "listBacklog");
    renderBacklog();
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(PAGE_SIZE));
    await loadMore();
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(PAGE_SIZE * 2));

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole("combobox", { name: "Status" }));
    await user.click(await screen.findByRole("option", { name: "Done" }));

    await vi.waitFor(() =>
      expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ status: "done", page: 0 })),
    );
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(PAGE_SIZE));
  });

  it("sends the priority filter to the daemon", async () => {
    const listSpy = vi.spyOn(daemon, "listBacklog");
    renderBacklog();
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(PAGE_SIZE));
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.click(screen.getByRole("combobox", { name: "Priority" }));
    await user.click(await screen.findByRole("option", { name: "Urgent" }));

    await vi.waitFor(() =>
      expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ priority: "urgent" })),
    );
  });

  it("clears every filter with Reset", async () => {
    const listSpy = vi.spyOn(daemon, "listBacklog");
    renderBacklog();
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(PAGE_SIZE));
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.click(screen.getByRole("combobox", { name: "Source" }));
    await user.click(await screen.findByRole("option", { name: "GitHub" }));
    await vi.waitFor(() =>
      expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ source: "github" })),
    );

    await user.click(screen.getByRole("button", { name: /reset/i }));
    await vi.waitFor(() =>
      expect(screen.queryByRole("button", { name: /reset/i })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("combobox", { name: "Source" })).toHaveTextContent("All source");
  });

  it("opens an item's details from its row", async () => {
    const onOpenItem = vi.fn<(item: WorkItem) => void>();
    renderBacklog({ onOpenItem });
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(PAGE_SIZE));

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByText("Issue 70"));

    expect(onOpenItem).toHaveBeenCalledWith(expect.objectContaining({ title: "Issue 70" }));
  });

  it("runs import before the first backlog page", async () => {
    const order: string[] = [];
    vi.spyOn(daemon, "importExternalWorkItems").mockImplementation(async () => {
      order.push("sync");
      return { items: [], synced: [] };
    });
    vi.spyOn(daemon, "listBacklog").mockImplementation(async (input) => {
      order.push("list");
      return {
        items: allItems.slice(input.page * input.pageSize, (input.page + 1) * input.pageSize),
        page: input.page,
        pageSize: input.pageSize,
        total: allItems.length,
        hasNextPage: true,
      };
    });

    renderBacklog();
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(PAGE_SIZE));
    expect(order.slice(0, 2)).toEqual(["sync", "list"]);
  });

  it("does not re-import a project revisited within the staleness window", async () => {
    const importSpy = vi
      .spyOn(daemon, "importExternalWorkItems")
      .mockResolvedValue({ items: [], synced: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <BacklogView project="warpforge" />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(PAGE_SIZE));
    expect(importSpy).toHaveBeenCalledWith("warpforge");
    const warpforgeCalls = () => importSpy.mock.calls.filter(([p]) => p === "warpforge").length;
    expect(warpforgeCalls()).toBe(1);

    // Switch to another project: fresh key ⇒ fresh import.
    rerender(
      <QueryClientProvider client={client}>
        <BacklogView project="other-project" />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(importSpy).toHaveBeenCalledWith("other-project"));

    // Revisit within the window: cached pull is reused, no duplicate import.
    rerender(
      <QueryClientProvider client={client}>
        <BacklogView project="warpforge" />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(PAGE_SIZE));
    expect(warpforgeCalls()).toBe(1);
  });
});
