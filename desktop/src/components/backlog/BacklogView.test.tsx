import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { daemon } from "@/daemon";

import { BacklogView } from "./BacklogView";

const allItems = Array.from({ length: 60 }, (_, index) => ({
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

function renderBacklog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BacklogView project="warpforge" />
    </QueryClientProvider>,
  );
}

function rowTitles(): string[] {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).queryAllByText(/^Issue \d+$/)[0]?.textContent ?? "")
    .filter(Boolean);
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
  it("loads one server page", async () => {
    renderBacklog();
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(10));
  });

  it("reports server page count", async () => {
    renderBacklog();
    await vi.waitFor(() => expect(screen.getByText(/Page 1 of 6/)).toBeInTheDocument());
  });

  it("requests the next server page", async () => {
    renderBacklog();
    await vi.waitFor(() => expect(rowTitles()[0]).toBe("Issue 60"));
    fireEvent.click(screen.getByRole("button", { name: /go to next page/i }));
    await vi.waitFor(() => expect(rowTitles()[0]).toBe("Issue 50"));
  });

  it("pages back while the next page is still in flight", async () => {
    // The real daemon answers over a socket, so every click lands during a
    // pending fetch. A pager driven by the *response* disables itself here.
    let release: (() => void) | undefined;
    const listSpy = vi.spyOn(daemon, "listBacklog");
    const answer = listSpy.getMockImplementation()!;
    listSpy.mockImplementation(async (input) => {
      if (input.page > 0) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return answer(input);
    });

    renderBacklog();
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(10));

    fireEvent.click(screen.getByRole("button", { name: /go to next page/i }));
    await vi.waitFor(() => expect(screen.getByText(/Page 2 of 6/)).toBeInTheDocument());
    // Still fetching page 2, and "previous" must already be usable.
    const previous = screen.getByRole("button", { name: /go to previous page/i });
    expect(previous).toBeEnabled();

    fireEvent.click(previous);
    await vi.waitFor(() => expect(screen.getByText(/Page 1 of 6/)).toBeInTheDocument());
    release?.();
    await vi.waitFor(() => expect(rowTitles()[0]).toBe("Issue 60"));
    expect(rowTitles()).toHaveLength(10);
  });

  it("renders full rows again when paging back", async () => {
    renderBacklog();
    await vi.waitFor(() => expect(rowTitles()[0]).toBe("Issue 60"));
    fireEvent.click(screen.getByRole("button", { name: /go to next page/i }));
    await vi.waitFor(() => expect(screen.getByText(/Page 2 of 6/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /go to previous page/i }));
    await vi.waitFor(() => expect(screen.getByText(/Page 1 of 6/)).toBeInTheDocument());
    // The cached page must come back with its cells populated, not as empty rows.
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(10));
    expect(rowTitles()[0]).toBe("Issue 60");
    expect(screen.getAllByText("Unassigned")).toHaveLength(10);
  });

  it("keeps one column set across re-renders", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <BacklogView project="warpforge" onStartTask={() => {}} />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(10));
    const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent);

    // A parent that re-renders with fresh inline callbacks (Projects does this on
    // every daemon snapshot) must not rebuild the table's columns.
    rerender(
      <QueryClientProvider client={client}>
        <BacklogView project="warpforge" onStartTask={() => {}} />
      </QueryClientProvider>,
    );
    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(headers);
    expect(rowTitles()).toHaveLength(10);
  });

  it("requests server sorting from a header click", async () => {
    renderBacklog();
    await vi.waitFor(() => expect(rowTitles()[0]).toBe("Issue 60"));
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole("button", { name: "Title" }));
    await vi.waitFor(() => expect(rowTitles()[0]).toBe("Issue 01"));
    await user.click(screen.getByRole("button", { name: "Title" }));
    await vi.waitFor(() => expect(rowTitles()[0]).toBe("Issue 60"));
  });

  it("sends the status filter to the daemon and returns to page one", async () => {
    const listSpy = vi.spyOn(daemon, "listBacklog");
    renderBacklog();
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(10));
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    fireEvent.click(screen.getByRole("button", { name: /go to next page/i }));
    await vi.waitFor(() => expect(screen.getByText(/Page 2 of 6/)).toBeInTheDocument());

    await user.click(screen.getByRole("combobox", { name: "Status" }));
    await user.click(await screen.findByRole("option", { name: "Done" }));

    await vi.waitFor(() =>
      expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ status: "done", page: 0 })),
    );
  });

  it("sends the priority filter to the daemon", async () => {
    const listSpy = vi.spyOn(daemon, "listBacklog");
    renderBacklog();
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(10));
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
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(10));
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

  it("requests server page size", async () => {
    renderBacklog();
    await vi.waitFor(() => expect(screen.getByText(/Page 1 of 6/)).toBeInTheDocument());
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole("combobox", { name: /rows per page/i }));
    await user.click(await screen.findByRole("option", { name: "20" }));
    await vi.waitFor(() => expect(screen.getByText(/Page 1 of 3/)).toBeInTheDocument());
    expect(rowTitles()).toHaveLength(20);
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
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(10));
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
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(10));
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
    await vi.waitFor(() => expect(rowTitles()).toHaveLength(10));
    expect(warpforgeCalls()).toBe(1);
  });
});
