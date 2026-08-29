import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import { SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN, useUi } from "./store/ui";

vi.mock("./daemon", () => {
  const stableState = {
    connection: "connected" as const,
    connectionError: null,
    pendingAgentSetup: null,
    portforwardLogs: {},
    serviceLogs: {},
    sessionUpdates: {},
    snapshot: {
      portforwards: [],
      projects: [],
      services: [],
      tasks: [],
      terminals: [],
    },
  };
  const subscribe = vi.fn<() => () => void>(() => () => {});
  const getState = vi.fn<() => typeof stableState>(() => stableState);
  return {
    daemon: {
      subscribe,
      getState,
      dismissAgentSetup: vi.fn<() => void>(),
      request: vi.fn<() => Promise<unknown>>(),
    },
  };
});

vi.mock("./hooks/useMediaQuery", () => ({
  useMediaQuery: vi.fn<(query: string) => boolean>(),
}));

vi.mock("./hooks/useFontScaling", () => ({ useFontScaling: vi.fn<() => void>() }));
vi.mock("./hooks/useTheme", () => ({ useTheme: vi.fn<() => void>() }));
vi.mock("./hooks/useDaemonEvents", () => ({ useDaemonEvents: vi.fn<() => void>() }));
vi.mock("./hooks/useTauriClose", () => ({ useTauriClose: vi.fn<() => void>() }));
vi.mock("./hooks/usePullShortcut", () => ({ usePullShortcut: vi.fn<() => void>() }));
vi.mock("./hooks/usePushShortcut", () => ({ usePushShortcut: vi.fn<() => void>() }));

vi.mock("./views/MissionControl", () => ({
  default: (props: { onOpenTask: (id: string) => void }) => (
    <div data-testid="mission-control" onClick={() => props.onOpenTask("task-1")} />
  ),
}));
vi.mock("./views/Projects", () => ({
  default: vi.fn<() => React.ReactNode>(() => <div data-testid="projects" />),
}));
vi.mock("./views/TaskDetail", () => ({
  default: vi.fn<() => React.ReactNode>(() => <div data-testid="task-detail" />),
}));
vi.mock("./views/Settings", () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="settings" /> : null),
}));
vi.mock("./views/NewTaskDialog", () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="new-task-dialog" /> : null),
}));
vi.mock("./views/PushDialog", () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="push-dialog" /> : null),
}));
vi.mock("./views/AgentSetupDialog", () => ({
  default: vi.fn<() => React.ReactNode>(() => <div data-testid="agent-setup" />),
}));
vi.mock("./views/BootstrapWizard", () => ({
  default: vi.fn<() => React.ReactNode>(() => <div data-testid="bootstrap-wizard" />),
}));
vi.mock("./components/Sidebar", () => ({
  default: vi.fn<() => React.ReactNode>(() => <div data-testid="app-sidebar">Sidebar</div>),
}));
vi.mock("./components/AttentionToast", () => ({
  default: vi.fn<() => React.ReactNode>(() => <div data-testid="attention-toast" />),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn<() => void>(), {
    custom: vi.fn<() => void>(),
    dismiss: vi.fn<() => void>(),
  }),
}));

const { useMediaQuery } = await import("./hooks/useMediaQuery");
const mockedUseMediaQuery = vi.mocked(useMediaQuery);

function setWide(wide: boolean) {
  mockedUseMediaQuery.mockReturnValue(wide);
}

beforeEach(() => {
  localStorage.clear();
  useUi.setState({
    sidebarCollapsed: false,
    sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
    view: "control",
    openTaskId: null,
  });
  vi.clearAllMocks();
  setWide(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App sidebar layout", () => {
  it("renders exactly one persistent sidebar on wide viewports", async () => {
    setWide(true);

    render(<App />);
    await screen.findByTestId("mission-control");

    expect(screen.getByTestId("persistent-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-resize-handle")).toBeInTheDocument();
    expect(screen.getAllByTestId("app-sidebar")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Close sessions rail" })).not.toBeInTheDocument();
  });

  it("renders no sidebar on narrow viewports", () => {
    setWide(false);

    render(<App />);

    expect(screen.queryByTestId("persistent-sidebar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-resize-handle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("app-sidebar")).not.toBeInTheDocument();
  });

  it("persistent sidebar uses store width", async () => {
    setWide(true);
    useUi.setState({ sidebarWidth: 400 });

    render(<App />);
    await screen.findByTestId("mission-control");

    const sidebar = screen.getByTestId("persistent-sidebar");
    expect(sidebar.style.width).toBe("400px");
  });

  it("collapsed sidebar shrinks to the icon rail and drops the resize handle", () => {
    setWide(true);
    useUi.setState({ sidebarCollapsed: true, sidebarWidth: 400 });

    render(<App />);

    expect(screen.getByTestId("persistent-sidebar").style.width).toBe("64px");
    expect(screen.queryByTestId("sidebar-resize-handle")).not.toBeInTheDocument();
  });

  it("⌘N opens the new task dialog", async () => {
    render(<App />);
    await screen.findByTestId("mission-control");

    expect(screen.queryByTestId("new-task-dialog")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "n", metaKey: true });
    expect(await screen.findByTestId("new-task-dialog")).toBeInTheDocument();
  });
});

describe("SidebarResizeHandle keyboard", () => {
  it("ArrowRight increases width by step", () => {
    setWide(true);
    useUi.setState({ sidebarWidth: 340 });

    render(<App />);

    const handle = screen.getByTestId("sidebar-resize-handle");
    fireEvent.keyDown(handle, { key: "ArrowRight" });

    expect(useUi.getState().sidebarWidth).toBe(350);
  });

  it("ArrowLeft decreases width by step", () => {
    setWide(true);
    useUi.setState({ sidebarWidth: 340 });

    render(<App />);

    const handle = screen.getByTestId("sidebar-resize-handle");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });

    expect(useUi.getState().sidebarWidth).toBe(330);
  });

  it("Home sets width to min", () => {
    setWide(true);
    useUi.setState({ sidebarWidth: 340 });

    render(<App />);

    const handle = screen.getByTestId("sidebar-resize-handle");
    fireEvent.keyDown(handle, { key: "Home" });

    expect(useUi.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_MIN);
  });

  it("End sets width to max", () => {
    setWide(true);
    useUi.setState({ sidebarWidth: 340 });

    render(<App />);

    const handle = screen.getByTestId("sidebar-resize-handle");
    fireEvent.keyDown(handle, { key: "End" });

    expect(useUi.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_MAX);
  });

  it("width is clamped after keyboard resize", () => {
    setWide(true);
    useUi.setState({ sidebarWidth: SIDEBAR_WIDTH_MIN });

    render(<App />);

    const handle = screen.getByTestId("sidebar-resize-handle");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });

    expect(useUi.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_MIN);
  });
});

describe("SidebarResizeHandle ARIA", () => {
  it("has correct separator role and orientation", () => {
    setWide(true);
    useUi.setState({ sidebarWidth: 340 });

    render(<App />);

    const handle = screen.getByTestId("sidebar-resize-handle");
    expect(handle).toHaveAttribute("role", "separator");
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-valuemin", String(SIDEBAR_WIDTH_MIN));
    expect(handle).toHaveAttribute("aria-valuemax", String(SIDEBAR_WIDTH_MAX));
    expect(handle).toHaveAttribute("aria-valuenow", "340");
    expect(handle).toHaveAttribute("tabindex", "0");
  });

  it("updates aria-valuenow when width changes", () => {
    setWide(true);
    useUi.setState({ sidebarWidth: 340 });

    render(<App />);

    const handle = screen.getByTestId("sidebar-resize-handle");
    fireEvent.keyDown(handle, { key: "ArrowRight" });

    expect(handle).toHaveAttribute("aria-valuenow", "350");
  });
});

describe("Responsive behavior", () => {
  it("hides the sidebar when viewport narrows", () => {
    setWide(true);

    const { rerender } = render(<App />);
    expect(screen.getByTestId("persistent-sidebar")).toBeInTheDocument();

    setWide(false);
    rerender(<App />);

    expect(screen.queryByTestId("persistent-sidebar")).not.toBeInTheDocument();
  });

  it("shows the sidebar when viewport widens", () => {
    setWide(false);

    const { rerender } = render(<App />);
    expect(screen.queryByTestId("persistent-sidebar")).not.toBeInTheDocument();

    setWide(true);
    rerender(<App />);

    expect(screen.getByTestId("persistent-sidebar")).toBeInTheDocument();
  });

  it("renders no off-canvas overlay on any viewport", () => {
    setWide(true);

    const { rerender } = render(<App />);
    expect(screen.queryByRole("button", { name: "Close sessions rail" })).not.toBeInTheDocument();

    setWide(false);
    rerender(<App />);

    expect(screen.queryByRole("button", { name: "Close sessions rail" })).not.toBeInTheDocument();
  });
});

describe("AppHeader sidebar control", () => {
  it("has no header sidebar toggle (collapse lives in the sidebar)", () => {
    render(<App />);

    expect(
      screen.queryByRole("button", { name: "Toggle attention sidebar" }),
    ).not.toBeInTheDocument();
  });
});
