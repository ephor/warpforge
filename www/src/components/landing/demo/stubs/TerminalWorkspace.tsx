import { Plus, RefreshCw, X } from "lucide-react";

/**
 * A still life of the app's terminal, for the marketing demo.
 *
 * The real workspace drives xterm against a live PTY — a quarter-megabyte of
 * terminal emulator, CommonJS (so it will not prerender), and nothing for it
 * to talk to on a static page. This keeps the chrome the real one renders —
 * the tab strip, its per-tab restart and close, the new-terminal button — and
 * fills the pane with fixed output instead of a session.
 *
 * Aliased in place of `components/runtime/TerminalWorkspace` by
 * `astro.config.ts`; everything else the demo shows is the app's own code.
 */

type Line = { text: string; tone?: "ok" | "warn" | "muted" | "accent" };

const SESSION: Line[] = [
  { text: "$ bun run dev", tone: "accent" },
  { text: "$ warpforge · atlas · api", tone: "muted" },
  { text: "" },
  { text: "  ready  api listening on :4200", tone: "ok" },
  { text: "  ready  web listening on :4201", tone: "ok" },
  { text: "  note   ports allocated from this project's range (4200–4299)", tone: "muted" },
  { text: "" },
  { text: "$ bun test api/test/rate-limit.test.ts", tone: "accent" },
  { text: "" },
  { text: "  ✓ allows a burst up to the limit          12ms" },
  { text: "  ✓ rejects the request past the limit       3ms" },
  { text: "  ✓ refills after the window                63ms" },
  { text: "  ✓ keeps tenants on separate budgets        4ms" },
  { text: "" },
  { text: " 4 pass  0 fail  ran 4 tests across 1 file", tone: "ok" },
  { text: "" },
  { text: "$ curl -si localhost:4200/v1/usage | head -3", tone: "accent" },
  { text: "  HTTP/1.1 429 Too Many Requests", tone: "warn" },
  { text: "  retry-after: 1", tone: "warn" },
  { text: "" },
];

const TONE: Record<NonNullable<Line["tone"]>, string> = {
  accent: "text-primary",
  muted: "text-muted-foreground/70",
  ok: "text-ok",
  warn: "text-warn",
};

function Tab({ label, active }: { label: string; active?: boolean }) {
  return (
    <div
      className={
        active
          ? "flex h-6 shrink-0 items-center gap-1 rounded-sm bg-secondary px-1.5 text-[11px] text-foreground"
          : "flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-[11px] text-muted-foreground"
      }
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {active && <RefreshCw className="size-3 shrink-0 text-muted-foreground/60" />}
      <X className="size-3 shrink-0 text-muted-foreground/60" />
    </div>
  );
}

export function TerminalWorkspaceView() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border/60 bg-background/25 px-1.5">
        <Tab label="atlas" active />
        <Tab label="api — dev" />
        <div className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground">
          <Plus className="size-3.5" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden bg-background/40 px-3 py-2 font-mono text-[11px] leading-relaxed">
        {SESSION.map((line, index) => (
          // A fixed transcript: index is the identity, and it never reorders.
          // eslint-disable-next-line react/no-array-index-key
          <div key={index} className={line.tone ? TONE[line.tone] : "text-foreground/85"}>
            {line.text || " "}
          </div>
        ))}
        <div className="flex items-center text-foreground/85">
          <span className="text-primary">$&nbsp;</span>
          <span className="inline-block h-[1.1em] w-[0.5em] animate-pulse bg-primary/80" />
        </div>
      </div>
    </div>
  );
}

export default TerminalWorkspaceView;
