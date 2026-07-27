vi.mock("@/components/ui/dropdown-menu", async () => {
  const React = await import("react");
  function DropdownMenu({ children }: { children: React.ReactNode }) {
    return React.createElement("div", { "data-dropdown-root": true }, children);
  }
  function DropdownMenuTrigger({
    asChild,
    children,
  }: {
    asChild?: boolean;
    children: React.ReactElement;
  }) {
    if (asChild) return children;
    return React.createElement("div", null, children);
  }
  function DropdownMenuContent({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
    return React.createElement("div", { ...props, "data-dropdown-content": true }, children);
  }
  function DropdownMenuItem({
    children,
    onSelect,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & { onSelect?: () => void }) {
    return React.createElement(
      "div",
      {
        ...props,
        role: "menuitem",
        onClick: () => onSelect?.(),
      },
      children,
    );
  }
  function DropdownMenuPortal({ children }: { children: React.ReactNode }) {
    return children;
  }
  return {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuPortal,
  };
});

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: {
    count: number;
    estimateSize: (index: number) => number;
    getItemKey: (index: number) => string | number;
    overscan?: number;
  }) => {
    const items = Array.from({ length: opts.count }, (_, i) => ({
      index: i,
      key: opts.getItemKey(i),
      start: i * opts.estimateSize(i),
      size: opts.estimateSize(i),
      end: (i + 1) * opts.estimateSize(i),
    }));
    let totalSize = 0;
    for (let i = 0; i < opts.count; i++) totalSize += opts.estimateSize(i);
    return {
      getVirtualItems: () => items,
      getTotalSize: () => totalSize,
      measureElement: vi.fn<(el: Element) => void>(),
      scrollToIndex: vi.fn<(index: number) => void>(),
    };
  },
}));

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { daemon } from "../daemon";
import type { DaemonState } from "../daemon";
import type { TaskInfo } from "../protocol";
import { useUi } from "../store/ui";
import AttentionRail from "./AttentionRail";

function task(id: string, overrides: Partial<TaskInfo> = {}): TaskInfo {
  return {
    agent: "codex",
    blockedReason: null,
    createdAt: 1,
    filesChanged: 0,
    id,
    parentTaskId: null,
    project: "warpforge",
    prompt: id,
    status: "idle",
    tags: [],
    title: "",
    updatedAt: 1,
    ...overrides,
  };
}

function makeState(tasks: TaskInfo[]): DaemonState {
  return {
    connection: "connected",
    connectionError: null,
    pendingAgentSetup: null,
    portforwardLogs: {},
    serviceLogs: {},
    sessionUpdates: {},
    snapshot: {
      portforwards: [],
      projects: [],
      services: [],
      tasks,
      terminals: [],
    },
  };
}

const mockRequest = vi.fn<(method: string, params?: unknown) => Promise<unknown>>();
const noop = vi.fn<(id: string) => void>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 6, 15, 10, 0, 0));
  vi.spyOn(daemon, "request").mockImplementation(mockRequest);
  useUi.setState({
    attentionTargetId: null,
    attentionTargetNonce: 0,
    pinnedTaskIds: [],
  });
  mockRequest.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function getShelfElement(label: string) {
  const all = [...screen.getAllByRole("button"), ...screen.getAllByRole("heading")];
  const match = all.find(
    (el) =>
      el.hasAttribute("data-shelf") &&
      el.textContent?.toLowerCase().startsWith(label.toLowerCase()),
  );
  if (!match) throw new Error(`Shelf element "${label}" not found`);
  return match;
}

function getShelfButton(label: string) {
  const all = screen.getAllByRole("button");
  const match = all.find(
    (el) =>
      el.hasAttribute("data-shelf") &&
      el.textContent?.toLowerCase().startsWith(label.toLowerCase()),
  );
  if (!match) throw new Error(`Shelf button "${label}" not found`);
  return match;
}

describe("AttentionRail shelf layout", () => {
  it("renders Needs you and Working as static headings; Later and Handled as toggleable buttons", () => {
    const now = Math.floor(Date.now() / 1000);
    const tasks = [
      task("needs-review", { status: "needs_review" }),
      task("running-task", { status: "running" }),
      task("snoozed-task", { snoozedAt: now - 100, snoozedUntil: now + 3600 }),
      task("settled-task", { settledAt: now - 100, settledOverride: true }),
    ];
    render(<AttentionRail state={makeState(tasks)} onOpenTask={noop} />);

    const needsYouEl = getShelfElement("Needs you");
    expect(needsYouEl.tagName).toBe("H3");

    const workingEl = getShelfElement("Working");
    expect(workingEl.tagName).toBe("H3");
    expect(
      workingEl.compareDocumentPosition(needsYouEl) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(getShelfButton("Later")).toHaveAttribute("aria-expanded", "false");
    expect(getShelfButton("Handled")).toHaveAttribute("aria-expanded", "false");
  });

  it("collapses a lead task and its subagents into one expandable stack", () => {
    const tasks = [
      task("lead", { prompt: "Coordinate the release", status: "running" }),
      task("worker-1", {
        parentTaskId: "lead",
        prompt: "Update the daemon",
        status: "running",
      }),
      task("worker-2", {
        parentTaskId: "lead",
        prompt: "Update the board",
        status: "idle",
      }),
    ];

    render(<AttentionRail state={makeState(tasks)} onOpenTask={noop} />);

    expect(screen.getByText("Coordinate the release")).toBeInTheDocument();
    expect(screen.queryByText("Update the daemon")).not.toBeInTheDocument();
    expect(screen.queryByText("Update the board")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Agents 2/i }));

    expect(screen.getByText("Update the daemon")).toBeInTheDocument();
    expect(screen.getByText("Update the board")).toBeInTheDocument();
  });

  it("keeps the group in Working when any member is working", () => {
    const tasks = [
      task("lead", { prompt: "Lead needs review", status: "needs_review" }),
      task("worker", {
        parentTaskId: "lead",
        prompt: "Current worker",
        status: "running",
      }),
    ];

    render(<AttentionRail state={makeState(tasks)} onOpenTask={noop} />);

    const workingHeading = getShelfElement("Working");
    const workingTitle = screen.getByText("Current worker");
    const needsYouHeading = getShelfElement("Needs you");
    expect(
      workingHeading.compareDocumentPosition(workingTitle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      workingTitle.compareDocumentPosition(needsYouHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const needsYouFilter = screen
      .getAllByRole("button")
      .find(
        (element) => !element.hasAttribute("data-shelf") && element.textContent === "Needs you",
      );
    if (!needsYouFilter) throw new Error("Needs you filter not found");
    fireEvent.click(needsYouFilter);

    expect(screen.getByText("Lead needs review")).toBeInTheDocument();
  });

  it("does not render latest activity previews for expanded subagents", () => {
    const tasks = [
      task("lead", { prompt: "Lead task", status: "running" }),
      task("worker", {
        parentTaskId: "lead",
        prompt: "Worker task",
        status: "running",
      }),
    ];
    const state = makeState(tasks);
    state.sessionUpdates = {
      lead: [{ kind: "agent_text", text: "Lead is coordinating" }],
      worker: [{ kind: "agent_text", text: "Noisy worker transcript" }],
    };

    render(<AttentionRail state={state} onOpenTask={noop} />);

    expect(screen.getByText("Latest activity")).toBeInTheDocument();
    expect(screen.getByText("Lead is coordinating")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Agents 1/i }));

    expect(screen.getByText("Worker task")).toBeInTheDocument();
    expect(screen.queryByText("Noisy worker transcript")).not.toBeInTheDocument();
  });

  it("shows counts on shelf headers", () => {
    const now = Math.floor(Date.now() / 1000);
    const tasks = [
      task("review-1", { status: "needs_review" }),
      task("review-2", { status: "needs_review" }),
      task("run-1", { status: "running" }),
      task("snooze-1", { snoozedAt: now - 100, snoozedUntil: now + 3600 }),
    ];
    render(<AttentionRail state={makeState(tasks)} onOpenTask={noop} />);

    expect(within(getShelfElement("Needs you")).getByText("2")).toBeInTheDocument();
    expect(within(getShelfElement("Working")).getByText("1")).toBeInTheDocument();
    expect(within(getShelfButton("Later")).getByText("1")).toBeInTheDocument();
  });

  it("expands Snoozed shelf when clicked", () => {
    const now = Math.floor(Date.now() / 1000);
    const tasks = [
      task("snoozed-1", {
        prompt: "Snoozed task",
        snoozedAt: now - 100,
        snoozedUntil: now + 3600,
      }),
    ];
    render(<AttentionRail state={makeState(tasks)} onOpenTask={noop} />);

    const snoozedBtn = getShelfButton("Later");
    expect(snoozedBtn).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(snoozedBtn);
    expect(snoozedBtn).toHaveAttribute("aria-expanded", "true");

    expect(screen.getByText("Snoozed task")).toBeInTheDocument();
  });

  it("hides empty shelves when filter restricts them", () => {
    const tasks = [task("review-1", { status: "needs_review" })];
    render(<AttentionRail state={makeState(tasks)} onOpenTask={noop} />);

    const filterBtn = screen
      .getAllByRole("button")
      .find((el) => !el.hasAttribute("data-shelf") && el.textContent === "Needs you");
    if (!filterBtn) throw new Error("Filter button not found");
    fireEvent.click(filterBtn);

    expect(getShelfElement("Needs you")).toBeInTheDocument();
    const workingShelf = screen
      .getAllByRole("heading")
      .find((el) => el.hasAttribute("data-shelf") && el.getAttribute("data-shelf") === "working");
    expect(workingShelf).toBeUndefined();
  });
});

describe("AttentionRail lifecycle actions", () => {
  it("calls task.unsnooze on Wake now click", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockRequest.mockResolvedValueOnce(undefined);
    const tasks = [
      task("snoozed-1", {
        prompt: "Wake me",
        snoozedAt: now - 100,
        snoozedUntil: now + 3600,
      }),
    ];
    render(<AttentionRail state={makeState(tasks)} onOpenTask={noop} />);

    fireEvent.click(getShelfButton("Later"));
    const wakeBtn = screen.getByRole("button", { name: /show now/i });
    fireEvent.click(wakeBtn);

    await vi.waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith("task.unsnooze", { task_id: "snoozed-1" }),
    );
  });

  it("opens Remind later menu and calls task.snooze with exact preset until", async () => {
    mockRequest.mockResolvedValueOnce(undefined);
    const tasks = [task("working-1", { prompt: "Snooze me", status: "idle" })];
    render(<AttentionRail state={makeState(tasks)} onOpenTask={noop} />);

    const oneHourItem = screen.getByText("1 hour");
    fireEvent.click(oneHourItem);

    const expectedUntil = Math.floor(
      (new Date(2026, 6, 15, 10, 0, 0).getTime() + 60 * 60 * 1000) / 1000,
    );

    await vi.waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith("task.snooze", {
        task_id: "working-1",
        until: expectedUntil,
      });
    });
  });

  it("hides Settle for running tasks", () => {
    const tasks = [task("running-1", { prompt: "Running", status: "running" })];
    render(<AttentionRail state={makeState(tasks)} onOpenTask={noop} />);

    expect(screen.queryByRole("button", { name: /^mark handled$/i })).not.toBeInTheDocument();
  });

  it("hides Snooze and Settle when task has pending permission", () => {
    const tasks = [task("perm-task", { prompt: "Permission needed", status: "idle" })];
    const state = makeState(tasks);
    state.sessionUpdates = {
      "perm-task": [
        {
          kind: "permission_request",
          options: ["allow", "deny"],
          request_id: "perm-1",
          title: "Write file?",
        },
      ],
    };
    render(<AttentionRail state={state} onOpenTask={noop} />);

    expect(screen.queryByRole("button", { name: /^mark handled$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^remind later$/i })).not.toBeInTheDocument();
  });

  it("calls task.settle on Settle click for non-running idle task", async () => {
    mockRequest.mockResolvedValueOnce(undefined);
    const tasks = [task("idle-1", { prompt: "Settle me", status: "idle" })];
    render(<AttentionRail state={makeState(tasks)} onOpenTask={noop} />);

    const settleBtn = screen.getByRole("button", { name: /^mark handled$/i });
    fireEvent.click(settleBtn);

    await vi.waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith("task.settle", { task_id: "idle-1" }),
    );
  });

  it("calls task.unsettle on Unsettle click for settled task", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockRequest.mockResolvedValueOnce(undefined);
    const tasks = [
      task("settled-1", {
        prompt: "Unsettle me",
        settledAt: now - 100,
        settledOverride: true,
      }),
    ];
    render(<AttentionRail state={makeState(tasks)} onOpenTask={noop} />);

    fireEvent.click(getShelfButton("Handled"));
    const unsettleBtn = screen.getByRole("button", { name: /^return to active$/i });
    fireEvent.click(unsettleBtn);

    await vi.waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith("task.unsettle", { task_id: "settled-1" }),
    );
  });

  it("does not offer snooze/settle for snoozed tasks (only wake now)", () => {
    const now = Math.floor(Date.now() / 1000);
    const tasks = [
      task("snoozed-1", {
        prompt: "Snoozed",
        snoozedAt: now - 100,
        snoozedUntil: now + 3600,
      }),
    ];
    render(<AttentionRail state={makeState(tasks)} onOpenTask={noop} />);
    fireEvent.click(getShelfButton("Later"));

    expect(screen.getByRole("button", { name: /show now/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^remind later$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^mark handled$/i })).not.toBeInTheDocument();
  });

  it("does not offer snooze/settle for settled tasks (only unsettle)", () => {
    const now = Math.floor(Date.now() / 1000);
    const tasks = [
      task("settled-1", {
        prompt: "Settled",
        settledAt: now - 100,
        settledOverride: true,
      }),
    ];
    render(<AttentionRail state={makeState(tasks)} onOpenTask={noop} />);
    fireEvent.click(getShelfButton("Handled"));

    expect(screen.getByRole("button", { name: /^return to active$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^remind later$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^mark handled$/i })).not.toBeInTheDocument();
  });

  it("releases pending state and shows toast on RPC rejection", async () => {
    vi.useRealTimers();
    const rpcError = new Error("daemon rejected settle");
    mockRequest.mockRejectedValueOnce(rpcError);
    const tasks = [task("idle-1", { prompt: "Settle me", status: "idle" })];
    render(<AttentionRail state={makeState(tasks)} onOpenTask={noop} />);

    const settleBtn = screen.getByRole("button", { name: /^mark handled$/i });
    fireEvent.click(settleBtn);

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith("task.settle", { task_id: "idle-1" });
    });

    await waitFor(() => {
      expect(settleBtn).not.toBeDisabled();
    });
    vi.useFakeTimers();
  });
});

describe("AttentionRail row keys stability", () => {
  it("uses stable shelf: and task: keys in rendered output", () => {
    const now = Math.floor(Date.now() / 1000);
    const tasks = [
      task("t1", { status: "needs_review" }),
      task("t2", { status: "running" }),
      task("t3", { snoozedAt: now - 100, snoozedUntil: now + 3600 }),
    ];
    render(<AttentionRail state={makeState(tasks)} onOpenTask={noop} />);

    const shelfEls = [...screen.getAllByRole("button"), ...screen.getAllByRole("heading")].filter(
      (el) => el.hasAttribute("data-shelf"),
    );
    const shelfKeys = shelfEls.map((el) => el.getAttribute("data-shelf"));
    expect(shelfKeys).toContain("needs-you");
    expect(shelfKeys).toContain("working");
    expect(shelfKeys).toContain("snoozed");
    expect(shelfKeys).toContain("settled");

    const openBtns = screen.getAllByRole("button").filter((el) => el.hasAttribute("data-task-id"));
    const taskIds = openBtns.map((el) => el.getAttribute("data-task-id"));
    expect(taskIds).toContain("t1");
    expect(taskIds).toContain("t2");
  });
});

describe("AttentionRail wake boundary timer", () => {
  it("reschedules partition at the earliest snoozedUntil boundary", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tasks = [
      task("soon", {
        prompt: "Waking soon",
        snoozedAt: now - 100,
        snoozedUntil: now + 60,
      }),
      task("later", {
        prompt: "Waking later",
        snoozedAt: now - 100,
        snoozedUntil: now + 3600,
      }),
    ];
    render(<AttentionRail state={makeState(tasks)} onOpenTask={noop} />);

    const snoozedBtn = getShelfButton("Later");
    expect(within(snoozedBtn).getByText("2")).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(61_000);

    await vi.waitFor(() => {
      expect(within(getShelfButton("Later")).getByText("1")).toBeInTheDocument();
    });
  });

  it("caps far-future timer to browser-safe max without premature wake", async () => {
    const now = Math.floor(Date.now() / 1000);
    const farFuture = now + 30 * 24 * 60 * 60;
    const tasks = [
      task("far", {
        prompt: "Far future",
        snoozedAt: now - 100,
        snoozedUntil: farFuture,
      }),
    ];
    render(<AttentionRail state={makeState(tasks)} onOpenTask={noop} />);

    const snoozedBtn = getShelfButton("Later");
    expect(within(snoozedBtn).getByText("1")).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(2_147_483_647);

    expect(within(getShelfButton("Later")).getByText("1")).toBeInTheDocument();
    expect(screen.queryByText("Far future")).not.toBeInTheDocument();
  });
});

describe("AttentionRail settled paging", () => {
  function settledTasks(count: number) {
    const now = Math.floor(Date.now() / 1000);
    return Array.from({ length: count }, (_, i) =>
      task(`settled-${String(i).padStart(3, "0")}`, {
        prompt: `Settled task ${i}`,
        settledOverride: true,
        settledAt: now - (count - i),
        createdAt: i + 1,
      }),
    );
  }

  it("defaults collapsed; expand shows exactly 20 of 21 with Load more button", () => {
    const tasks = settledTasks(21);
    render(<AttentionRail state={makeState(tasks)} onOpenTask={noop} />);

    const settledBtn = getShelfButton("Handled");
    expect(settledBtn).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(settledBtn);
    expect(settledBtn).toHaveAttribute("aria-expanded", "true");

    const taskRows = screen.getAllByRole("button").filter((el) => el.hasAttribute("data-task-id"));
    expect(taskRows).toHaveLength(20);

    const loadMore = screen.getByRole("button", { name: /load more/i });
    expect(loadMore).toBeInTheDocument();
    expect(loadMore).toHaveAttribute("data-settled-load-more");
  });

  it("Load more reveals next page of settled tasks", () => {
    const tasks = settledTasks(21);
    render(<AttentionRail state={makeState(tasks)} onOpenTask={noop} />);

    fireEvent.click(getShelfButton("Handled"));
    expect(screen.queryByText("Settled task 20")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /load more/i }));

    const taskRows = screen.getAllByRole("button").filter((el) => el.hasAttribute("data-task-id"));
    expect(taskRows).toHaveLength(21);
    expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
  });

  it("targeted settled item beyond page forces expansion and inclusion", () => {
    const tasks = settledTasks(25);
    const targetId = "settled-024";
    useUi.setState({ attentionTargetId: targetId, attentionTargetNonce: 1 });

    render(<AttentionRail state={makeState(tasks)} onOpenTask={noop} />);

    const settledBtn = getShelfButton("Handled");
    expect(settledBtn).toHaveAttribute("aria-expanded", "true");

    const targetRow = screen
      .getAllByRole("button")
      .find((el) => el.getAttribute("data-task-id") === targetId);
    expect(targetRow).toBeInTheDocument();
  });

  it("targeted snoozed item expands only Snoozed shelf", () => {
    const now = Math.floor(Date.now() / 1000);
    const tasks = [
      task("snoozed-target", {
        prompt: "Find me",
        snoozedAt: now - 100,
        snoozedUntil: now + 3600,
      }),
      task("settled-1", { settledOverride: true, settledAt: now - 100 }),
    ];
    useUi.setState({ attentionTargetId: "snoozed-target", attentionTargetNonce: 1 });

    render(<AttentionRail state={makeState(tasks)} onOpenTask={noop} />);

    expect(getShelfButton("Later")).toHaveAttribute("aria-expanded", "true");
    expect(getShelfButton("Handled")).toHaveAttribute("aria-expanded", "false");
  });
});

describe("AttentionRail woke behavior", () => {
  function wokeTask(id = "woke-1") {
    const now = Math.floor(Date.now() / 1000);
    return task(id, {
      prompt: "Expired snooze",
      snoozedAt: now - 200,
      snoozedUntil: now - 100,
    });
  }

  it("expired snooze shows Woke badge and is foregrounded", () => {
    render(<AttentionRail state={makeState([wokeTask()])} onOpenTask={noop} />);

    const badge = screen.getByTestId("woke-badge");
    expect(badge).toBeInTheDocument();

    const card = screen
      .getAllByRole("button")
      .find((el) => el.getAttribute("data-task-id") === "woke-1");
    expect(card?.closest("[class*='opacity-50']")).not.toBeInTheDocument();
  });

  it("Woke badge does not clear on remount", () => {
    const { unmount } = render(<AttentionRail state={makeState([wokeTask()])} onOpenTask={noop} />);
    expect(screen.getByTestId("woke-badge")).toBeInTheDocument();

    unmount();
    render(<AttentionRail state={makeState([wokeTask()])} onOpenTask={noop} />);
    expect(screen.getByTestId("woke-badge")).toBeInTheDocument();
  });

  it("Woke badge does not clear on attention-target focus alone", () => {
    render(<AttentionRail state={makeState([wokeTask()])} onOpenTask={noop} />);
    expect(screen.getByTestId("woke-badge")).toBeInTheDocument();

    useUi.setState({ attentionTargetId: "woke-1", attentionTargetNonce: 1 });
    expect(screen.getByTestId("woke-badge")).toBeInTheDocument();

    useUi.setState({ attentionTargetId: "woke-1", attentionTargetNonce: 2 });
    expect(screen.getByTestId("woke-badge")).toBeInTheDocument();
  });

  it("clicking card open clears Woke badge", () => {
    render(<AttentionRail state={makeState([wokeTask()])} onOpenTask={noop} />);
    expect(screen.getByTestId("woke-badge")).toBeInTheDocument();

    const card = screen
      .getAllByRole("button")
      .find((el) => el.getAttribute("data-task-id") === "woke-1");
    fireEvent.click(card!);

    expect(screen.queryByTestId("woke-badge")).not.toBeInTheDocument();
  });

  it("thrown onOpenTask preserves/restores Woke badge", () => {
    const throwing = vi.fn<(id: string) => void>().mockImplementation(() => {
      throw new Error("fail");
    });
    render(<AttentionRail state={makeState([wokeTask()])} onOpenTask={throwing} />);
    expect(screen.getByTestId("woke-badge")).toBeInTheDocument();

    const card = screen
      .getAllByRole("button")
      .find((el) => el.getAttribute("data-task-id") === "woke-1");
    fireEvent.click(card!);

    expect(screen.getByTestId("woke-badge")).toBeInTheDocument();
  });
});

describe("AttentionRail B2 stable keys", () => {
  it("uses stable shelf:task: and settled:load-more keys in virtualizer", () => {
    const now = Math.floor(Date.now() / 1000);
    const settled = Array.from({ length: 21 }, (_, i) =>
      task(`s-${i}`, { settledOverride: true, settledAt: now - (21 - i), createdAt: i + 1 }),
    );
    const tasks = [
      task("review-1", { status: "needs_review" }),
      task("run-1", { status: "running" }),
      ...settled,
    ];
    render(<AttentionRail state={makeState(tasks)} onOpenTask={noop} />);

    fireEvent.click(getShelfButton("Handled"));

    const loadMore = screen.getByRole("button", { name: /load more/i });
    expect(loadMore).toHaveAttribute("data-settled-load-more");

    const taskRows = screen.getAllByRole("button").filter((el) => el.hasAttribute("data-task-id"));
    expect(taskRows).toHaveLength(22);
  });
});
