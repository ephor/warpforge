import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EMPTY_SNAPSHOT } from "../protocol";
import Board from "./Board";

describe("Board layout", () => {
  it("renders four user-resizable lanes", () => {
    render(<Board snapshot={EMPTY_SNAPSHOT} onOpenTask={vi.fn()} onNewTask={vi.fn()} />);

    expect(screen.getByRole("region", { name: "Queue lane" })).toHaveClass("h-full", "min-h-0");
    expect(screen.getByRole("region", { name: "Active lane" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Review / blocked lane" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "History lane" })).toBeInTheDocument();
    expect(screen.getAllByRole("separator")).toHaveLength(3);
  });
});
