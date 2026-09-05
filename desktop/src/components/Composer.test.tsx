import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { FILE_REF_MIME } from "../lib/composerMentions";
import type { PromptSubmission } from "../protocol";
import type { ComposerHandle } from "./Composer";
import { Composer } from "./Composer";

type OnSend = (submission: PromptSubmission) => Promise<void>;

const files = [
  { changed: false, path: "src/app.ts" },
  { changed: false, path: "docs/my file.md" },
];

/** jsdom's File has no working arrayBuffer(), so back it with real bytes. */
function textFile(name: string, body: string): File {
  const bytes = new TextEncoder().encode(body);
  const file = new File([bytes], name, { type: "" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer });
  return file;
}

describe("Composer", () => {
  it("uses a shorter but fully functional textarea in compact mode", () => {
    render(<Composer compact onSend={vi.fn<OnSend>()} />);

    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("rows", "1");
    expect(input).toHaveClass("min-h-[52px]", "max-h-[180px]");
    expect(screen.getByRole("button", { name: /send/i })).toBeInTheDocument();
  });

  it("replaces the newline hint with an expandable context meter", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Composer onSend={vi.fn<OnSend>()} />);
    expect(screen.getByText("⇧↵ newline")).toBeInTheDocument();

    rerender(
      <Composer
        contextUsage={{ kind: "usage", used: 53_000, size: 200_000 }}
        onSend={vi.fn<OnSend>()}
      />,
    );

    expect(screen.queryByText("⇧↵ newline")).not.toBeInTheDocument();
    const meter = screen.getByRole("button", {
      name: /53K used · 147K remaining · 200K total/,
    });
    await user.click(meter);
    expect(screen.getByText("Context Window")).toBeInTheDocument();
    expect(screen.getByText("27% · 53K/200K")).toBeInTheDocument();
  });

  it("switches the stream action between stop and send based on the draft", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn<() => void>();
    render(<Composer onSend={vi.fn<OnSend>()} onCancel={onCancel} />);

    const input = screen.getByRole("textbox");
    const stop = screen.getByRole("button", { name: "Stop" });
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();

    await user.click(stop);
    expect(onCancel).toHaveBeenCalledOnce();

    await user.type(input, "Steer the agent");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();

    await user.clear(input);
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
  });

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

    // Without image support the attach button still works — only images are
    // refused, because documents are not capability-gated.
    rerender(<Composer onSend={onSend} imageSupported={false} />);
    expect(screen.getByTitle("Attach files (⌘⇧A)")).toBeEnabled();
    await act(async () => {
      await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, png);
    });
    await expect(screen.findByText(/does not support images/)).resolves.toBeInTheDocument();
  });

  it("accepts image drag-and-drop", async () => {
    render(<Composer onSend={vi.fn<OnSend>()} imageSupported />);
    const png = new File(["png"], "drop.png", { type: "image/png" });
    Object.defineProperty(png, "arrayBuffer", {
      value: async () => new TextEncoder().encode("png").buffer,
    });
    fireEvent.drop(screen.getByRole("textbox").parentElement!.parentElement!, {
      dataTransfer: { files: [png] },
    });
    await expect(screen.findByText("drop.png")).resolves.toBeInTheDocument();
  });

  it("attaches a dropped text file and sends it as a document", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn<OnSend>();
    render(<Composer onSend={onSend} />);
    fireEvent.drop(screen.getByRole("textbox").parentElement!.parentElement!, {
      dataTransfer: { files: [textFile("notes.md", "# hello")] },
    });

    await expect(screen.findByText("notes.md")).resolves.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith({
        attachments: [
          { type: "document", name: "notes.md", mimeType: "text/markdown", text: "# hello" },
        ],
        text: "",
      }),
    );
  });

  it("keeps one error line for attach and send failures", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn<OnSend>().mockRejectedValueOnce(new Error("Daemon offline"));
    render(<Composer onSend={onSend} />);
    const textarea = screen.getByRole("textbox");

    await user.type(textarea, "hi");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await expect(screen.findByText("Daemon offline")).resolves.toBeInTheDocument();

    // An attachment failure replaces the stale send error…
    const binary = new File([new Uint8Array([0, 1, 0xff])], "app.bin", { type: "" });
    Object.defineProperty(binary, "arrayBuffer", {
      value: async () => new Uint8Array([0, 1, 0xff]).buffer,
    });
    fireEvent.drop(textarea.parentElement!.parentElement!, { dataTransfer: { files: [binary] } });
    await expect(screen.findByText(/is not a text file/)).resolves.toBeInTheDocument();
    expect(screen.queryByText("Daemon offline")).not.toBeInTheDocument();

    // …and a successful send clears it.
    onSend.mockResolvedValue(undefined);
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(screen.queryByText(/is not a text file/)).not.toBeInTheDocument());
  });

  it("attaches a text file pasted into the textarea", async () => {
    render(<Composer onSend={vi.fn<OnSend>()} />);
    fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: { files: [textFile("pasted.txt", "body")] },
    });

    await expect(screen.findByText("pasted.txt")).resolves.toBeInTheDocument();
  });

  it("inserts a file reference when a project file is dragged in", () => {
    render(<Composer files={files} onSend={vi.fn<OnSend>()} />);

    fireEvent.drop(screen.getByRole("textbox").parentElement!.parentElement!, {
      dataTransfer: {
        getData: vi.fn<() => string>(() => "src/app.ts"),
        files: [],
        types: [FILE_REF_MIME],
      },
    });

    expect(screen.getByRole("textbox")).toHaveValue("@src/app.ts ");
  });

  it("inserts a quoted file reference for paths with spaces", () => {
    render(<Composer files={files} onSend={vi.fn<OnSend>()} />);

    fireEvent.drop(screen.getByRole("textbox").parentElement!.parentElement!, {
      dataTransfer: {
        getData: vi.fn<() => string>(() => "docs/my file.md"),
        files: [],
        types: [FILE_REF_MIME],
      },
    });

    expect(screen.getByRole("textbox")).toHaveValue('@"docs/my file.md" ');
  });
});
