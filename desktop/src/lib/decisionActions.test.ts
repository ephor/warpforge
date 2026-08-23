import { describe, expect, it } from "vitest";

import type { AttentionItem } from "./attentionRail";
import { decisionActionKinds, permissionApproveOption } from "./decisionActions";
import type { PermissionUpdate } from "./sessionPermissions";
import type { TaskInfo, WorkflowWaitKind } from "../protocol";

function task(overrides: Partial<TaskInfo>): TaskInfo {
  return {
    agent: "claude",
    blockedReason: null,
    createdAt: 1,
    filesChanged: 0,
    id: "task-1",
    project: "warpforge",
    prompt: "Do the work",
    status: "running",
    tags: [],
    title: "Do the work",
    updatedAt: 10,
    workflowRun: null,
    ...overrides,
  };
}

function perm(options: string[]): PermissionUpdate {
  return { kind: "permission_request", options, request_id: "req-1", title: "Allow?" };
}

function item(overrides: Partial<AttentionItem>): AttentionItem {
  return { priority: 0, reason: "reason", task: task({}), ...overrides };
}

describe("decisionActionKinds", () => {
  it("derives permission from a pending prompt regardless of task state", () => {
    expect(decisionActionKinds(item({ permission: perm(["allow"]) }))).toEqual(["permission"]);
  });

  it("derives question and limit from the workflow waiting kind", () => {
    const run = (kind: WorkflowWaitKind) => ({
      maxRounds: 2,
      round: 1,
      stage: "review" as const,
      waiting: { kind },
      workflowId: "wf",
      workflowName: "Wf",
    });
    expect(
      decisionActionKinds(item({ task: task({ status: "waiting", workflowRun: run("question") }) })),
    ).toEqual(["question"]);
    expect(
      decisionActionKinds(item({ task: task({ status: "waiting", workflowRun: run("limit") }) })),
    ).toEqual(["limit"]);
  });

  it("gates question/limit behind permission when both are present", () => {
    const itemWithBoth = item({
      permission: perm(["allow"]),
      task: task({
        status: "waiting",
        workflowRun: {
          maxRounds: 2,
          round: 1,
          stage: "review",
          waiting: { kind: "question" },
          workflowId: "wf",
          workflowName: "Wf",
        },
      }),
    });
    expect(decisionActionKinds(itemWithBoth)).toEqual(["permission"]);
  });

  it.each([
    ["paused", task({ status: "waiting", workflowRun: pausedRun() })],
    ["blocked", task({ status: "blocked" })],
    ["interrupted", task({ status: "interrupted" })],
    ["running", task({})],
  ])("gives %s rows no inline actions", (_label, row) => {
    expect(decisionActionKinds(item({ task: row }))).toEqual([]);
  });
});

function pausedRun() {
  return {
    maxRounds: 2,
    round: 1,
    stage: "implement" as const,
    waiting: { kind: "paused" as const },
    workflowId: "wf",
    workflowName: "Wf",
  };
}

describe("permissionApproveOption", () => {
  it.each([
    [["allow_once", "deny"], "allow_once"],
    [["allow", "deny"], "allow"],
    [["deny"], undefined],
    [["always_allow", "deny"], "always_allow"],
  ])("resolves %j to %j", (options, expected) => {
    expect(permissionApproveOption(options)).toBe(expected);
  });
});
