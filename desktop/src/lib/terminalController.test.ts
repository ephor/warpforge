const xtermInstances = vi.hoisted(() => [] as object[]);

vi.mock("@xterm/xterm", () => {
  const MockTerminal = function () {
    const element = document.createElement("div");
    const terminal = {
      cols: 80,
      dispose: vi.fn<() => void>(),
      element,
      focus: vi.fn<() => void>(),
      inputHandler: null as ((data: string) => void) | null,
      loadAddon: vi.fn<(addon: unknown) => void>(),
      onData: vi.fn<(cb: (data: string) => void) => { dispose: () => void }>((cb) => {
        terminal.inputHandler = cb;
        return { dispose: vi.fn<() => void>() };
      }),
      open: vi.fn<(host: HTMLElement) => void>((host) => host.appendChild(element)),
      rows: 24,
      write: vi.fn<(data: Uint8Array | string) => void>(),
    };
    xtermInstances.push(terminal);
    return terminal;
  };
  return { Terminal: MockTerminal };
});

const fitInstances = vi.hoisted(() => [] as Array<{ fit: ReturnType<typeof vi.fn> }>);

vi.mock("@xterm/addon-fit", () => {
  const MockFitAddon = function () {
    const addon = { fit: vi.fn<() => void>() };
    fitInstances.push(addon);
    return addon;
  };
  return { FitAddon: MockFitAddon };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { daemon } from "../daemon";
import { TerminalController } from "./terminalController";

interface MockTerminal {
  cols: number;
  element: HTMLElement;
  focus: ReturnType<typeof vi.fn>;
  inputHandler: ((data: string) => void) | null;
  onData: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  rows: number;
  write: ReturnType<typeof vi.fn>;
}

let animationFrames: Map<number, FrameRequestCallback>;
let nextAnimationFrameId: number;
let terminalDataListener: ((data: Uint8Array) => void) | null;

function flushAnimationFrames() {
  const pending = [...animationFrames.values()];
  animationFrames.clear();
  for (const callback of pending) callback(performance.now());
}

beforeEach(() => {
  xtermInstances.length = 0;
  fitInstances.length = 0;
  animationFrames = new Map();
  nextAnimationFrameId = 1;
  terminalDataListener = null;

  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      const id = nextAnimationFrameId++;
      animationFrames.set(id, callback);
      return id;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => {
      animationFrames.delete(id);
    }),
  );
  vi.spyOn(daemon, "subscribeTerminalData").mockImplementation((_terminalId, listener) => {
    terminalDataListener = listener;
    return vi.fn<() => void>();
  });
  vi.spyOn(daemon, "sendTerminalInput").mockImplementation(() => {});
  vi.spyOn(daemon, "resizeTerminal").mockImplementation(() => {});
  vi.spyOn(daemon, "clearTerminalBuffer").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TerminalController DOM attachment", () => {
  it("opens once, reparents the same xterm, and keeps singular input/data/resize wiring", () => {
    const controller = new TerminalController({ project: "warpforge", terminalId: "term-1" });
    const terminal = controller.term as unknown as MockTerminal;
    const firstHost = document.createElement("div");
    const secondHost = document.createElement("div");
    const inputSpy = vi.spyOn(daemon, "sendTerminalInput");
    const resizeSpy = vi.spyOn(daemon, "resizeTerminal");

    controller.attach(firstHost, true);
    expect(terminal.open).toHaveBeenCalledTimes(1);
    expect(terminal.onData).toHaveBeenCalledTimes(1);
    expect(firstHost.firstElementChild).toBe(terminal.element);
    expect(terminal.focus).not.toHaveBeenCalled();

    flushAnimationFrames();
    expect(terminal.focus).toHaveBeenCalledTimes(1);
    expect(resizeSpy).toHaveBeenCalledTimes(1);

    terminalDataListener?.(new TextEncoder().encode("before reattach"));
    expect(terminal.write).toHaveBeenCalledTimes(1);

    terminal.cols = 100;
    controller.attach(secondHost, true);
    expect(terminal.open).toHaveBeenCalledTimes(1);
    expect(terminal.onData).toHaveBeenCalledTimes(1);
    expect(firstHost).toBeEmptyDOMElement();
    expect(secondHost.firstElementChild).toBe(terminal.element);

    flushAnimationFrames();
    expect(resizeSpy).toHaveBeenCalledTimes(2);
    expect(resizeSpy).toHaveBeenLastCalledWith("term-1", 100, 24);

    terminal.inputHandler?.("x");
    expect(inputSpy).toHaveBeenCalledTimes(1);
    expect(inputSpy).toHaveBeenCalledWith("term-1", new TextEncoder().encode("x"));

    terminalDataListener?.(new TextEncoder().encode("after reattach"));
    expect(terminal.write).toHaveBeenCalledTimes(2);
    expect(xtermInstances).toHaveLength(1);
    expect(fitInstances[0].fit).toHaveBeenCalledTimes(2);

    controller.dispose();
  });
});
