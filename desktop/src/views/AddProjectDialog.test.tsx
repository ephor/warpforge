import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { daemon } from "../daemon";
import AddProjectDialog from "./AddProjectDialog";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn<() => Promise<string | null>>() }));

function renderDialog(onAdded = vi.fn<(name: string) => void>()) {
  return render(
    <AddProjectDialog open onOpenChange={vi.fn<(v: boolean) => void>()} onAdded={onAdded} />,
  );
}

describe("AddProjectDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(daemon, "addProject").mockResolvedValue({ name: "my-app" });
    vi.spyOn(daemon, "setProjectPortRange").mockResolvedValue();
  });

  it("sends the range with the add request and makes no separate override call", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderDialog();

    await user.type(screen.getByLabelText("Folder path"), "/tmp/my-app");
    await user.type(screen.getByLabelText("Port range (optional)"), "4200-4299");
    await user.click(screen.getByRole("button", { name: "Add Project" }));

    expect(daemon.addProject).toHaveBeenCalledWith("/tmp/my-app", "my-app", "4200-4299");
    expect(daemon.setProjectPortRange).not.toHaveBeenCalled();
  });

  it("catches a malformed range client-side and never sends the add request", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderDialog();

    await user.type(screen.getByLabelText("Folder path"), "/tmp/my-app");
    await user.type(screen.getByLabelText("Port range (optional)"), "not-a-range");
    await user.click(screen.getByRole("button", { name: "Add Project" }));

    expect(screen.getByText("Use a range like 4200-4299, or a single port.")).toBeTruthy();
    expect(daemon.addProject).not.toHaveBeenCalled();
    expect(daemon.setProjectPortRange).not.toHaveBeenCalled();
  });
});
