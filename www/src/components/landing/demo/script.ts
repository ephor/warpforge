/**
 * The run, as a list of daemon events with the delay before each.
 *
 * Every entry is a real `DaemonEvent`: the demo pushes them through
 * `daemon.demoEvent`, which runs the app's own reducer. So the transcript
 * folds tool calls, stamps their durations and coalesces text exactly as it
 * does against a live daemon — the animation is the app updating, not a
 * timeline of CSS classes.
 */
import type { DaemonEvent, SessionUpdate } from "@app/protocol";

import { apiTask, diff, LEAD_TASK_ID, leadTask, testTask } from "./fixtures";

interface Beat {
  /** Milliseconds to wait before dispatching this event. */
  after: number;
  event: DaemonEvent;
}

const say = (taskId: string, update: SessionUpdate): DaemonEvent => ({
  data: { task_id: taskId, update },
  event: "session.update",
});

const tool = (
  taskId: string,
  id: string,
  title: string,
  kind: string,
  status: "pending" | "in_progress" | "completed",
): DaemonEvent =>
  say(taskId, { kind: "tool_call", status, title, tool_call_id: id, tool_kind: kind });

export const script: Beat[] = [
  {
    after: 600,
    event: say(LEAD_TASK_ID, {
      kind: "user_message",
      text: "Add per-tenant rate limiting to the public API, with tests and docs.",
    }),
  },
  {
    after: 700,
    event: { data: { ...leadTask, status: "running" }, event: "task.updated" },
  },
  {
    after: 500,
    event: say(LEAD_TASK_ID, {
      kind: "agent_thought",
      text: "Two independent pieces: the middleware itself and the coverage for it. I'll take the middleware and hand the test suite to a second agent so they land together.",
    }),
  },
  { after: 900, event: tool(LEAD_TASK_ID, "t1", "Search “rate limit”", "search", "in_progress") },
  { after: 800, event: tool(LEAD_TASK_ID, "t1", "Search “rate limit”", "search", "completed") },
  {
    after: 300,
    event: say(LEAD_TASK_ID, {
      kind: "plan",
      entries: [
        { content: "Token-bucket middleware, keyed per tenant", priority: "high", status: "in_progress" },
        { content: "Wire it into the public router", priority: "medium", status: "pending" },
        { content: "Cover burst, refill and tenant isolation", priority: "medium", status: "pending" },
        { content: "Document the limit and the 429 contract", priority: "low", status: "pending" },
      ],
    }),
  },

  // The orchestrator delegates. Two child tasks appear in the sidebar, the
  // agent switcher and the pipeline tab — all from these two events.
  { after: 900, event: { data: apiTask, event: "task.created" } },
  { after: 400, event: { data: testTask, event: "task.created" } },
  {
    after: 400,
    event: say(LEAD_TASK_ID, {
      kind: "agent_text",
      text: "Delegating: **Claude** takes the middleware, **Codex** writes the suite. I'll review both before anything is staged.",
    }),
  },
  // Sub-agent conversations — so switching to them isn't empty
  { after: 400, event: say(apiTask.id, { kind: "agent_text", text: "On it — implementing token-bucket middleware and wiring it into the router." }) },
  { after: 300, event: tool(apiTask.id, "t-api-1", "Write rate-limit.ts", "edit", "in_progress") },
  { after: 600, event: tool(apiTask.id, "t-api-1", "Write rate-limit.ts", "edit", "completed") },
  { after: 200, event: say(apiTask.id, { kind: "agent_text", text: "Middleware done. Router updated with `rateLimit(120, 60_000)`." }) },
  { after: 400, event: say(testTask.id, { kind: "agent_text", text: "Covering burst, refill and tenant isolation." }) },
  { after: 300, event: tool(testTask.id, "t-test-1", "Write rate-limit.test.ts", "edit", "in_progress") },
  { after: 700, event: tool(testTask.id, "t-test-1", "Write rate-limit.test.ts", "edit", "completed") },
  { after: 200, event: say(testTask.id, { kind: "agent_text", text: "Tests added — refill after window covered." }) },

  {
    after: 900,
    event: tool(LEAD_TASK_ID, "t2", "Write api/src/middleware/rate-limit.ts", "edit", "in_progress"),
  },
  {
    after: 1100,
    event: tool(LEAD_TASK_ID, "t2", "Write api/src/middleware/rate-limit.ts", "edit", "completed"),
  },
  {
    after: 200,
    event: say(LEAD_TASK_ID, {
      kind: "file_edit",
      additions: 24,
      deletions: 0,
      path: "api/src/middleware/rate-limit.ts",
      tool_call_id: "t2",
    }),
  },
  {
    after: 600,
    event: say(LEAD_TASK_ID, {
      kind: "file_edit",
      additions: 2,
      deletions: 0,
      path: "api/src/router.ts",
      tool_call_id: "t3",
    }),
  },

  // A permission gate: the run pauses on the visitor's screen the way it does
  // on yours, then resolves.
  {
    after: 800,
    event: say(LEAD_TASK_ID, {
      kind: "permission_request",
      options: ["Allow once", "Always allow", "Reject"],
      request_id: "p1",
      title: "Run `bun test api/test/rate-limit.test.ts`",
    }),
  },
  {
    after: 1600,
    event: say(LEAD_TASK_ID, {
      kind: "permission_resolved",
      outcome: "Always allow",
      request_id: "p1",
    }),
  },
  { after: 400, event: tool(LEAD_TASK_ID, "t4", "bun test", "execute", "in_progress") },
  { after: 1400, event: tool(LEAD_TASK_ID, "t4", "bun test", "execute", "completed") },

  {
    after: 400,
    event: say(LEAD_TASK_ID, {
      kind: "file_edit",
      additions: 8,
      deletions: 0,
      path: "api/test/rate-limit.test.ts",
      tool_call_id: "t5",
    }),
  },
  {
    after: 400,
    event: say(LEAD_TASK_ID, {
      kind: "file_edit",
      additions: 2,
      deletions: 1,
      path: "docs/api/limits.md",
      tool_call_id: "t6",
    }),
  },

  // Children settle, then the lead yields its turn with a diff to review.
  { after: 500, event: { data: { ...apiTask, filesChanged: 2, status: "done" }, event: "task.updated" } },
  { after: 300, event: { data: { ...testTask, filesChanged: 1, status: "done" }, event: "task.updated" } },
  {
    after: 500,
    event: say(LEAD_TASK_ID, {
      kind: "agent_text",
      text: "Done. `120 req/min` per tenant, `429` with `Retry-After` when the bucket is empty. Four files changed — the diff is on the right.",
    }),
  },
  {
    after: 300,
    event: {
      data: { ...leadTask, filesChanged: diff.files.length, status: "waiting" },
      event: "task.updated",
    },
  },
  { after: 200, event: say(LEAD_TASK_ID, { kind: "turn_ended", stop_reason: "end_turn" }) },
];

/** How long one pass of the script takes, end to end. */
export const scriptDuration = script.reduce((total, beat) => total + beat.after, 0);
