import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import type { PromptSubmission } from "../protocol";
import type { ComposerHandle } from "./Composer";
import { Composer } from "./Composer";

type OnSend = (submission: PromptSubmission) => Promise<void>;

const files = [
  { changed: false, path: "src/app.ts" },
  { changed: false, path: "docs/my file.md" },
];

describe("Composer", () => {
  it("opens the @ menu, navigates, inserts paths, and sends a structured file ref", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn<OnSend>();
    render(<Composer files={files} onSend={onSend} />);
    const input = screen.getByRole("textbox");
    await user.type(input, "review @a");
    expect(screen.getByText("src/app.ts")).toBeInTheDocument();
    await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");
    expect(input).toHaveValue("review @src/app.ts ");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith({
        attachments: [{ type: "file", path: "src/app.ts" }],
        text: "review @src/app.ts",
      }),
    );
  });

  it("does not conflict with slash completion and removes a deleted mention ref", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn<OnSend>();
    render(
      <Composer
        files={files}
        commands={[{ description: "Review", name: "review" }]}
        onSend={onSend}
      />,
    );
    const input = screen.getByRole("textbox");
    await user.type(input, "/rev");
    expect(screen.getByText("/review")).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "@src/app.ts");
    await user.clear(input);
    await user.type(input, "plain");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onSend).toHaveBeenCalledWith({ attachments: [], text: "plain" }));
  });

  it("keeps the draft after failure and clears it after success", async () => {
    const user = userEvent.setup();
    const onSend = vi
      .fn<OnSend>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    render(<Composer onSend={onSend} />);
    const input = screen.getByRole("textbox");
    await user.type(input, "hello{Enter}");
    await screen.findByText("offline");
    expect(input).toHaveValue("hello");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("handles image selection/removal, capability disabling, and keeps diff embedding", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn<OnSend>();
    const ref = createRef<ComposerHandle>();
    const { rerender } = render(<Composer ref={ref} onSend={onSend} imageSupported />);
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
    const png = new File(["png"], "shot.png", { type: "image/png" });
    Object.defineProperty(png, "arrayBuffer", {
      value: async () => new TextEncoder().encode("png").buffer,
    });
    await act(async () => {
      await user.upload(picker, png);
    });
    await expect(screen.findByText("shot.png")).resolves.toBeInTheDocument();
    await user.click(screen.getByLabelText("Remove shot.png"));
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    act(() =>
      ref.current?.attachDiff(
        {
          hunks: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ["-a", "+b"],
              resolution: null,
            },
          ],
          oldPath: null,
          path: "a.ts",
          status: "modified",
        },
        "-a\n+b",
      ),
    );
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(onSend.mock.calls[0][0].text).toContain("```diff"));
    rerender(<Composer onSend={onSend} imageSupported={false} />);
    expect(screen.getByTitle("This agent does not support images")).toBeDisabled();
  });

  it("accepts image drag-and-drop", async () => {
    render(<Composer onSend={vi.fn<OnSend>()} />);
    const png = new File(["png"], "drop.png", { type: "image/png" });
    Object.defineProperty(png, "arrayBuffer", {
      value: async () => new TextEncoder().encode("png").buffer,
    });
    fireEvent.drop(screen.getByRole("textbox").parentElement!.parentElement!, {
      dataTransfer: { files: [png] },
    });
    await expect(screen.findByText("drop.png")).resolves.toBeInTheDocument();
  });
});
