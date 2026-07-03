/**
 * Demo mode: seeds the store with realistic multi-project state and a live
 * ticker, so the UI can be reviewed without a running daemon.
 *
 * Activate with `?demo` (e.g. `npm run dev` → http://localhost:5173/?demo).
 */

import { daemon } from "./daemon";
import { FileDoc, SessionUpdate, Snapshot, TaskDiff, TaskInfo } from "./protocol";

const now = Math.floor(Date.now() / 1000);

const tasks: TaskInfo[] = [
  {
    id: "t1",
    project: "lingoverse-web",
    prompt: "Migrate onboarding flow to the app router and fix hydration warnings",
    agent: "claude",
    status: "running",
    tags: ["frontend"],
    createdAt: now - 1900,
    updatedAt: now - 5,
    filesChanged: 6,
    blockedReason: null,
  },
  {
    id: "t2",
    project: "lingo-api",
    prompt: "Add rate limiting to the auth endpoints (per-IP, sliding window)",
    agent: "claude",
    status: "running",
    tags: ["security"],
    createdAt: now - 1200,
    updatedAt: now - 12,
    filesChanged: 3,
    blockedReason: null,
  },
  {
    id: "t3",
    project: "lingoverse-web",
    prompt: "Fix flaky e2e login test — waits on the wrong selector after redirect",
    agent: "codex",
    status: "needs_review",
    tags: ["tests", "bug"],
    createdAt: now - 5400,
    updatedAt: now - 600,
    filesChanged: 3,
    blockedReason: null,
  },
  {
    id: "t4",
    project: "warpforge",
    prompt: "Extract daemon actor from the TUI event loop (Stage 1)",
    agent: "claude",
    status: "running",
    tags: ["refactor"],
    createdAt: now - 800,
    updatedAt: now - 3,
    filesChanged: 11,
    blockedReason: null,
  },
  {
    id: "t5",
    project: "lingo-api",
    prompt: "Upgrade to Postgres 16 and regenerate sqlc bindings",
    agent: "claude",
    status: "blocked",
    tags: ["infra"],
    createdAt: now - 9000,
    updatedAt: now - 3000,
    filesChanged: 2,
    blockedReason: "migration conflicts with staging schema",
  },
  {
    id: "t6",
    project: "lingoverse-web",
    prompt: "Dark mode for the settings screen",
    agent: "claude",
    status: "queued",
    tags: ["frontend"],
    createdAt: now - 300,
    updatedAt: now - 300,
    filesChanged: 0,
    blockedReason: null,
  },
  {
    id: "t7",
    project: "warpforge",
    prompt: "Fix UTF-8 panic on char boundary in PTY review buffer",
    agent: "codex",
    status: "done",
    tags: ["bug"],
    createdAt: now - 86400,
    updatedAt: now - 80000,
    filesChanged: 1,
    blockedReason: null,
  },
  {
    id: "t8",
    project: "lingo-api",
    prompt: "Backfill missing webhook retries after outage",
    agent: "claude",
    status: "interrupted",
    tags: ["ops"],
    createdAt: now - 40000,
    updatedAt: now - 20000,
    filesChanged: 0,
    blockedReason: null,
  },
];

const snapshot: Snapshot = {
  projects: [
    {
      name: "lingoverse-web",
      path: "~/code/lingoverse-web",
      portRange: [4000, 4099],
      declaredServices: ["app", "db"],
      agentTemplates: { dev: "claude", codex: "codex" },
    },
    {
      name: "lingo-api",
      path: "~/code/lingo-api",
      portRange: [4100, 4199],
      declaredServices: ["api", "worker", "db"],
      agentTemplates: { dev: "claude" },
    },
    {
      name: "warpforge",
      path: "~/code/warpforge",
      portRange: [4200, 4299],
      declaredServices: [],
      agentTemplates: { dev: "claude", codex: "codex" },
    },
  ],
  services: [
    {
      project: "lingoverse-web",
      name: "app",
      command: "bun run dev",
      status: "running",
      originalPort: 3000,
      allocatedPort: 4001,
      logSeq: 812,
    },
    {
      project: "lingoverse-web",
      name: "db",
      command: "docker compose up postgres",
      status: "running",
      originalPort: 5432,
      allocatedPort: 4002,
      logSeq: 118,
    },
    {
      project: "lingo-api",
      name: "api",
      command: "bun run dev",
      status: "starting",
      originalPort: 3000,
      allocatedPort: 4101,
      logSeq: 12,
    },
    {
      project: "lingo-api",
      name: "worker",
      command: "bun run worker",
      status: "failed",
      originalPort: 0,
      allocatedPort: 0,
      logSeq: 44,
    },
    {
      project: "lingo-api",
      name: "db",
      command: "docker compose up postgres",
      status: "running",
      originalPort: 5432,
      allocatedPort: 4102,
      logSeq: 90,
    },
  ],
  portforwards: [
    {
      project: "lingo-api",
      name: "staging-db",
      namespace: "postgres",
      pod: "postgres-cluster-pooler",
      localPort: 5433,
      remotePort: 5432,
      status: "active",
    },
  ],
  tasks,
  terminals: [],
};

const sessionUpdates: Record<string, SessionUpdate[]> = {
  t1: [
    {
      kind: "available_commands",
      commands: [
        { name: "test", description: "Run the test suite" },
        { name: "commit", description: "Commit staged changes" },
        { name: "review", description: "Summarize the diff for review" },
        { name: "compact", description: "Compact the conversation" },
      ],
    },
    {
      kind: "agent_text",
      text: "Here's the plan. I'll move `pages/onboarding/*` under the **app router** and fix the hydration warning that comes from calling `Date.now()` during render.",
    },
    {
      kind: "plan",
      entries: [
        { content: "Move onboarding pages under app/onboarding", status: "completed" },
        { content: "Fix Date.now() hydration warning", status: "in_progress" },
        { content: "Update unit tests", status: "pending" },
      ],
    },
    { kind: "tool_call", tool_call_id: "c1", title: "Read src/pages/onboarding/index.tsx", status: "completed", tool_kind: "read" },
    { kind: "file_edit", path: "src/app/onboarding/page.tsx" },
    { kind: "file_edit", path: "src/app/onboarding/layout.tsx" },
    {
      kind: "tool_call",
      tool_call_id: "c2",
      title: "Run `bun run typecheck`",
      status: "completed",
      tool_kind: "execute",
      content: "$ bun run typecheck\n✓ no type errors (1,204 files) in 3.1s",
    },
    { kind: "agent_text", text: "Typecheck is green. Moving the header's `Date.now()` into a client component now." },
  ],
  t2: [
    { kind: "agent_thought", text: "Sliding window fits better than token bucket here — auth bursts are legitimate." },
    { kind: "tool_call", tool_call_id: "c3", title: "Edit src/middleware/ratelimit.ts", status: "completed", tool_kind: "edit" },
    { kind: "file_edit", path: "src/middleware/ratelimit.ts" },
    { kind: "permission_request", request_id: "p1", title: "Run `bun test src/middleware`?", options: ["allow", "allow_always", "deny"] },
  ],
  t3: [
    { kind: "tool_call", tool_call_id: "c4", title: "Run `bun run e2e --filter login` (3× green)", status: "completed", tool_kind: "execute" },
    { kind: "file_edit", path: "e2e/login.spec.ts" },
    { kind: "file_edit", path: "e2e/helpers/session.ts" },
    { kind: "turn_ended", stop_reason: "end_turn" },
  ],
  t4: [
    { kind: "agent_text", text: "Moving agent status transitions out of `app.rs` into `AgentManager`." },
    { kind: "tool_call", tool_call_id: "c5", title: "Edit src/daemon/actor.rs", status: "in_progress", tool_kind: "edit" },
  ],
  t5: [
    { kind: "tool_call", tool_call_id: "c6", title: "Run `atlas migrate diff`", status: "failed", tool_kind: "execute", content: "error: migration 0042 conflicts with existing index idx_users_email on staging" },
    { kind: "agent_text", text: "Migration 0042 conflicts with a manual index on staging. Need a decision: drop and recreate, or rename." },
  ],
};

/** Same demo diff for any reviewed task — shaped like `diff.get`'s answer. */
function diffFor(taskId: string): TaskDiff {
  return {
    taskId,
    files: [
      {
        path: "e2e/login.spec.ts",
        oldPath: null,
        status: "modified",
        hunks: [
          {
            oldStart: 24,
            oldLines: 7,
            newStart: 24,
            newLines: 8,
            lines: [
              "   await page.fill('#email', user.email);",
              "   await page.fill('#password', user.password);",
              "   await page.click('button[type=submit]');",
              "-  await page.waitForSelector('.dashboard');",
              "+  // Redirect lands on /home first; .dashboard mounts after data loads.",
              "+  await page.waitForURL('**/home');",
              "+  await page.waitForSelector('[data-testid=dashboard-root]');",
              "   await expect(page).toHaveTitle(/Lingoverse/);",
            ],
            resolution: null,
          },
          {
            oldStart: 61,
            oldLines: 5,
            newStart: 62,
            newLines: 4,
            lines: [
              "   test('remembers session', async ({ page }) => {",
              "-    await page.waitForTimeout(2000); // flaky sleep",
              "-    await page.reload();",
              "+    await page.reload({ waitUntil: 'networkidle' });",
              "     await expect(page.locator('[data-testid=avatar]')).toBeVisible();",
            ],
            resolution: null,
          },
        ],
      },
      {
        path: "e2e/helpers/session.ts",
        oldPath: null,
        status: "modified",
        hunks: [
          {
            oldStart: 10,
            oldLines: 3,
            newStart: 10,
            newLines: 6,
            lines: [
              " export async function loginAs(page: Page, user: TestUser) {",
              "   await page.goto('/login');",
              "+  // Wait for the auth service to be reachable before typing.",
              "+  await page.waitForResponse((r) => r.url().includes('/api/health'));",
              "+",
              "   await fillCredentials(page, user);",
            ],
            resolution: null,
          },
        ],
      },
      {
        path: "e2e/fixtures/flaky-retry.json",
        oldPath: null,
        status: "deleted",
        hunks: [
          {
            oldStart: 1,
            oldLines: 3,
            newStart: 0,
            newLines: 0,
            lines: ["-{", '-  "retries": 4', "-}"],
            resolution: null,
          },
        ],
      },
      {
        path: "internal/auth/session.go",
        oldPath: null,
        status: "modified",
        hunks: [
          {
            oldStart: 12,
            oldLines: 4,
            newStart: 12,
            newLines: 6,
            lines: [
              " func NewSession(userID string) *Session {",
              "-\treturn &Session{ID: userID, TTL: 3600}",
              "+\t// Sliding window: refresh TTL on each use.",
              "+\treturn &Session{ID: userID, TTL: 3600, LastSeen: time.Now()}",
              " }",
            ],
            resolution: null,
          },
        ],
      },
    ],
  };
}

/** Live ticker: keeps the wall visibly alive and stages a permission ask. */
function startTicker() {
  const t1Feed: SessionUpdate[] = [
    { kind: "file_edit", path: "src/app/onboarding/steps/profile.tsx" },
    { kind: "agent_text", text: "Hydration warning came from `Date.now()` in the header — moved it to a client component." },
    { kind: "tool_call", tool_call_id: "c7", title: "Run `bun run test:unit onboarding`", status: "in_progress", tool_kind: "execute" },
    { kind: "tool_call", tool_call_id: "c7", title: "Run `bun run test:unit onboarding`", status: "completed", tool_kind: "execute", content: "PASS  onboarding.test.tsx (12 tests)" },
  ];
  const t4Feed: SessionUpdate[] = [
    { kind: "file_edit", path: "src/daemon/actor.rs" },
    { kind: "tool_call", tool_call_id: "c8", title: "Run `cargo check`", status: "in_progress", tool_kind: "execute" },
    { kind: "tool_call", tool_call_id: "c8", title: "Run `cargo check`", status: "completed", tool_kind: "execute" },
    { kind: "agent_text", text: "`PfEvent` now carries the project key — dashboard no longer drops watcher events." },
  ];
  let i = 0;
  setInterval(() => {
    const feed = i % 2 === 0 ? t1Feed : t4Feed;
    const update = feed[Math.floor(i / 2) % feed.length];
    daemon.demoEvent({
      event: "session.update",
      data: { task_id: i % 2 === 0 ? "t1" : "t4", update },
    });
    i++;
    // After a while, t4 asks for permission — watch the attention rail.
    if (i === 9) {
      daemon.demoEvent({
        event: "session.update",
        data: {
          task_id: "t4",
          update: {
            kind: "permission_request",
            request_id: "p2",
            title: "Run `cargo test --workspace`?",
            options: ["allow", "deny"],
          },
        },
      });
    }
  }, 2500);
}

/** Mock old/new file contents for the split (CodeMirror merge) review. */
function fileDocFor(path: string): FileDoc {
  if (path === "e2e/login.spec.ts") {
    return {
      path,
      status: "modified",
      oldText: `import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/session';

test.describe('login', () => {
  test('signs in and lands on dashboard', async ({ page }) => {
    await loginAs(page, testUser);
    await page.fill('#email', user.email);
    await page.fill('#password', user.password);
    await page.click('button[type=submit]');
    await page.waitForSelector('.dashboard');
    await expect(page).toHaveTitle(/Lingoverse/);
  });

  test('remembers session', async ({ page }) => {
    await page.waitForTimeout(2000); // flaky sleep
    await page.reload();
    await expect(page.locator('[data-testid=avatar]')).toBeVisible();
  });
});
`,
      newText: `import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/session';

test.describe('login', () => {
  test('signs in and lands on dashboard', async ({ page }) => {
    await loginAs(page, testUser);
    await page.fill('#email', user.email);
    await page.fill('#password', user.password);
    await page.click('button[type=submit]');
    // Redirect lands on /home first; .dashboard mounts after data loads.
    await page.waitForURL('**/home');
    await page.waitForSelector('[data-testid=dashboard-root]');
    await expect(page).toHaveTitle(/Lingoverse/);
  });

  test('remembers session', async ({ page }) => {
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('[data-testid=avatar]')).toBeVisible();
  });
});
`,
    };
  }
  if (path === "e2e/helpers/session.ts") {
    return {
      path,
      status: "modified",
      oldText: `export async function loginAs(page: Page, user: TestUser) {
  await page.goto('/login');
  await fillCredentials(page, user);
}
`,
      newText: `export async function loginAs(page: Page, user: TestUser) {
  await page.goto('/login');
  // Wait for the auth service to be reachable before typing.
  await page.waitForResponse((r) => r.url().includes('/api/health'));

  await fillCredentials(page, user);
}
`,
    };
  }
  if (path === "e2e/fixtures/flaky-retry.json") {
    return { path, status: "deleted", oldText: `{\n  "retries": 4\n}\n`, newText: "" };
  }
  if (path === "internal/auth/session.go") {
    return {
      path,
      status: "modified",
      oldText: `package auth

import "time"

type Session struct {
	ID  string
	TTL int
}

func NewSession(userID string) *Session {
	return &Session{ID: userID, TTL: 3600}
}
`,
      newText: `package auth

import "time"

type Session struct {
	ID       string
	TTL      int
	LastSeen time.Time
}

func NewSession(userID string) *Session {
	// Sliding window: refresh TTL on each use.
	return &Session{ID: userID, TTL: 3600, LastSeen: time.Now()}
}
`,
    };
  }
  return { path, status: "modified", oldText: "", newText: "" };
}

export function startDemo() {
  daemon.enableDemoMode({ snapshot, sessionUpdates, diffFor, fileDocFor });
  startTicker();
}
