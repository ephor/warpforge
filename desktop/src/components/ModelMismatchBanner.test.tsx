import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { TaskInfo } from "@/protocol";

import { ModelMismatchBanner } from "./ModelMismatchBanner";

function task(overrides: Partial<TaskInfo> = {}): TaskInfo {
  return {
    agent: "codex",
    blockedKind: "model_mismatch",
    blockedReason: "Requested model 'opus[1m]' was not applied: the agent rejected it.",
    createdAt: 1,
    filesChanged: 0,
    id: "t1",
    parentTaskId: null,
    project: "warpforge",
    prompt: "t1",
    status: "running",
    tags: [],
    title: "",
    updatedAt: 1,
    ...overrides,
  };
}

describe("ModelMismatchBanner", () => {
  it("renders nothing for tasks without a mismatch", () => {
    const { container } = render(<ModelMismatchBanner task={task({ blockedKind: null })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for other blocked kinds", () => {
    const { container } = render(
      <ModelMismatchBanner task={task({ blockedKind: "session_lost" })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("names the problem and includes the daemon's reason", () => {
    render(<ModelMismatchBanner task={task()} />);
    expect(screen.getByText("This session is not running on the requested model")).toBeVisible();
    expect(screen.getByText(/Requested model 'opus\[1m\]' was not applied/)).toBeVisible();
  });

  it("falls back to a generic detail when the reason is missing", () => {
    render(<ModelMismatchBanner task={task({ blockedReason: null })} />);
    expect(
      screen.getByText(/The requested model was not applied\. The session works/),
    ).toBeVisible();
  });
});
