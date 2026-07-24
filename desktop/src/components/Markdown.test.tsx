import { openUrl } from "@tauri-apps/plugin-opener";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CollapsibleMarkdown, Markdown } from "./Markdown";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn<(url: string) => Promise<void>>(),
}));

describe("Markdown links", () => {
  beforeEach(() => {
    vi.spyOn(window, "open").mockImplementation(() => null);
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    // Vitest 4 reuses an existing spy instead of re-wrapping it, so the
    // window.open calls would otherwise accumulate across tests.
    vi.restoreAllMocks();
  });

  it("opens external links outside the app webview", async () => {
    const user = userEvent.setup();
    render(<Markdown>[Open PR](https://github.com/ephor/warpforge/pull/4)</Markdown>);

    await user.click(screen.getByRole("link", { name: "Open PR" }));

    expect(window.open).toHaveBeenCalledWith(
      "https://github.com/ephor/warpforge/pull/4",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("uses the system opener in the desktop app", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    render(<Markdown>[Open PR](https://github.com/ephor/warpforge/pull/4)</Markdown>);

    await user.click(screen.getByRole("link", { name: "Open PR" }));

    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith("https://github.com/ephor/warpforge/pull/4"),
    );
    expect(window.open).not.toHaveBeenCalled();
  });

  it("leaves relative links to the webview router", () => {
    render(<Markdown>[Task details](/tasks/42)</Markdown>);

    expect(screen.getByRole("link", { name: "Task details" })).not.toHaveAttribute("target");
  });

  it("keeps inline file links wired after renderer components are stabilized", async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn<(path: string) => void>();
    render(
      <Markdown
        resolveFilePath={(text) => (text === "src/main.rs" ? text : null)}
        onOpenFile={onOpenFile}
      >
        {"Open `src/main.rs`"}
      </Markdown>,
    );

    await user.click(screen.getByRole("button", { name: "src/main.rs" }));

    expect(onOpenFile).toHaveBeenCalledWith("src/main.rs");
  });

  it("opens file paths from markdown links in the editor", async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn<(path: string) => void>();
    render(
      <Markdown
        resolveFilePath={(text) => (text === "src/main.rs" ? text : null)}
        onOpenFile={onOpenFile}
      >
        {"[src/main.rs](src/main.rs)"}
      </Markdown>,
    );

    await user.click(screen.getByRole("link", { name: "src/main.rs" }));

    expect(onOpenFile).toHaveBeenCalledWith("src/main.rs");
    expect(window.open).not.toHaveBeenCalled();
  });
});

describe("CollapsibleMarkdown", () => {
  it("bounds long messages until the user expands them", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <CollapsibleMarkdown>{"Long message ".repeat(60)}</CollapsibleMarkdown>,
    );

    expect(container.querySelector(".max-h-44")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show full message" }));

    expect(container.querySelector(".max-h-44")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("does not add disclosure controls to short messages", () => {
    render(<CollapsibleMarkdown>Short message</CollapsibleMarkdown>);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
