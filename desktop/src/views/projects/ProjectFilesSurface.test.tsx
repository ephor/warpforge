import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { daemon } from "@/daemon";
import { useUi } from "@/store/ui";

import { ProjectFilesSurface } from "./ProjectFilesSurface";

// jsdom has no layout, so the virtualizer would render zero rows.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 28 })),
    scrollToIndex: vi.fn<(...args: unknown[]) => void>(),
  }),
}));

vi.mock("../../components/CodeEditor", () => ({
  CodeEditor: ({ doc, editable }: { doc: { path: string }; editable: boolean }) => (
    <div data-testid="editor" data-editable={String(editable)}>
      {doc.path}
    </div>
  ),
}));

function renderSurface() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProjectFilesSurface project="warpforge" rootPath="/workspace/warpforge" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  useUi.setState({ filesPanelCollapsed: false });
  vi.spyOn(daemon, "request").mockImplementation(async (method: string, params?: unknown) => {
    if (method === "file.list") return [{ path: "main.rs", changed: false }];
    if (method === "file.contents") {
      const { path } = params as { path: string };
      return { path, status: "modified", oldText: "", newText: "fn main() {}" };
    }
    return {};
  });
});

describe("ProjectFilesSurface", () => {
  it("reads the project's own checkout and previews a file read-only", async () => {
    renderSurface();
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.click(await screen.findByText("main.rs"));

    const editor = await screen.findByTestId("editor");
    expect(editor).toHaveTextContent("main.rs");
    expect(editor).toHaveAttribute("data-editable", "false");
    // Both reads are addressed by project: no task owns these files.
    expect(daemon.request).toHaveBeenCalledWith(
      "file.contents",
      expect.objectContaining({ path: "main.rs", project: "warpforge" }),
    );
  });

  it("hides the tree when the file panel is collapsed", async () => {
    renderSurface();
    expect(await screen.findByText("main.rs")).toBeInTheDocument();

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole("button", { name: "Collapse file panel" }));

    expect(screen.queryByText("main.rs")).not.toBeInTheDocument();
  });
});
