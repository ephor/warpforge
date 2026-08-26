/**
 * The project the demo's Files surface browses.
 *
 * `diffFor` only knows the four files this run touched, which would leave the
 * file tree showing a repository of four files. This is the rest of `atlas` —
 * enough of a real Node service that the tree, the tabs and the editor have
 * something worth looking at, including the `.warpforge/` directory the docs
 * talk about.
 *
 * Paths listed here are what `file.list` returns; `CONTENTS` supplies the text
 * for the ones a visitor is most likely to open, and anything else falls back
 * to a short placeholder rather than an empty editor.
 */
import type { FileDoc, ProjectFile } from "@app/protocol";

/** Every file in the demo project, excluding the four the run changed. */
const UNCHANGED = [
  ".warpforge/workflows/review-loop.yaml",
  ".warpforge/workspace.yaml",
  "README.md",
  "api/package.json",
  "api/src/middleware/auth.ts",
  "api/src/middleware/token-bucket.ts",
  "api/src/routes/tenants.ts",
  "api/src/routes/usage.ts",
  "api/src/server.ts",
  "api/src/tenancy.ts",
  "api/test/tenancy.test.ts",
  "docs/api/auth.md",
  "package.json",
  "web/index.html",
  "web/package.json",
  "web/src/App.tsx",
  "web/src/components/UsageChart.tsx",
  "web/src/main.tsx",
];

/**
 * The tree as `file.list` reports it: changed files marked, everything else
 * plain. Changed paths come from the live diff so the two never disagree.
 */
export function projectFiles(changed: string[]): ProjectFile[] {
  const marked = new Set(changed);
  return [...changed, ...UNCHANGED]
    .map((path) => ({ changed: marked.has(path), path }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

const TOKEN_BUCKET = `/** A refilling token bucket. One per tenant, created on first sight. */
export class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    this.tokens = limit;
  }

  take(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  retryAfterSeconds(): number {
    const perToken = this.windowMs / this.limit;
    return Math.ceil(perToken / 1000);
  }

  private refill() {
    const elapsed = Date.now() - this.lastRefill;
    if (elapsed < this.windowMs / this.limit) return;
    const earned = Math.floor(elapsed / (this.windowMs / this.limit));
    this.tokens = Math.min(this.limit, this.tokens + earned);
    this.lastRefill = Date.now();
  }
}
`;

const TENANCY = `import type { Request } from "express";

/**
 * The tenant a request belongs to. Falls back to the API key's owner when no
 * explicit header is present, and to "anonymous" for unauthenticated routes.
 */
export function tenantOf(req: Request): string {
  const header = req.get("x-tenant-id");
  if (header) return header.trim().toLowerCase();
  const key = req.get("authorization")?.replace(/^Bearer /, "");
  return key ? ownerOfKey(key) : "anonymous";
}

function ownerOfKey(key: string): string {
  return key.split(".")[0] ?? "anonymous";
}
`;

const WORKSPACE = `# Services start with the project and get ports from its own range.
services:
  api:
    command: bun run dev
    port: 3000
  web:
    command: bun run web
    port: 5173
    env:
      VITE_API_URL: http://localhost:\${api.port}
`;

const SERVER = `import { router } from "./router";
import express from "express";

const app = express();
app.use(router);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(\`api listening on :\${port}\`);
});
`;

const CONTENTS: Record<string, string> = {
  ".warpforge/workspace.yaml": WORKSPACE,
  "api/src/middleware/token-bucket.ts": TOKEN_BUCKET,
  "api/src/server.ts": SERVER,
  "api/src/tenancy.ts": TENANCY,
};

/** Text for a file the tree opens, or a short stand-in for the rest. */
export function contentsFor(path: string): string | null {
  return CONTENTS[path] ?? null;
}

/** A `file.contents` reply for a file this run did not change. */
export function unchangedDoc(path: string): FileDoc {
  const text = contentsFor(path) ?? `// ${path}\n`;
  return { newText: text, oldText: text, path, status: "modified" };
}
