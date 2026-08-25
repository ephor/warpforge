/**
 * The world the landing-page demo runs in.
 *
 * These are the daemon's own wire types, fed to `daemon.enableDemoMode` — the
 * same seam the app's tests use. Nothing here is a lookalike: the components
 * on the page are the app's, and this is the state they read.
 *
 * The scenario is one orchestrator task ("Add per-tenant rate limiting") that
 * farms two sub-agents out over MCP, so the demo can show the pipeline tab,
 * the agent switcher and a multi-file diff without inventing any of them.
 */
import { daemon } from "@app/daemon";
import type {
  AgentConfig,
  FileDoc,
  ProjectInfo,
  ServiceInfo,
  Snapshot,
  TaskDiff,
  TaskInfo,
} from "@app/protocol";

export const LEAD_TASK_ID = "tsk_rate_limit";
const API_TASK_ID = "tsk_rate_limit_api";
const TEST_TASK_ID = "tsk_rate_limit_tests";
const PROJECT = "atlas";

/** Fixed so the markup a visitor gets is the markup the build produced. */
const T0 = Date.UTC(2026, 0, 14, 9, 12, 0);

const project: ProjectInfo = {
  agentTemplates: {},
  declaredServices: ["api", "web"],
  name: PROJECT,
  path: "/Users/dev/code/atlas",
  portRange: [4200, 4299],
};

const agents: AgentConfig[] = [
  { acpCommand: "claude", displayName: "Claude", enabled: true, id: "claude", models: [] },
  { acpCommand: "codex", displayName: "Codex", enabled: true, id: "codex", models: [] },
];

const services: ServiceInfo[] = [
  {
    allocatedPort: 4200,
    command: "bun run dev",
    logSeq: 42,
    name: "api",
    originalPort: 3000,
    project: PROJECT,
    status: "running",
  },
  {
    allocatedPort: 4201,
    command: "bun run web",
    logSeq: 17,
    name: "web",
    originalPort: 5173,
    project: PROJECT,
    status: "running",
  },
];

function task(over: Partial<TaskInfo> & Pick<TaskInfo, "id" | "prompt" | "title">): TaskInfo {
  return {
    agent: "claude",
    blockedReason: null,
    createdAt: T0,
    filesChanged: 0,
    project: PROJECT,
    status: "queued",
    tags: [],
    updatedAt: T0,
    worktree: `/Users/dev/code/atlas/.warpforge/worktrees/${over.id}`,
    ...over,
  };
}

/** The orchestrator. Starts queued; the script walks it to `done`. */
export const leadTask = task({
  id: LEAD_TASK_ID,
  prompt: "Add per-tenant rate limiting to the public API, with tests and docs.",
  title: "Add per-tenant rate limiting",
});

/** Sub-agents, spawned mid-run. They are ordinary tasks with a parent id. */
export const apiTask = task({
  id: API_TASK_ID,
  parentTaskId: LEAD_TASK_ID,
  prompt: "Implement the token-bucket middleware and wire it into the router.",
  status: "running",
  title: "Token-bucket middleware",
});

export const testTask = task({
  agent: "codex",
  id: TEST_TASK_ID,
  parentTaskId: LEAD_TASK_ID,
  prompt: "Cover the limiter: burst, refill, and the per-tenant key.",
  status: "running",
  title: "Limiter test suite",
});

export const snapshot: Snapshot = {
  agents,
  portforwards: [],
  projects: [project],
  services,
  sessionHistory: {},
  tasks: [leadTask],
  terminals: [],
};

const RATE_LIMIT_TS = `import type { NextFunction, Request, Response } from "express";

import { TokenBucket } from "./token-bucket";
import { tenantOf } from "../tenancy";

const buckets = new Map<string, TokenBucket>();

/** Per-tenant token bucket. Tenants never share a budget. */
export function rateLimit(limit: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = tenantOf(req);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(limit, windowMs);
      buckets.set(key, bucket);
    }
    if (!bucket.take()) {
      res.setHeader("Retry-After", bucket.retryAfterSeconds());
      return res.status(429).json({ error: "rate_limited" });
    }
    next();
  };
}
`;

export const diff: TaskDiff = {
  branch: "feat/per-tenant-rate-limit",
  files: [
    {
      hunks: [
        {
          lines: RATE_LIMIT_TS.trimEnd()
            .split("\n")
            .map((line) => `+${line}`),
          newLines: 24,
          newStart: 1,
          oldLines: 0,
          oldStart: 0,
          resolution: null,
        },
      ],
      oldPath: null,
      path: "api/src/middleware/rate-limit.ts",
      status: "added",
    },
    {
      hunks: [
        {
          lines: [
            ' import { json } from "express";',
            '+import { rateLimit } from "./middleware/rate-limit";',
            " ",
            " export const router = Router();",
            "+router.use(rateLimit(120, 60_000));",
            " router.use(json());",
          ],
          newLines: 6,
          newStart: 8,
          oldLines: 4,
          oldStart: 8,
          resolution: null,
        },
      ],
      oldPath: null,
      path: "api/src/router.ts",
      status: "modified",
    },
    {
      hunks: [
        {
          lines: [
            '+test("refills after the window", async () => {',
            "+  const bucket = new TokenBucket(2, 50);",
            "+  expect(bucket.take()).toBe(true);",
            "+  expect(bucket.take()).toBe(true);",
            "+  expect(bucket.take()).toBe(false);",
            "+  await sleep(60);",
            "+  expect(bucket.take()).toBe(true);",
            "+});",
          ],
          newLines: 8,
          newStart: 1,
          oldLines: 0,
          oldStart: 0,
          resolution: null,
        },
      ],
      oldPath: null,
      path: "api/test/rate-limit.test.ts",
      status: "added",
    },
    {
      hunks: [
        {
          lines: [
            " ## Limits",
            " ",
            "-The public API is unmetered.",
            "+Each tenant gets 120 requests per minute. Exceeding it returns",
            "+`429` with a `Retry-After` header.",
          ],
          newLines: 5,
          newStart: 61,
          oldLines: 3,
          oldStart: 61,
          resolution: null,
        },
      ],
      oldPath: null,
      path: "docs/api/limits.md",
      status: "modified",
    },
  ],
  taskId: LEAD_TASK_ID,
};

const DOCS: Record<string, string> = {
  "api/src/middleware/rate-limit.ts": RATE_LIMIT_TS,
};

export function fileDocFor(path: string): FileDoc {
  return {
    newText: DOCS[path] ?? `// ${path}\n`,
    oldText: "",
    path,
    status: "added",
  };
}

/**
 * The diff as it stands *right now* — only the files the transcript has
 * already reported editing.
 *
 * The app invalidates the diff query on every `file_edit` it sees, so reading
 * the session history back here makes the diff and the changes rail fill up in
 * step with the conversation, with no extra events to keep in sync. It also
 * empties itself on replay, because seeding the demo clears that history.
 */
export function diffFor(): TaskDiff {
  const edited = new Set(
    (daemon.getState().sessionUpdates[LEAD_TASK_ID] ?? [])
      .filter((update) => update.kind === "file_edit")
      .map((update) => update.path),
  );
  return { ...diff, files: diff.files.filter((file) => edited.has(file.path)) };
}
