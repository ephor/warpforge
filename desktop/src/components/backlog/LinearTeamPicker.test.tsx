import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { daemon } from "@/daemon";

import { LinearTeamPicker } from "./LinearTeamPicker";

const TEAMS = [
  { id: "team-eng", key: "ENG", name: "Engineering" },
  { id: "team-ops", key: "OPS", name: "Operations" },
];

function renderPicker() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LinearTeamPicker project="warpforge" />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(daemon, "trackerStatus").mockResolvedValue({
    linear: { connected: true, email: "a@b.c", organization: "Acme" },
    github: null,
  });
  vi.spyOn(daemon, "linearTeams").mockResolvedValue(TEAMS);
  vi.spyOn(daemon, "trackerProjectSettings").mockResolvedValue({
    project: "warpforge",
    linearTeamId: null,
    linearTeamName: null,
  });
});

describe("LinearTeamPicker", () => {
  it("stays hidden when Linear is not connected", async () => {
    vi.spyOn(daemon, "trackerStatus").mockResolvedValue({ linear: null, github: null });
    renderPicker();
    // Nothing to configure, so a GitHub-only project never sees the control.
    await vi.waitFor(() => expect(daemon.trackerStatus).toHaveBeenCalled());
    expect(screen.queryByRole("combobox", { name: "Linear team" })).not.toBeInTheDocument();
  });

  it("reads unmapped as 'No Linear team'", async () => {
    renderPicker();
    const trigger = await screen.findByRole("combobox", { name: "Linear team" });
    expect(trigger).toHaveTextContent("No Linear team");
  });

  it("maps the project to a team and refreshes the backlog", async () => {
    const set = vi.spyOn(daemon, "setProjectLinearTeam").mockResolvedValue({
      project: "warpforge",
      linearTeamId: "team-eng",
      linearTeamName: "Engineering",
    });
    const client = renderPicker();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(await screen.findByRole("combobox", { name: "Linear team" }));
    await user.click(await screen.findByRole("option", { name: /Engineering/ }));

    await vi.waitFor(() => expect(set).toHaveBeenCalledWith("warpforge", TEAMS[0]));
    // The mapping decides which rows exist, so the board must be refetched.
    await vi.waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["backlog", "warpforge"] }),
    );
  });

  it("unmaps the project, which drops the rows that team imported", async () => {
    vi.spyOn(daemon, "trackerProjectSettings").mockResolvedValue({
      project: "warpforge",
      linearTeamId: "team-eng",
      linearTeamName: "Engineering",
    });
    const set = vi.spyOn(daemon, "setProjectLinearTeam").mockResolvedValue({
      project: "warpforge",
      linearTeamId: null,
      linearTeamName: null,
    });
    renderPicker();

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const trigger = await screen.findByRole("combobox", { name: "Linear team" });
    await vi.waitFor(() => expect(trigger).toHaveTextContent("Engineering"));
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "No Linear team" }));

    await vi.waitFor(() => expect(set).toHaveBeenCalledWith("warpforge", null));
  });
});
