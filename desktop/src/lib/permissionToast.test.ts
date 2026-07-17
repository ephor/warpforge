import { describe, expect, it } from "vitest";

import type { SessionUpdate } from "../protocol";
import { permissionToastContext } from "./permissionToast";

const request = (title = "Permission request"): Extract<
  SessionUpdate,
  { kind: "permission_request" }
> => ({ kind: "permission_request", options: ["allow", "deny"], request_id: "request-1", title });

const tool = (title: string): SessionUpdate => ({
  kind: "tool_call",
  status: "in_progress",
  title,
  tool_call_id: "tool-1",
  tool_kind: "execute",
});

describe("permissionToastContext", () => {
  it("prefers a meaningful permission title", () => {
    expect(permissionToastContext(request("Write src/App.tsx?"), [tool("old command")])).toBe(
      "Write src/App.tsx?",
    );
  });

  it("uses the preceding tool title when the permission title is generic", () => {
    const permission = request();
    expect(
      permissionToastContext(permission, [tool('git commit -m "fix attention rail"'), permission]),
    ).toBe('git commit -m "fix attention rail"');
  });

  it("does not borrow a tool from an earlier turn", () => {
    expect(
      permissionToastContext(request(), [tool("old command"), { kind: "turn_ended", stop_reason: "end_turn" }]),
    ).toBe("Permission request");
  });

  it("normalizes, redacts likely secrets, and truncates command context", () => {
    const permission = request();
    const context = permissionToastContext(
      permission,
      [tool("deploy\n --api-key super-secret TOKEN=also-secret https://me:hunter2@example.com/very/long/path"), permission],
      72,
    );
    expect(context).not.toContain("super-secret");
    expect(context).not.toContain("also-secret");
    expect(context).not.toContain("hunter2");
    expect(context).not.toContain("\n");
    expect(Array.from(context).length).toBeLessThanOrEqual(72);
  });

  it("does not put Markdown or raw JSON in a toast", () => {
    expect(permissionToastContext(request("**Approve** `git status`"), [])).toBe(
      "Approve git status",
    );
    expect(permissionToastContext(request('{"command":"git push","env":{"TOKEN":"secret"}}'), [])).toBe(
      "Permission request",
    );
  });
});
