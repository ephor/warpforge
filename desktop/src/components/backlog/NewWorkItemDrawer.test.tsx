import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { daemon } from "@/daemon";

import { NewWorkItemDrawer } from "./NewWorkItemDrawer";

function renderDrawer() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NewWorkItemDrawer open onOpenChange={vi.fn<(open: boolean) => void>()} project="warpforge" />
    </QueryClientProvider>,
  );
}

function typeTitle(text: string) {
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: text } });
}

/** Radix Select needs real pointer events, which only user-event synthesizes. */
async function selectLinear() {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await user.click(screen.getByLabelText("Source"));
  await user.click(await screen.findByRole("option", { name: /Linear/ }));
  await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(daemon, "trackerStatus").mockResolvedValue({
    github: { connected: false },
    linear: { connected: true, email: "me@example.com" },
  });
  vi.spyOn(daemon, "trackerProjectSources").mockResolvedValue({
    project: "warpforge",
    local: true,
    linear: true,
    github: false,
  });
  vi.spyOn(daemon, "createBacklog").mockResolvedValue({
    id: "b-1",
    number: 1,
    project: "warpforge",
    title: "Task",
    body: "",
    status: "todo",
    priority: "none",
    source: "local",
    createdAt: 1,
    updatedAt: 1,
  });
  vi.spyOn(daemon, "attachBacklogExternal").mockResolvedValue();
});

describe("NewWorkItemDrawer", () => {
  it("creates a local item through the daemon", async () => {
    const createExternal = vi.spyOn(daemon, "createExternalWorkItem");
    renderDrawer();
    typeTitle("Local only");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(daemon.createBacklog).toHaveBeenCalled();
    });
    expect(createExternal).not.toHaveBeenCalled();
  });

  it("puts a local item on you, and lets you take it back off", async () => {
    vi.spyOn(daemon, "trackerStatus").mockResolvedValue({
      github: { connected: true, login: "lapa2112" },
      linear: { connected: true, email: "me@example.com" },
    });
    renderDrawer();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    // The chip appears once the signed-in identity arrives.
    await screen.findByLabelText("Assignee");
    typeTitle("Mine to do");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(daemon.createBacklog).toHaveBeenCalledWith(
        expect.objectContaining({ assignee: "lapa2112", source: "local" }),
      );
    });

    await user.click(screen.getByLabelText("Assignee"));
    await user.click(await screen.findByRole("option", { name: "Unassigned" }));
    typeTitle("Nobody's yet");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(daemon.createBacklog).toHaveBeenLastCalledWith(
        expect.objectContaining({ assignee: null }),
      );
    });
  });

  it("offers no assignee on an item a tracker will own", async () => {
    vi.spyOn(daemon, "trackerStatus").mockResolvedValue({
      github: { connected: true, login: "lapa2112" },
      linear: { connected: true, email: "me@example.com" },
    });
    renderDrawer();
    await screen.findByLabelText("Assignee");

    await selectLinear();

    // Linear answers for its own issues; a value set here would not survive
    // the next sync, so the control is not offered at all.
    expect(screen.queryByLabelText("Assignee")).not.toBeInTheDocument();
  });

  it("rolls the local row back when the tracker create fails", async () => {
    const deleteBacklog = vi.spyOn(daemon, "deleteBacklog").mockResolvedValue();
    vi.spyOn(daemon, "createExternalWorkItem").mockRejectedValue(new Error("Linear said no"));
    renderDrawer();
    typeTitle("Mirror me");

    // Pick Linear as the target; only connected trackers are selectable.
    await selectLinear();

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(daemon.createExternalWorkItem).toHaveBeenCalled();
    });
    expect(daemon.createBacklog).toHaveBeenCalled();
    // Compensating cleanup (ADR-0002 invariant 5): the local row is dropped so
    // it cannot claim a tracker it never reached.
    expect(deleteBacklog).toHaveBeenCalledWith("b-1", "warpforge");
  });

  it("rolls the local row back when the attach step fails after a successful create", async () => {
    const deleteBacklog = vi.spyOn(daemon, "deleteBacklog").mockResolvedValue();
    vi.spyOn(daemon, "createExternalWorkItem").mockResolvedValue({
      externalId: "WF-9",
      itemId: "b-1",
      provider: "linear",
      status: "todo",
      url: "https://linear.app/wf/issue/WF-9",
    });
    vi.spyOn(daemon, "attachBacklogExternal").mockRejectedValue(new Error("attach failed"));
    renderDrawer();
    typeTitle("Mirror me");

    await selectLinear();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(daemon.attachBacklogExternal).toHaveBeenCalled();
    });
    expect(deleteBacklog).toHaveBeenCalledWith("b-1", "warpforge");
  });

  it("keeps the item and records the external id when the create succeeds", async () => {
    vi.spyOn(daemon, "createExternalWorkItem").mockResolvedValue({
      externalId: "WF-9",
      itemId: "ignored-by-the-store-lookup",
      provider: "linear",
      status: "todo",
      url: "https://linear.app/wf/issue/WF-9",
    });
    renderDrawer();
    typeTitle("Mirror me");

    await selectLinear();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(daemon.createExternalWorkItem).toHaveBeenCalledWith(
        expect.objectContaining({ project: "warpforge", provider: "linear", title: "Mirror me" }),
      );
    });
    expect(daemon.attachBacklogExternal).toHaveBeenCalledWith(
      expect.objectContaining({ project: "warpforge", provider: "linear" }),
    );
  });

  it("clears a draft when the project switches while the drawer is open", async () => {
    const daemonMock = vi.spyOn(daemon, "createBacklog");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onOpenChange = vi.fn<(open: boolean) => void>();
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <NewWorkItemDrawer open onOpenChange={onOpenChange} project="warpforge" />
      </QueryClientProvider>,
    );

    typeTitle("Draft typed for project A");
    expect(screen.getByLabelText("Title")).toHaveValue("Draft typed for project A");

    rerender(
      <QueryClientProvider client={client}>
        <NewWorkItemDrawer open onOpenChange={onOpenChange} project="other-project" />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue(""));
    expect(daemonMock).not.toHaveBeenCalled();
  });
});
