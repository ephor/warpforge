import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SURFACE_TABS, type SurfaceTab } from "@/components/workspace";

import type { TaskSurface } from "../../store/ui";
import { TaskSurfaceTabs } from "./TaskSurfaceTabs";

describe("TaskSurfaceTabs", () => {
  it("renders Files, Diff, Runtime, and Pipeline as accessible tabs", () => {
    render(
      <TaskSurfaceTabs
        activeSurface="diff"
        onSurfaceChange={vi.fn<(surface: TaskSurface) => void>()}
        focused={false}
        focusLabel="Focus workspace"
        onToggleFocus={vi.fn<() => void>()}
      />,
    );

    expect(screen.getByRole("tablist", { name: "Workspace surfaces" })).toBeInTheDocument();
    for (const label of ["Files", "Diff", "Runtime", "Pipeline"]) {
      expect(screen.getByRole("tab", { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it("marks exactly one surface active at a time", () => {
    render(
      <TaskSurfaceTabs
        activeSurface="runtime"
        onSurfaceChange={vi.fn<(surface: TaskSurface) => void>()}
        focused={false}
        focusLabel="Focus workspace"
        onToggleFocus={vi.fn<() => void>()}
      />,
    );

    const tabs = screen.getAllByRole("tab");
    const selected = tabs.filter((tab) => tab.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveAccessibleName(/Runtime/);
  });

  it("shows counts only when data exists", () => {
    const tabs: SurfaceTab[] = DEFAULT_SURFACE_TABS.map((tab) =>
      tab.id === "diff" ? { ...tab, count: 4 } : tab,
    );
    render(
      <TaskSurfaceTabs
        activeSurface="diff"
        onSurfaceChange={vi.fn<(surface: TaskSurface) => void>()}
        tabs={tabs}
        focused={false}
        focusLabel="Focus workspace"
        onToggleFocus={vi.fn<() => void>()}
      />,
    );

    expect(screen.getByRole("tab", { name: /Diff/ })).toHaveTextContent("4");
    expect(screen.getByRole("tab", { name: /Files/ })).not.toHaveTextContent(/\d/);
  });

  it("calls onSurfaceChange with only the clicked surface", async () => {
    const onSurfaceChange = vi.fn<(surface: TaskSurface) => void>();
    render(
      <TaskSurfaceTabs
        activeSurface="diff"
        onSurfaceChange={onSurfaceChange}
        focused={false}
        focusLabel="Focus workspace"
        onToggleFocus={vi.fn<() => void>()}
      />,
    );

    await userEvent.click(screen.getByRole("tab", { name: /Pipeline/ }));

    expect(onSurfaceChange).toHaveBeenCalled();
    for (const call of onSurfaceChange.mock.calls) {
      expect(call).toEqual(["pipeline"]);
    }
  });

  it("exposes the focus control with an accessible label and pressed state", () => {
    const onToggleFocus = vi.fn<() => void>();
    render(
      <TaskSurfaceTabs
        activeSurface="diff"
        onSurfaceChange={vi.fn<(surface: TaskSurface) => void>()}
        focused
        focusLabel="Restore split view"
        onToggleFocus={onToggleFocus}
      />,
    );

    const button = screen.getByRole("button", { name: "Restore split view" });
    expect(button).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(button);
    expect(onToggleFocus).toHaveBeenCalledTimes(1);
  });
});
