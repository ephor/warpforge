import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { daemon } from "@/daemon";
import { useUi } from "@/store/ui";

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
  // The query lives in the persisted UI store, so a filter picked by one test
  // is still there for the next one.
  useUi.setState({ backlogParamsByProject: {} });
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
  // No identity and no assignee on any row by default, which is the case where
  // the assignee filter has nothing to offer.
  vi.spyOn(daemon, "trackerStatus").mockResolvedValue({});
  vi.spyOn(daemon, "trackerProjectSources").mockResolvedValue({
    project: "warpforge",
    local: true,
    linear: true,
    github: true,
  });
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

  // Whoever is doing the work mostly wants their own rows, so the signed-in
  // GitHub login is offered before any assignee has even been seen in a row.
  it("filters by the signed-in user", async () => {
    vi.mocked(daemon.trackerStatus).mockResolvedValue({
      github: { connected: true, login: "ephor" },
    });
    renderBacklog();
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(PAGE_SIZE));
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.click(await screen.findByRole("combobox", { name: "Assignee" }));
    await user.click(await screen.findByRole("option", { name: /ephor/ }));

    await vi.waitFor(() =>
      expect(daemon.listBacklog).toHaveBeenCalledWith(
        expect.objectContaining({ assignee: "ephor" }),
      ),
    );
  });

  it("offers the assignees seen in the rows loaded so far", async () => {
    vi.mocked(daemon.listBacklog).mockImplementation(async (input) => ({
      items: allItems
        .slice(0, input.pageSize)
        .map((item, index) => ({ ...item, assignee: index % 2 === 0 ? "stas92" : null })),
      page: input.page,
      pageSize: input.pageSize,
      total: allItems.length,
      hasNextPage: false,
    }));
    renderBacklog();
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(PAGE_SIZE));
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.click(await screen.findByRole("combobox", { name: "Assignee" }));
    await user.click(await screen.findByRole("option", { name: "stas92" }));

    await vi.waitFor(() =>
      expect(daemon.listBacklog).toHaveBeenCalledWith(
        expect.objectContaining({ assignee: "stas92" }),
      ),
    );
  });

  // The options must not come from the filtered listing: picking one assignee
  // narrows the rows, which would then leave that assignee as the only option.
  it("keeps every seen assignee on offer after filtering by one", async () => {
    vi.mocked(daemon.listBacklog).mockImplementation(async (input) => {
      const assigned = allItems
        .slice(0, input.pageSize)
        .map((item, index) => ({ ...item, assignee: index % 2 === 0 ? "stas92" : "lapa2112" }));
      const items = input.assignee
        ? assigned.filter((item) => item.assignee === input.assignee)
        : assigned;
      return {
        items,
        page: input.page,
        pageSize: input.pageSize,
        total: items.length,
        hasNextPage: false,
      };
    });
    renderBacklog();
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(PAGE_SIZE));
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.click(await screen.findByRole("combobox", { name: "Assignee" }));
    await user.click(await screen.findByRole("option", { name: "stas92" }));
    await vi.waitFor(() =>
      expect(daemon.listBacklog).toHaveBeenCalledWith(
        expect.objectContaining({ assignee: "stas92" }),
      ),
    );

    await user.click(screen.getByRole("combobox", { name: "Assignee" }));
    expect(await screen.findByRole("option", { name: "lapa2112" })).toBeInTheDocument();
  });

  // Someone who reads their board as "assigned to me" said so once; leaving
  // and coming back must not put every other person's work in front of them.
  it("opens with the filter this project was left on", async () => {
    useUi.getState().patchBacklogParams("warpforge", { assignee: "lapa2112" });
    renderBacklog();

    await vi.waitFor(() =>
      expect(daemon.listBacklog).toHaveBeenCalledWith(
        expect.objectContaining({ assignee: "lapa2112" }),
      ),
    );
    // …and a different project is not dragged along with it.
    expect(useUi.getState().backlogParamsByProject.other).toBeUndefined();
  });

  // Nothing to choose from should not leave a dead control in the toolbar.
  it("hides the assignee filter when there is no identity and no assignee", async () => {
    renderBacklog();
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(PAGE_SIZE));

    expect(screen.queryByRole("combobox", { name: "Assignee" })).not.toBeInTheDocument();
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
