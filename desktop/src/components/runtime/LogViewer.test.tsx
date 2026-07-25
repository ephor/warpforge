vi.mock("@xterm/xterm", () => {
  const MockTerminal = function () {
    const element = document.createElement("div");
    return {
      element,
      loadAddon: vi.fn<(addon: unknown) => void>(),
      onData: vi
        .fn<(cb: (data: string) => void) => { dispose: () => void }>()
        .mockReturnValue({ dispose: vi.fn<() => void>() }),
      dispose: vi.fn<() => void>(),
      focus: vi.fn<() => void>(),
      open: vi.fn<(host: HTMLElement) => void>((host) => host.appendChild(element)),
      write: vi.fn<(data: Uint8Array | string) => void>(),
      cols: 80,
      rows: 24,
    };
  };
  return { Terminal: MockTerminal };
});
vi.mock("@xterm/addon-fit", () => {
  const MockFitAddon = function () {
    return { fit: vi.fn<() => void>() };
  };
  return { FitAddon: MockFitAddon };
});

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./TerminalWorkspace", () => ({
  TerminalWorkspaceView: () => null,
}));

import { daemon } from "../../daemon";
import type { ServiceInfo } from "../../protocol";
import { RuntimePanel } from "../RuntimePanel";

const webService: ServiceInfo = {
  allocatedPort: 4000,
  command: "bun run dev",
  logSeq: 0,
  name: "web",
  originalPort: 3000,
  project: "warpforge",
  status: "running",
};

afterEach(() => {
  vi.restoreAllMocks();
});

function mockSelection(text: string, container: HTMLElement, rect: DOMRect) {
  const range = document.createRange();
  range.selectNodeContents(container);
  const sel = {
    isCollapsed: text.length === 0,
    rangeCount: text.length > 0 ? 1 : 0,
    toString: () => text,
    getRangeAt: () => range,
    removeAllRanges: vi.fn<() => void>(),
  } as unknown as Selection;
  Object.defineProperty(range, "getBoundingClientRect", { value: () => rect });
  Object.defineProperty(range, "commonAncestorContainer", {
    value: container,
  });
  document.getSelection = () => sel;
  return sel;
}

describe("LogViewer — selection toolbar", () => {
  let origGetSelection: typeof document.getSelection;
  let origClipboard: typeof navigator.clipboard;

  beforeEach(() => {
    origGetSelection = document.getSelection.bind(document);
    origClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    document.getSelection = origGetSelection;
    Object.defineProperty(navigator, "clipboard", {
      value: origClipboard,
      writable: true,
      configurable: true,
    });
  });

  it("no toolbar when no selection", () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockResolvedValue(["some log line"]);
    render(<RuntimePanel project="warpforge" services={[webService]} portforwards={[]} />);
    expect(screen.queryByRole("button", { name: /copy/i })).not.toBeInTheDocument();
  });

  it("toolbar appears with Copy and Add to chat when text is selected", async () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockResolvedValue(["selected text here"]);
    render(
      <RuntimePanel
        project="warpforge"
        services={[webService]}
        portforwards={[]}
        onAppendToChat={vi.fn<(text: string) => void>()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("selected text here")).toBeInTheDocument();
    });
    const logEl = screen.getByText("selected text here");
    const container = logEl.closest('[class*="overflow-y-auto"]') as HTMLElement;
    mockSelection("selected text here", container, new DOMRect(10, 10, 100, 20));
    fireEvent(document, new Event("selectionchange"));
    expect(screen.getByRole("button", { name: /copy selected log text/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /add selected log text to chat/i }),
    ).toBeInTheDocument();
  });

  it("Copy copies exact selected text and shows feedback", async () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockResolvedValue(["exact log content"]);
    render(
      <RuntimePanel
        project="warpforge"
        services={[webService]}
        portforwards={[]}
        onAppendToChat={vi.fn<(text: string) => void>()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("exact log content")).toBeInTheDocument();
    });
    const logEl = screen.getByText("exact log content");
    const container = logEl.closest('[class*="overflow-y-auto"]') as HTMLElement;
    mockSelection("exact log content", container, new DOMRect(10, 10, 100, 20));
    fireEvent(document, new Event("selectionchange"));
    fireEvent.click(screen.getByRole("button", { name: /copy selected log text/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("exact log content");
    await waitFor(() => {
      expect(screen.getByText("Copied")).toBeInTheDocument();
    });
  });

  it("Copy shows failure feedback on clipboard rejection", async () => {
    (navigator.clipboard.writeText as any).mockRejectedValueOnce(new Error("denied"));
    vi.spyOn(daemon, "fetchServiceLogs").mockResolvedValue(["text"]);
    render(
      <RuntimePanel
        project="warpforge"
        services={[webService]}
        portforwards={[]}
        onAppendToChat={vi.fn<(text: string) => void>()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("text")).toBeInTheDocument();
    });
    const logEl = screen.getByText("text");
    const container = logEl.closest('[class*="overflow-y-auto"]') as HTMLElement;
    mockSelection("text", container, new DOMRect(10, 10, 100, 20));
    fireEvent(document, new Event("selectionchange"));
    fireEvent.click(screen.getByRole("button", { name: /copy selected log text/i }));
    await waitFor(() => {
      expect(screen.getByText("Copy failed")).toBeInTheDocument();
    });
  });

  it("Add to chat sends formatted selection to callback, does not submit", async () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockResolvedValue(["log snippet"]);
    const onAppendToChat = vi.fn<(text: string) => void>();
    render(
      <RuntimePanel
        project="warpforge"
        services={[webService]}
        portforwards={[]}
        onAppendToChat={onAppendToChat}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("log snippet")).toBeInTheDocument();
    });
    const logEl = screen.getByText("log snippet");
    const container = logEl.closest('[class*="overflow-y-auto"]') as HTMLElement;
    mockSelection("log snippet", container, new DOMRect(10, 10, 100, 20));
    fireEvent(document, new Event("selectionchange"));
    fireEvent.click(screen.getByRole("button", { name: /add selected log text to chat/i }));
    expect(onAppendToChat).toHaveBeenCalledWith("service:web\n```\nlog snippet\n```");
  });

  it("selection outside log viewer does not show toolbar", async () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockResolvedValue(["log line"]);
    render(<RuntimePanel project="warpforge" services={[webService]} portforwards={[]} />);
    await waitFor(() => {
      expect(screen.getByText("log line")).toBeInTheDocument();
    });
    mockSelection("outside text", document.body, new DOMRect(10, 10, 100, 20));
    fireEvent(document, new Event("selectionchange"));
    expect(
      screen.queryByRole("button", { name: /copy selected log text/i }),
    ).not.toBeInTheDocument();
  });

  it("collapsed selection does not show toolbar", async () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockResolvedValue(["log line"]);
    render(<RuntimePanel project="warpforge" services={[webService]} portforwards={[]} />);
    await waitFor(() => {
      expect(screen.getByText("log line")).toBeInTheDocument();
    });
    const logEl = screen.getByText("log line");
    const container = logEl.closest('[class*="overflow-y-auto"]') as HTMLElement;
    const sel = mockSelection("", container, new DOMRect(10, 10, 0, 0));
    (sel as any).isCollapsed = true;
    (sel as any).rangeCount = 0;
    fireEvent(document, new Event("selectionchange"));
    expect(
      screen.queryByRole("button", { name: /copy selected log text/i }),
    ).not.toBeInTheDocument();
  });
});

describe("LogViewer — auto-follow", () => {
  function makeScrollable(container: HTMLElement, scrollTop = 0) {
    Object.defineProperty(container, "scrollHeight", {
      value: 1000,
      configurable: true,
    });
    Object.defineProperty(container, "clientHeight", {
      value: 200,
      configurable: true,
    });
    Object.defineProperty(container, "scrollTop", {
      value: scrollTop,
      writable: true,
      configurable: true,
    });
  }

  it("Jump-to-latest is hidden initially when following", async () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockResolvedValue(["line1"]);
    render(<RuntimePanel project="warpforge" services={[webService]} portforwards={[]} />);
    await waitFor(() => {
      expect(screen.getByText("line1")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Jump to latest log line")).not.toBeInTheDocument();
  });

  it("Jump to latest hides after click", async () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockResolvedValue(["line1"]);
    render(<RuntimePanel project="warpforge" services={[webService]} portforwards={[]} />);
    await waitFor(() => {
      expect(screen.getByText("line1")).toBeInTheDocument();
    });
    const container = screen
      .getByText("line1")
      .closest('[class*="overflow-y-auto"]') as HTMLElement;
    makeScrollable(container, 100);
    fireEvent.scroll(container);
    await waitFor(() => {
      expect(screen.getByLabelText("Jump to latest log line")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText("Jump to latest log line"));
    expect(screen.queryByLabelText("Jump to latest log line")).not.toBeInTheDocument();
  });

  it("scrolling back to bottom hides jump button", async () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockResolvedValue(["line1"]);
    render(<RuntimePanel project="warpforge" services={[webService]} portforwards={[]} />);
    await waitFor(() => {
      expect(screen.getByText("line1")).toBeInTheDocument();
    });
    const container = screen
      .getByText("line1")
      .closest('[class*="overflow-y-auto"]') as HTMLElement;
    makeScrollable(container, 100);
    fireEvent.scroll(container);
    await waitFor(() => {
      expect(screen.getByLabelText("Jump to latest log line")).toBeInTheDocument();
    });
    makeScrollable(container, 800);
    fireEvent.scroll(container);
    expect(screen.queryByLabelText("Jump to latest log line")).not.toBeInTheDocument();
  });

  it("new log appended while scrolled up does not yank to bottom", async () => {
    const logStore: Record<string, string[]> = {
      "warpforge/web": ["line1"],
    };
    vi.spyOn(daemon, "getState").mockReturnValue({
      ...daemon.getState(),
      serviceLogs: logStore,
    });
    vi.spyOn(daemon, "fetchServiceLogs").mockResolvedValue([]);

    let subscriber: (() => void) | null = null;
    vi.spyOn(daemon, "subscribe").mockImplementation((fn: () => void) => {
      subscriber = fn;
      return () => {};
    });

    render(<RuntimePanel project="warpforge" services={[webService]} portforwards={[]} />);
    await waitFor(() => {
      expect(screen.getByText("line1")).toBeInTheDocument();
    });

    const container = screen
      .getByText("line1")
      .closest('[class*="overflow-y-auto"]') as HTMLElement;
    makeScrollable(container, 100);
    fireEvent.scroll(container);

    const scrollTopBefore = container.scrollTop;
    logStore["warpforge/web"] = ["line1", "line2"];
    act(() => {
      subscriber!();
    });

    expect(screen.getByText("line2")).toBeInTheDocument();
    expect(container.scrollTop).toBe(scrollTopBefore);
    expect(screen.getByLabelText("Jump to latest log line")).toBeInTheDocument();
  });

  it("after resuming follow, new log appends scroll to bottom", async () => {
    const logStore: Record<string, string[]> = {
      "warpforge/web": ["line1"],
    };
    vi.spyOn(daemon, "getState").mockReturnValue({
      ...daemon.getState(),
      serviceLogs: logStore,
    });
    vi.spyOn(daemon, "fetchServiceLogs").mockResolvedValue([]);

    let subscriber: (() => void) | null = null;
    vi.spyOn(daemon, "subscribe").mockImplementation((fn: () => void) => {
      subscriber = fn;
      return () => {};
    });

    render(<RuntimePanel project="warpforge" services={[webService]} portforwards={[]} />);
    await waitFor(() => {
      expect(screen.getByText("line1")).toBeInTheDocument();
    });

    const container = screen
      .getByText("line1")
      .closest('[class*="overflow-y-auto"]') as HTMLElement;

    makeScrollable(container, 800);
    fireEvent.scroll(container);

    logStore["warpforge/web"] = ["line1", "line2"];
    act(() => {
      subscriber!();
    });

    await waitFor(() => {
      expect(screen.getByText("line2")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(container.scrollTop).toBeGreaterThan(800);
    });
  });
});
