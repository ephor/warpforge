import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "./ConfirmDialog";

function renderDialog(props: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onCancel = vi.fn<() => void>();
  const onConfirm = vi.fn<() => Promise<void>>().mockResolvedValue();
  render(
    <ConfirmDialog
      open
      title="Delete this item?"
      description="This cannot be undone."
      confirmLabel="Delete item"
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...props}
    />,
  );
  return { onCancel, onConfirm };
}

describe("ConfirmDialog", () => {
  it("asks the question and answers both ways", async () => {
    const { onCancel, onConfirm } = renderDialog();
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    expect(screen.getByText("Delete this item?")).toBeInTheDocument();
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete item" }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it("keeps both answers available again after the work fails", async () => {
    const onConfirm = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("daemon is offline"));
    renderDialog({ onConfirm });
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.click(screen.getByRole("button", { name: "Delete item" }));

    // A destructive step that failed must not read as one that worked: the
    // question stays up rather than closing on the way out.
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled());
    expect(screen.getByText("Delete this item?")).toBeInTheDocument();
  });

  /**
   * A confirmation almost always opens over another dialog, and its content is
   * portaled out of that one's DOM — so answering it reads to the layer beneath
   * as a click outside, and that layer dismisses itself. In the drawer that
   * asked the question again on every Cancel, which made the dialog impossible
   * to dismiss without discarding.
   *
   * The fix is registering the content as a branch of Radix's layer stack.
   * jsdom does not reproduce the pointer sequence that triggers it (this test
   * passed with the bug in place), so the wrapper itself is what is asserted —
   * remove it and this fails, which is the point.
   */
  it("registers its content as a branch of the layer stack", () => {
    renderDialog();

    const branch = document.querySelector("[data-layer-branch]");
    expect(branch).not.toBeNull();
    expect(branch).toContainElement(screen.getByRole("button", { name: "Cancel" }));
  });
});
