import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EditHunk, SessionUpdate } from "../protocol";
import { StreamLine } from "./MissionControl";
import { appendCoalesced, coalesceUpdates } from "./missionControlStream";

afterEach(() => vi.restoreAllMocks());

/** Reference incremental fold, mirroring ChatTranscript.useCoalesced. */
function incrementalCoalesce(prefix: SessionUpdate[], tail: SessionUpdate[]) {
  const merged = coalesceUpdates(prefix);
  const toolAt = new Map<string, number>();
  merged.forEach((u, i) => {
    if (u.kind === "tool_call") toolAt.set(u.tool_call_id, i);
    if (u.kind === "file_edit" && u.tool_call_id) toolAt.set(`edit:${u.tool_call_id}`, i);
  });
  for (const u of tail) appendCoalesced(merged, toolAt, u);
  return merged;
}

describe("coalesceUpdates tool timing", () => {
  it("keeps the first tool epoch when a later same-id frame replaces it", () => {
    const updates: SessionUpdate[] = [
      {
        kind: "tool_call",
        started_at: 1_000,
        status: "pending",
        title: "wait",
        tool_call_id: "call-1",
        tool_kind: "execute",
      },
      {
        kind: "tool_call",
        started_at: 9_000,
        status: "completed",
        title: "wait",
        tool_call_id: "call-1",
        tool_kind: "execute",
      },
    ];

    expect(coalesceUpdates(updates)[0]).toMatchObject({
      started_at: 1_000,
      status: "completed",
    });
  });

  it("coalesces lifecycle frames for one file edit and keeps the line counts", () => {
    const updates: SessionUpdate[] = [
      { kind: "file_edit", path: "src/App.tsx", tool_call_id: "edit-1" },
      {
        kind: "file_edit",
        path: "src/App.tsx",
        tool_call_id: "edit-1",
        additions: 12,
        deletions: 3,
      },
    ];

    expect(coalesceUpdates(updates)).toEqual([updates[1]]);
  });
});

describe("file edit line", () => {
  it("shows a project-relative path and per-edit line counts", () => {
    render(
      createElement(StreamLine, {
        update: {
          kind: "file_edit",
          path: "/Users/dev/warpforge/desktop/src/App.tsx",
          additions: 12,
          deletions: 3,
        },
        project: "warpforge",
        resolveFilePath: () => "desktop/src/App.tsx",
      }),
    );

    expect(screen.getByText("warpforge/desktop/src/App.tsx")).toBeInTheDocument();
    expect(screen.queryByText("/Users/dev/warpforge/desktop/src/App.tsx")).not.toBeInTheDocument();
    expect(screen.getByLabelText("12 lines added, 3 lines deleted")).toBeInTheDocument();
  });

  it("opens the editor from the file name and the exact diff from the line counts", async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn<(path: string) => void>();
    const onOpenFileDiff = vi.fn<(path: string, hunks?: EditHunk[]) => void>();
    const editHunks = [
      {
        lines: ["-old", "+new"],
        newLines: 1,
        newStart: 12,
        oldLines: 1,
        oldStart: 12,
      },
    ];
    render(
      createElement(StreamLine, {
        update: {
          kind: "file_edit",
          path: "desktop/src/App.tsx",
          additions: 6,
          deletions: 2,
          hunks: editHunks,
        },
        resolveFilePath: () => "desktop/src/App.tsx",
        onOpenFile,
        onOpenFileDiff,
      }),
    );

    await user.click(screen.getByRole("button", { name: "desktop/src/App.tsx" }));
    expect(onOpenFile).toHaveBeenCalledWith("desktop/src/App.tsx");
    expect(onOpenFileDiff).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", {
        name: "Open diff for desktop/src/App.tsx: 6 lines added, 2 lines deleted",
      }),
    );
    expect(onOpenFileDiff).toHaveBeenCalledWith("desktop/src/App.tsx", editHunks);
  });
});

describe("agent text streaming", () => {
  it("polls only the active streaming message, not historical transcript rows", () => {
    const interval = vi.spyOn(window, "setInterval");
    const historical = render(
      createElement(StreamLine, {
        update: { kind: "agent_text", text: "Finished response" },
      }),
    );
    expect(interval).not.toHaveBeenCalled();
    historical.unmount();

    render(
      createElement(StreamLine, {
        textStreaming: true,
        update: { kind: "agent_text", text: "Streaming response" },
      }),
    );
    expect(interval).toHaveBeenCalledTimes(1);
  });
});

describe("incremental coalescing", () => {
  const stream: SessionUpdate[] = [
    { kind: "user_message", text: "hi" },
    { kind: "agent_thought", text: "let " },
    { kind: "agent_thought", text: "me think" },
    {
      kind: "tool_call",
      status: "pending",
      title: "read",
      tool_call_id: "t1",
      tool_kind: "read",
    },
    { kind: "file_edit", path: "src/App.tsx", tool_call_id: "edit-1" },
    {
      kind: "file_edit",
      path: "src/App.tsx",
      tool_call_id: "edit-1",
      additions: 2,
      deletions: 1,
    },
    { kind: "agent_text", text: "Hello" },
    { kind: "agent_text", text: ", world" },
    {
      kind: "tool_call",
      status: "completed",
      title: "read",
      tool_call_id: "t1",
      tool_kind: "read",
    },
    { kind: "agent_text", text: "!" },
  ];

  it("matches a full rebuild at every append boundary", () => {
    for (let split = 0; split <= stream.length; split += 1) {
      const incremental = incrementalCoalesce(stream.slice(0, split), stream.slice(split));
      expect(incremental).toEqual(coalesceUpdates(stream));
    }
  });

  it("preserves object identity of blocks the tail did not touch", () => {
    const prefix = stream.slice(0, 4); // through the pending tool_call
    const base = coalesceUpdates(prefix);
    const toolAt = new Map<string, number>();
    base.forEach((u, i) => u.kind === "tool_call" && toolAt.set(u.tool_call_id, i));
    const userBlock = base[0];
    const thoughtBlock = base[1];

    // Append a fresh agent_text run — must not clone earlier blocks.
    appendCoalesced(base, toolAt, { kind: "agent_text", text: "ok" });
    expect(base[0]).toBe(userBlock);
    expect(base[1]).toBe(thoughtBlock);
  });
});
