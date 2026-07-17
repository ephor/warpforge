import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ThinkingBlock } from "./ThinkingBlock";

describe("ThinkingBlock", () => {
  it("starts expanded while streaming and renders markdown", () => {
    render(<ThinkingBlock text="Planning **carefully**" streaming />);

    expect(screen.getByRole("button", { name: /thinking/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("carefully").tagName).toBe("STRONG");
  });

  it("auto-collapses once when streaming completes", async () => {
    const { rerender } = render(<ThinkingBlock text="A private plan" streaming />);

    rerender(<ThinkingBlock text="A private plan" streaming={false} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^thinking$/i })).toHaveAttribute(
        "aria-expanded",
        "false",
      ),
    );
    expect(screen.queryByText("A private plan")).not.toBeInTheDocument();
  });

  it("preserves manual post-completion toggles across rerenders", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ThinkingBlock text="Finished reasoning" streaming={false} />);
    const button = screen.getByRole("button", { name: /^thinking$/i });

    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Finished reasoning")).toBeInTheDocument();

    rerender(<ThinkingBlock text="Finished reasoning" streaming={false} />);
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  it("opens for a new stream and collapses again at its boundary", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ThinkingBlock text="Old reasoning" streaming={false} />);
    const button = screen.getByRole("button", { name: /^thinking$/i });
    await user.click(button);

    rerender(<ThinkingBlock text="New live reasoning" streaming />);
    await waitFor(() => expect(button).toHaveAttribute("aria-expanded", "true"));

    rerender(<ThinkingBlock text="New live reasoning" streaming={false} />);
    await waitFor(() => expect(button).toHaveAttribute("aria-expanded", "false"));
  });
});
