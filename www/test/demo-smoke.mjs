/**
 * Guards the landing page's demo against silent rot.
 *
 * The demo runs on the app's demo mode, which was built for local UI review
 * and is generous about what it doesn't know: `demoRequest` answers an
 * unrecognised RPC with `{}`. That keeps it from throwing, and it is also how
 * this could quietly stop working — a refactor teaches `TaskDetail` a new
 * call, the site still builds, and the front page ships an empty pane.
 *
 * A build alone cannot catch that. So this loads the built page like a visitor
 * and insists the run actually happened: the conversation arrives, the agent
 * delegates, the diff fills to every file the fixture changes, and the console
 * stays clean throughout.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

import { chromium } from "playwright";

const DIST = resolve(import.meta.dirname, "../dist");
const PAGE = "/embed/app-demo/";
/** Long enough for the fixture's run to finish; it is ~17s of scripted beats. */
const RUN_MS = 22_000;

const TYPES = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const server = createServer(async (req, res) => {
  const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const file = path.endsWith("/") ? join(DIST, path, "index.html") : join(DIST, path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

await new Promise((ok) => server.listen(0, ok));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const noise = [];
page.on("console", (m) => m.type() === "error" && noise.push(m.text()));
page.on("pageerror", (e) => noise.push(`uncaught: ${e}`));

await page.goto(origin + PAGE, { waitUntil: "networkidle" });

const failures = [];
const must = async (what, check) => {
  try {
    await check();
  } catch (error) {
    failures.push(`${what}: ${error.message.split("\n")[0]}`);
  }
};

// The shell mounted at all — everything below is meaningless otherwise.
await must("the task detail renders", () =>
  page.getByText("Conversation").first().waitFor({ timeout: 15_000 }),
);

// The run reaches the end: the lead delegates, and the diff fills up. The
// file count is the load-bearing one — it only moves if `diff.get` is still
// being served and the app is still invalidating it on every file edit.
await must("the lead delegates to a sub-agent", () =>
  page.getByText(/Delegating/).first().waitFor({ timeout: RUN_MS }),
);
await must("the diff fills to 4 files", () =>
  page.getByText("4 files").first().waitFor({ timeout: RUN_MS }),
);
// The rail is counting against the same four files. Not `4/4`: the app only
// auto-stages while nothing is staged yet, so files that appear later in a run
// stay unchecked — real behaviour, and the demo inherits it.
await must("the changes rail counts them", () =>
  page.getByText(/\/4 files/).first().waitFor({ timeout: RUN_MS }),
);

await browser.close();
server.close();

if (noise.length > 0) failures.push(`console errors: ${noise.slice(0, 5).join(" | ")}`);

if (failures.length > 0) {
  console.error("Landing demo is broken:\n  - " + failures.join("\n  - "));
  process.exit(1);
}
console.log("Landing demo smoke: the run plays through, console clean.");
